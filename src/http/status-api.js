import { readFileSync } from 'node:fs';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { AuditClient } from '@atc-web/atc-service-core/audit';
import { createErrorHandler, registerInfo, registerOpenApi, registerProbes, registerRequestContext, requestOptions } from '@atc-web/atc-service-core/fastify';
import { Idempotency } from '@atc-web/atc-service-core/idempotency';
import { StatusError } from '../domain/errors.js';
import { ApiKeyAuth } from './api-key-auth.js';
import { Schemas } from './schemas.js';
import { StatusPage } from './status-page.js';
import { Views } from './views.js';
import { AuditMetrics } from '../audit-metrics.js';

/** @typedef {import('../config.js').Config} Config */
/** @typedef {import('fastify').FastifyInstance} FastifyInstance */
/** @typedef {import('fastify').FastifyRequest} FastifyRequest */
/** @typedef {import('fastify').FastifyReply} FastifyReply */

/**
 * HTTP surface. `/v1/*`: `read` sees monitors, checks, incidents and stats; `admin` changes
 * monitors. `/status` and `/status/summary.json` are public (no key) and show public monitors only,
 * without URLs or error texts.
 */
export class StatusApi {
  static READY_CACHE_MS = 10_000;

  /**
   * @param {object} deps
   * @param {Config} deps.config
   * @param {import('../domain/status-service.js').StatusService} deps.service
   * @param {import('../domain/alert-service.js').AlertService} deps.alerts
   * @param {import('../db.js').Database} deps.db
   * @param {string} deps.version
   * @param {import('../types.js').Logger} [deps.logger]
   * @param {import('@atc-web/atc-service-core/audit').AuditClient} [deps.audit]
   * @param {import('../events/event-publisher.js').EventPublisher} [deps.publisher]
   * @param {import('../net/outbound-heartbeat.js').OutboundHeartbeat} [deps.heartbeat]
   */
  constructor({ config, audit, publisher, heartbeat, service, alerts, db, version, logger }) {
    this.alerts = alerts;
    this.config = config;
    this.audit = audit;
    this.publisher = publisher ?? null;
    this.heartbeat = heartbeat ?? null;
    this.service = service;
    this.db = db;
    this.version = version;
    this.logger = logger;
    this.auth = new ApiKeyAuth(config.apiKeys);
  }

