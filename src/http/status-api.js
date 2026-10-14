import { readFileSync } from 'node:fs';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { AuditClient } from '@atc-web/atc-service-core/audit';
import { createErrorHandler, registerInfo, registerOpenApi, registerProbes, registerRequestContext, requestOptions } from '@atc-web/atc-service-core/fastify';
import { StatusError } from '../domain/errors.js';
import { ApiKeyAuth } from './api-key-auth.js';
import { Schemas } from './schemas.js';
import { StatusPage } from './status-page.js';
import { Views } from './views.js';
import { AuditMetrics } from '../audit-metrics.js';

/** @typedef {import('../config.js').Config} Config */
/** @typedef {import('fastify').FastifyInstance} FastifyInstance */
/** @typedef {import('fastify').FastifyRequest} FastifyRequest */

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
   */
  constructor({ config, audit, service, alerts, db, version, logger }) {
    this.alerts = alerts;
    this.config = config;
    this.audit = audit;
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
    registerProbes(app, () => this.db.ping(), {
      cacheMs: StatusApi.READY_CACHE_MS,
      extra: () => ({ monitors: this.service.store.count(), checker: this.service.stopping.signal.aborted ? 'stopped' : 'running', notify: config.notify ? 'enabled' : 'disabled', alertHook: config.alertHookSecret ? 'enabled' : 'disabled' }),
    });
    registerOpenApi(app, new URL('../../openapi.yaml', import.meta.url));
    registerInfo(app, { service: 'atc-status', version: this.version, capabilities: ['http-checks', 'incidents', 'email-alerts', 'public-status-page', 'seeded-monitors', 'ssrf-guard'], schemaVersion: this.db.schemaVersion });
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
    hooks.post('/v1/hooks/webhook-out', async (request, reply) => {
      const raw = typeof request.body === 'string' ? request.body : '';
      const r = await this.alerts.receive(raw, /** @type {string|undefined} */ (request.headers['x-webhook-signature']));
      return reply.code(202).send({ received: true, ...r });
    });
  }

  /** @param {FastifyInstance} app */
  #registerPublic(app) {
    const cache = `public, max-age=${this.config.page.cacheSec}`;
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

    api.get('/monitors', read, async () => ({ items: s.list().map((m) => Views.monitor(m, s)) }));

    api.put('/monitors/:id', { config: { audit: AuditClient.route('atc-status.monitor.upsert', target, (r, b) => ({ created: b?.created, settings: r.body })) }, ...admin, schema: { params: Schemas.monitorParams, body: Schemas.putMonitor } }, async (request, reply) => {
      const { monitor, created } = s.put(mid(request), /** @type {any} */ (request.body ?? {}), request.apiKey.id);
      return reply.code(created ? 201 : 200).send({ created, monitor: Views.monitor(monitor, s) });
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
      return { incident: Views.incident(i, s.now()) };
    });

    api.get('/alerts', { ...read, schema: { querystring: Schemas.alertsQuery } }, async (request) => {
      const q = /** @type {{ state?: 'open'|'acked', limit?: string, cursor?: string }} */ (request.query);
      const limit = q.limit ? Number(q.limit) : 50;
      const [at, id] = q.cursor ? q.cursor.split('~') : [];
      const rows = s.store.alerts({ state: q.state, before: q.cursor ? { at: Number(at), id } : undefined, limit: limit + 1 });
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return { items: page.map(Views.alert), nextCursor: rows.length > limit && last ? `${last.last_at}~${last.id}` : null };
    });

    api.post('/alerts/:id/ack', { config: { audit: AuditClient.route('atc-status.alert.ack', (r) => ({ type: 'alert', id: mid(r) })) }, ...admin, schema: { params: Schemas.alertParams } }, async (request) => ({ alert: Views.alert(this.alerts.ack(mid(request), request.apiKey.id)) }));

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