  /** @returns {Promise<FastifyInstance>} */
  async build() {
    const { config } = this;
    const app = Fastify({
      ...(config.tls ? { https: { cert: readFileSync(config.tls.certPath), key: readFileSync(config.tls.keyPath), minVersion: 'TLSv1.2' } } : {}),
      ...requestOptions({ logger: this.logger, logLevel: config.logLevel }),
      trustProxy: config.trustProxy,
      bodyLimit: config.bodyLimit,
      ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
    });
    registerRequestContext(app, { trustProxy: config.trustProxy });
    app.decorateRequest('apiKey', /** @type {any} */ (null));
    app.setErrorHandler(createErrorHandler(StatusError));
    app.addHook('onSend', AuditClient.hook(this.audit));
    app.setNotFoundHandler((_request, reply) => {
      reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'route not found' } });
    });
    app.addHook('onSend', async (_request, reply) => {
      reply.header('x-content-type-options', 'nosniff');
      if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    });
    // Opt-in per route (config.idempotent): repeats with the same Idempotency-Key replay the first 2xx answer.
    Idempotency.register(app, { raw: this.db.raw });
    registerProbes(app, () => this.db.ping(), {
      cacheMs: StatusApi.READY_CACHE_MS,
      extra: () => ({ monitors: this.service.store.count(), checker: this.service.stopping.signal.aborted ? 'stopped' : 'running', notify: config.notify ? 'enabled' : 'disabled', alertHook: config.alertHookSecret ? 'enabled' : 'disabled' }),
    });
    registerOpenApi(app, new URL('../../openapi.yaml', import.meta.url));
    registerInfo(app, { service: 'atc-status', version: this.version, capabilities: ['http-checks', 'tcp-tls-heartbeat-checks', 'dns-checks', 'maintenance-windows', 'incident-updates', ...(this.service.subscriptionsEnabled ? ['status-subscriptions'] : []), 'incidents', 'alert-hub', 'email-alerts', 'public-status-page', 'seeded-monitors', 'ssrf-guard'], schemaVersion: this.db.schemaVersion });
    this.#registerPublic(app);
    await app.register((hooks) => this.#registerHooks(hooks));
    await app.register((api) => this.#registerV1(api), { prefix: '/v1' });
    await app.register((ops) => this.#registerMetrics(ops));
    return app;
  }

  /** The alert hook takes the raw body: webhook-out signed exactly those bytes. @param {FastifyInstance} hooks */
  async #registerHooks(hooks) {
    hooks.removeAllContentTypeParsers();
    hooks.addContentTypeParser('*', { parseAs: 'string' }, (_request, body, done) => done(null, body));
    await hooks.register(rateLimit, { global: false, errorResponseBuilder: (_r, c) => Object.assign(new Error(`rate limit exceeded, retry in ${c.after}`), { statusCode: 429, code: 'RATE_LIMITED' }) });
    const page = (/** @type {FastifyReply} */ reply, /** @type {number} */ code, /** @type {string} */ title, /** @type {string} */ text, /** @type {string} */ form = '') => reply.code(code).header('content-security-policy', StatusPage.CSP).header('cache-control', 'no-store').header('referrer-policy', 'no-referrer').type('text/html; charset=utf-8').send(StatusPage.message(this.config.page.title, title, text, form, `${this.config.page.publicUrl ?? ''}/status`));
    const limited = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };
    const token = (/** @type {FastifyRequest} */ r) => /** @type {{ token: string }} */ (r.params).token;
    const valid = (/** @type {string} */ t) => /^[A-Za-z0-9_-]{20,64}$/.test(t);
    // Status page subscriptions: a form post, a confirmation link (a GET shows a button, the POST acts, so link scanners do nothing), an unsubscribe link.
    hooks.post('/status/subscribe', limited, async (request, reply) => {
      const email = new URLSearchParams(typeof request.body === 'string' ? request.body : '').get('email') ?? '';
      try {
        await this.service.subscribe(email);
      } catch (err) {
        const e = /** @type {StatusError} */ (err);
        if (e.code === 'INVALID_ARGUMENT') return page(reply, 400, 'Not an e-mail address', 'Go back and check the address.');
        if (e.code === 'SUBSCRIPTIONS_DISABLED') return page(reply, 404, 'Not available', 'Subscriptions are not offered here.');
        if (e.code === 'LIMIT_EXCEEDED') return page(reply, 503, 'Not available right now', 'The subscriber list is full.');
        throw err;
      }
      return page(reply, 200, 'Check your inbox', 'If the address can subscribe, a confirmation mail is on its way. Click the link in it to start getting updates.');
    });
    hooks.get('/status/subscribe/:token', limited, async (request, reply) => (valid(token(request)) ? page(reply, 200, 'Confirm your subscription', 'Get an e-mail when a service on this page goes down or recovers?', '<form method="post"><button type="submit">Confirm</button></form>') : page(reply, 404, 'Link not valid', 'This link is not valid.')));
    hooks.post('/status/subscribe/:token', limited, async (request, reply) => {
      try { if (!valid(token(request))) throw new StatusError('SUBSCRIBER_NOT_FOUND', 'bad token'); this.service.confirmSubscriber(token(request)); } catch (err) { if (/** @type {StatusError} */ (err).code === 'SUBSCRIBER_NOT_FOUND') return page(reply, 404, 'Link not valid', 'This link is not valid or was already used.'); throw err; }
      return page(reply, 200, 'Subscribed', 'You will get an e-mail when a service on this page goes down or recovers. Every mail has an unsubscribe link.');
    });
    hooks.get('/status/unsubscribe/:token', limited, async (request, reply) => (valid(token(request)) ? page(reply, 200, 'Unsubscribe', 'Stop the status e-mails?', '<form method="post"><button type="submit">Unsubscribe</button></form>') : page(reply, 404, 'Link not valid', 'This link is not valid.')));
    hooks.post('/status/unsubscribe/:token', limited, async (request, reply) => {
      try { if (!valid(token(request))) throw new StatusError('SUBSCRIBER_NOT_FOUND', 'bad token'); this.service.unsubscribe(token(request)); } catch (err) { if (/** @type {StatusError} */ (err).code === 'SUBSCRIBER_NOT_FOUND') return page(reply, 404, 'Link not valid', 'This link is not valid or the address is no longer subscribed.'); throw err; }
      return page(reply, 200, 'Unsubscribed', 'You will not get status e-mails any more.');
    });
    hooks.post('/v1/hooks/webhook-out', async (request, reply) => {
      const raw = typeof request.body === 'string' ? request.body : '';
      const r = await this.alerts.receive(raw, /** @type {string|undefined} */ (request.headers['x-webhook-signature']));
      return reply.code(202).send({ received: true, ...r });
    });
  }

  /** @param {FastifyInstance} app */
  #registerPublic(app) {
    const cache = `public, max-age=${this.config.page.cacheSec}`;
    // Heartbeats: a cron job or script pings its monitor; the token in the path is the credential (no API key).
    app.route({
      method: ['GET', 'POST'], url: '/v1/ping/:id/:token', logLevel: 'warn', schema: { params: Schemas.pingParams },
      handler: async (request, reply) => {
        const { id, token } = /** @type {{ id: string, token: string }} */ (request.params);
        await this.service.ping(id, token);
        return reply.code(204).send();
      },
    });
    app.get('/status', { logLevel: 'warn' }, async (_request, reply) => {
      reply.header('content-security-policy', StatusPage.CSP).header('cache-control', cache).header('referrer-policy', 'no-referrer').type('text/html; charset=utf-8');
      return StatusPage.render(this.service.publicSummary());
    });
    app.get('/status/summary.json', { logLevel: 'warn' }, async (_request, reply) => {
      reply.header('cache-control', cache).header('access-control-allow-origin', '*');
      return this.service.publicSummary();
    });
  }

  /** @param {FastifyInstance} api */
  async #registerV1(api) {
    api.addHook('onRequest', this.auth.hook);
    await api.register(rateLimit, {
      max: this.config.rateLimitMax,
      timeWindow: '1 minute',
      keyGenerator: (request) => request.apiKey.id,
      errorResponseBuilder: (_request, context) => Object.assign(new Error(`rate limit exceeded, retry in ${context.after}`), { statusCode: 429, code: 'RATE_LIMITED' }),
    });
    const s = this.service;
    const read = { preHandler: ApiKeyAuth.require('read') };
    const admin = { preHandler: ApiKeyAuth.require('admin') };
    const mid = (/** @type {FastifyRequest} */ r) => /** @type {{ id: string }} */ (r.params).id;
    const target = (/** @type {FastifyRequest} */ r) => ({ type: 'monitor', id: mid(r) });

    api.get('/monitors', read, async () => ({ items: s.list().map((m) => Views.monitor(m, s)), nextCursor: null }));

    api.put('/monitors/:id', { config: { audit: AuditClient.route('atc-status.monitor.upsert', target, (r, b) => ({ created: b?.created, settings: r.body })) }, ...admin, schema: { params: Schemas.monitorParams, body: Schemas.putMonitor } }, async (request, reply) => {
      const { monitor, created, pingToken } = s.put(mid(request), /** @type {any} */ (request.body ?? {}), request.apiKey.id);
      return reply.code(created ? 201 : 200).send({ created, monitor: Views.monitor(monitor, s), ...(pingToken ? { pingToken, pingPath: `/v1/ping/${monitor.id}/${pingToken}` } : {}) });
    });

    api.get('/monitors/:id', { ...read, schema: { params: Schemas.monitorParams } }, async (request) => {
      const m = s.get(mid(request));
      const open = s.store.openOf(m.id);
      return { monitor: Views.monitor(m, s), uptime: { '24h': s.uptime(m.id, 1), '7d': s.uptime(m.id, 7), '30d': s.uptime(m.id, 30) }, openIncident: open ? Views.incident(open, s.now()) : null };
    });

    api.delete('/monitors/:id', { config: { audit: AuditClient.route('atc-status.monitor.delete', target) }, ...admin, schema: { params: Schemas.monitorParams } }, async (request, reply) => {
      s.delete(mid(request));
      return reply.code(204).send();
    });

    api.post('/monitors/:id/check', { ...admin, schema: { params: Schemas.monitorParams } }, async (request) => {
      const { result, monitor } = await s.checkNow(mid(request));
      return { check: { ok: result.ok, status: result.status, latencyMs: result.latencyMs, error: result.error }, monitor: Views.monitor(monitor, s) };
    });

    api.get('/monitors/:id/checks', { ...read, schema: { params: Schemas.monitorParams, querystring: Schemas.checksQuery } }, async (request) => {
      const m = s.get(mid(request));
      const q = /** @type {{ limit?: string, cursor?: string }} */ (request.query);
      const limit = q.limit ? Number(q.limit) : 50;
      const rows = s.store.checks(m.id, q.cursor ? Number(q.cursor) : Number.MAX_SAFE_INTEGER, limit + 1);
      const page = rows.slice(0, limit);
      return { items: page.map(Views.check), nextCursor: rows.length > limit ? String(page.at(-1)?.seq) : null };
    });

    api.get('/incidents', { ...read, schema: { querystring: Schemas.incidentsQuery } }, async (request) => {
      const q = /** @type {{ monitor?: string, state?: 'open'|'closed', limit?: string, cursor?: string }} */ (request.query);
      const limit = q.limit ? Number(q.limit) : 50;
      const [at, id] = q.cursor ? q.cursor.split('~') : [];
      const rows = s.store.incidents({ monitor: q.monitor, state: q.state, before: q.cursor ? { at: Number(at), id } : undefined, limit: limit + 1 });
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return { items: page.map((i) => Views.incident(i, s.now())), nextCursor: rows.length > limit && last ? `${last.opened_at}~${last.id}` : null };
    });

    api.get('/incidents/:id', { ...read, schema: { params: Schemas.incidentParams } }, async (request) => {
      const i = s.store.incident(mid(request));
      if (!i) throw new StatusError('INCIDENT_NOT_FOUND', `no incident "${mid(request)}"`);
      return { incident: Views.incident(i, s.now()), updates: s.store.updates(i.id).map(Views.update) };
    });

    api.post('/incidents/:id/updates', { config: { idempotent: true, audit: AuditClient.route('atc-status.incident.update', (r) => ({ type: 'incident', id: mid(r) }), (r) => ({ status: /** @type {any} */ (r.body).status })) }, ...admin, schema: { params: Schemas.incidentParams, body: Schemas.incidentUpdate } }, async (request, reply) => {
      const r = await s.updateIncident(mid(request), /** @type {any} */ (request.body), request.apiKey.id);
      return reply.code(201).send({ incident: Views.incident(r.incident, s.now()), updates: r.updates.map(Views.update) });
    });

    // ---- maintenance windows
    api.get('/maintenance', read, async () => { const r = s.listMaintenance(); const now = s.now(); return { current: r.current.map((w) => Views.maintenance(w, now)), past: r.past.map((w) => Views.maintenance(w, now)) }; });
    api.post('/maintenance', { config: { idempotent: true, audit: AuditClient.route('atc-status.maintenance.create', (_r, b) => ({ type: 'maintenance', id: b?.maintenance?.id ?? '' }), (r) => ({ startsAt: /** @type {any} */ (r.body).startsAt, endsAt: /** @type {any} */ (r.body).endsAt })) }, ...admin, schema: { body: Schemas.createMaintenance } }, async (request, reply) => reply.code(201).send({ maintenance: Views.maintenance(s.createMaintenance(/** @type {any} */ (request.body), request.apiKey.id), s.now()) }));
    api.delete('/maintenance/:id', { config: { audit: AuditClient.route('atc-status.maintenance.delete', (r) => ({ type: 'maintenance', id: mid(r) })) }, ...admin, schema: { params: Schemas.maintenanceParams } }, async (request, reply) => { s.deleteMaintenance(mid(request)); return reply.code(204).send(); });

    // ---- status page subscribers (addresses: admin keys only)
    api.get('/subscribers', { ...admin, schema: { querystring: Schemas.subscribersQuery } }, async (request) => {
      const q = /** @type {{ limit?: string, cursor?: string }} */ (request.query);
      const limit = q.limit ? Number(q.limit) : 100;
      const rows = s.store.subscribers(limit + 1, q.cursor);
      const page = rows.slice(0, limit);
      return { items: page.map(Views.subscriber), nextCursor: rows.length > limit ? page[page.length - 1].id : null, counts: s.store.subscriberCounts(), enabled: s.subscriptionsEnabled };
    });
    api.delete('/subscribers/:id', { config: { audit: AuditClient.route('atc-status.subscriber.delete', (r) => ({ type: 'subscriber', id: mid(r) })) }, ...admin, schema: { params: Schemas.subscriberParams } }, async (request, reply) => { s.deleteSubscriber(mid(request)); return reply.code(204).send(); });

    api.get('/alerts', { ...read, schema: { querystring: Schemas.alertsQuery } }, async (request) => {
      const q = /** @type {{ state?: 'open'|'acked', limit?: string, cursor?: string }} */ (request.query);
      const limit = q.limit ? Number(q.limit) : 50;
      const [at, id] = q.cursor ? q.cursor.split('~') : [];
      const rows = s.store.alerts({ state: q.state, before: q.cursor ? { at: Number(at), id } : undefined, limit: limit + 1 });
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return { items: page.map(Views.alert), nextCursor: rows.length > limit && last ? `${last.last_at}~${last.id}` : null };
    });

    api.post('/alerts/:id/ack', { config: { idempotent: true, audit: AuditClient.route('atc-status.alert.ack', (r) => ({ type: 'alert', id: mid(r) })) }, ...admin, schema: { params: Schemas.alertParams } }, async (request) => ({ alert: Views.alert(this.alerts.ack(mid(request), request.apiKey.id)) }));

    api.get('/stats', read, async () => s.stats());
  }

  /** @param {FastifyInstance} ops */
  #registerMetrics(ops) {
    ops.addHook('onRequest', this.auth.hook);
    ops.get('/metrics', { logLevel: 'warn', preHandler: ApiKeyAuth.require('read') }, async (_request, reply) => {
      const s = this.service;
      const ms = s.list();
      const label = (/** @type {string} */ v) => v.replace(/[\\"\n]/g, '\\$&');
      reply.type('text/plain; version=0.0.4; charset=utf-8');
      return [
        '# HELP status_monitor_up Whether the last check of a monitor succeeded (1) or not (0); absent before the first check.',
        '# TYPE status_monitor_up gauge',
        ...ms.filter((m) => m.last_ok !== null && m.paused === 0).map((m) => `status_monitor_up{monitor="${label(m.id)}"} ${m.last_ok}`),
        '# HELP status_check_latency_ms Latency of the last check.',
        '# TYPE status_check_latency_ms gauge',
        ...ms.filter((m) => m.last_latency_ms !== null).map((m) => `status_check_latency_ms{monitor="${label(m.id)}"} ${m.last_latency_ms}`),
        '# HELP status_incident_open Whether a monitor has an open incident.',
        '# TYPE status_incident_open gauge',
        ...ms.map((m) => `status_incident_open{monitor="${label(m.id)}"} ${s.store.openOf(m.id) ? 1 : 0}`),
        ...AuditMetrics.lines(this.audit),
        ...(this.publisher?.metricLines() ?? []),
        ...(this.heartbeat?.metricLines() ?? []),
        '# HELP status_alerts_open Alerts that are not acknowledged yet, by severity.',
        '# TYPE status_alerts_open gauge',
        `status_alerts_open{severity="critical"} ${s.store.alertCounts().critical}`,
        `status_alerts_open{severity="warning"} ${s.store.alertCounts().open - s.store.alertCounts().critical}`,
        '# HELP status_process_uptime_seconds Process uptime.',
        '# TYPE status_process_uptime_seconds gauge',
        `status_process_uptime_seconds ${process.uptime().toFixed(0)}`,
        '',
      ].join('\n');
    });
  }
}
