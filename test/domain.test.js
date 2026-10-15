import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NetGuard } from '@atc-web/atc-service-core/http';
import { Checker } from '../src/net/checker.js';
import { manualClock, scriptedChecker, targetServer, testService } from './helpers.js';

const code = (/** @type {string} */ c) => (/** @type {any} */ e) => e.code === c;
const FAIL = { ok: false, status: 503, latencyMs: 9, error: 'unexpected status 503' };
const OK = { ok: true, status: 200, latencyMs: 7, error: null };

test('seed: health and ready monitors per MONITOR_SEEDS entry, idempotent, URL follows the env', () => {
  const t = testService({ MONITOR_SEEDS: 'atc-auth=http://127.0.0.1:3002,atc-media=http://127.0.0.1:3003', SEED_INTERVAL_SEC: '30' });
  t.service.seed();
  t.service.seed();
  assert.deepEqual(t.service.list().map((m) => [m.id, m.url, m.origin, m.public, m.interval_sec]), [
    ['atc-auth-health', 'http://127.0.0.1:3002/health', 'env', 1, 30], ['atc-auth-ready', 'http://127.0.0.1:3002/ready', 'env', 1, 30],
    ['atc-media-health', 'http://127.0.0.1:3003/health', 'env', 1, 30], ['atc-media-ready', 'http://127.0.0.1:3003/ready', 'env', 1, 30],
  ]);
  t.service.put('atc-auth-health', { name: 'Auth', paused: true }, 'console');
  const moved = testService({ MONITOR_SEEDS: 'atc-auth=http://10.0.0.5:3002' });
  moved.store.insert(/** @type {any} */ ({ ...t.store.monitor('atc-auth-health') }));
  moved.service.seed();
  assert.deepEqual([moved.store.monitor('atc-auth-health')?.url, moved.store.monitor('atc-auth-health')?.name, moved.store.monitor('atc-auth-health')?.paused], ['http://10.0.0.5:3002/health', 'Auth', 1], 'the URL follows the env, edits stay');
  assert.throws(() => t.service.put('atc-auth-ready', { url: 'https://example.com/x' }, 'console'), code('INVALID_ARGUMENT'));
  assert.throws(() => t.service.delete('atc-auth-ready'), code('INVALID_STATE'));
});

test('put: defaults, partial updates, validation, SSRF guard, limits', () => {
  const clock = manualClock();
  const t = testService({ MAX_MONITORS: '2' }, { now: clock.now });
  const { monitor, created } = t.service.put('shop', { url: 'https://shop.example.com/health' }, 'console');
  assert.deepEqual([created, monitor.name, monitor.method, monitor.interval_sec, monitor.timeout_ms, monitor.expect_status, monitor.fail_threshold, monitor.public, monitor.origin, monitor.created_by, monitor.next_at], [true, 'shop', 'GET', 60, 5000, '[200]', 2, 0, 'api', 'console', clock.now()]);
  clock.advance(1000);
  const u = t.service.put('shop', { name: 'Shop', expectStatus: [204, 200, 200], public: true }, 'ops');
  assert.deepEqual([u.created, u.monitor.name, u.monitor.url, u.monitor.expect_status, u.monitor.public, u.monitor.created_by, u.monitor.next_at], [false, 'Shop', 'https://shop.example.com/health', '[200,204]', 1, 'console', clock.now() - 1000], 'no reschedule for cosmetic changes');
  assert.equal(t.service.put('shop', { intervalSec: 30 }, 'ops').monitor.next_at, clock.now(), 'a new interval checks soon');
  assert.throws(() => t.service.put('new', {}, 'x'), code('INVALID_ARGUMENT'));
  assert.throws(() => t.service.put('Bad Id', { url: 'https://x.example.com' }, 'x'), code('INVALID_ARGUMENT'));
  assert.throws(() => t.service.put('plain', { url: 'http://x.example.com' }, 'x'), code('TARGET_NOT_ALLOWED'));
  assert.throws(() => t.service.put('creds', { url: 'https://u:p@x.example.com' }, 'x'), code('TARGET_NOT_ALLOWED'));
  assert.throws(() => t.service.put('slow', { url: 'https://x.example.com', intervalSec: 10, timeoutMs: 20_000 }, 'x'), code('INVALID_ARGUMENT'));
  t.service.put('second', { url: 'https://x.example.com' }, 'x');
  assert.throws(() => t.service.put('third', { url: 'https://y.example.com' }, 'x'), code('LIMIT_EXCEEDED'));
  t.service.delete('second');
  assert.throws(() => t.service.get('second'), code('MONITOR_NOT_FOUND'));
});

test('incidents: open after failThreshold failures in a row, one per monitor, closed by the first success, alerts sent', async () => {
  const clock = manualClock();
  /** @type {string[]} */ const sent = [];
  let notifyFails = false;
  const notifier = { incident: async (/** @type {string} */ ev, /** @type {any} */ i) => { if (notifyFails) throw new Error('atc-notify responded 503'); sent.push(`${ev}:${i.id}:${i.failures}`); } };
  /** @type {any[]} */ const published = [];
  const t = testService(undefined, { now: clock.now, notifier, publisher: { publish: (/** @type {string} */ type, /** @type {any} */ d) => published.push([type, d.id, d.monitor, d.failures, Object.keys(d).join()]) } });
  t.service.put('api', { url: 'https://api.example.com/health', failThreshold: 2 }, 'x');
  const url = 'https://api.example.com/health';
  t.checker.results.set(url, [FAIL, FAIL, FAIL, OK]);
  await t.service.checkNow('api');
  assert.deepEqual([t.service.stateOf(t.service.get('api')), t.store.openAll().length], ['degraded', 0], 'one failure is not an incident');
  clock.advance(60_000);
  await t.service.checkNow('api');
  const [open] = t.store.openAll();
  assert.deepEqual([t.service.stateOf(t.service.get('api')), open.failures, open.cause, sent], ['down', 2, 'unexpected status 503', [`opened:${open.id}:2`]]);
  clock.advance(60_000);
  await t.service.checkNow('api');
  assert.deepEqual([t.store.openAll().length, t.store.incident(open.id)?.failures], [1, 3]);
  clock.advance(60_000);
  notifyFails = true;
  await t.service.checkNow('api');
  const closed = t.store.incident(open.id);
  assert.deepEqual([closed?.closed_at, closed?.notify_error, t.service.stateOf(t.service.get('api')), t.service.get('api').consecutive_failures], [clock.now(), 'closed: atc-notify responded 503', 'up', 0]);
  assert.deepEqual(published.map((e) => e.slice(0, 3).concat(e[4])), [['incident.opened', open.id, 'api', 'id,monitor,name,cause,failures'], ['incident.closed', open.id, 'api', 'id,monitor,name,cause,failures']], 'no URL or error text leaves the service');
  assert.deepEqual(t.service.stats(), { monitors: 1, up: 1, down: 0, degraded: 0, unknown: 0, paused: 0, maintenance: 0, openIncidents: 0, incidents24h: 1, openAlerts: 0, criticalAlerts: 0, notify: true });
  const up = t.service.uptime('api', 1);
  assert.deepEqual([up.checks, up.uptime, up.avgMs], [4, 25, 7]);
});

test('runDue: due monitors only, claimed once, within MAX_CONCURRENT; paused ones wait', async () => {
  const clock = manualClock();
  const t = testService({ MAX_CONCURRENT: '2' }, { now: clock.now });
  for (const id of ['a', 'b', 'c']) t.service.put(id, { url: `https://${id}.example.com` }, 'x');
  t.service.put('p', { url: 'https://p.example.com', paused: true }, 'x');
  await t.service.runDue();
  assert.deepEqual(t.checker.calls.sort(), ['a', 'b']);
  await t.service.runDue();
  assert.deepEqual(t.checker.calls.sort(), ['a', 'b', 'c']);
  await t.service.runDue();
  assert.equal(t.checker.calls.length, 3, 'nothing due until the interval passes');
  clock.advance(60_000);
  await t.service.runDue();
  await t.service.runDue();
  assert.equal(t.checker.calls.length, 6);
  assert.equal(t.checker.calls.includes('p'), false);
  t.service.stopping.abort();
  clock.advance(60_000);
  await t.service.runDue();
  assert.equal(t.checker.calls.length, 6, 'stopped');
});

test('public summary: public monitors only, no URLs or errors, overall state, incidents; retention', async () => {
  const clock = manualClock();
  const t = testService(undefined, { now: clock.now });
  t.service.put('web', { name: 'Website', url: 'https://web.example.com', public: true, failThreshold: 1 }, 'x');
  t.service.put('internal', { url: 'https://internal.example.com', failThreshold: 1 }, 'x');
  t.checker.results.set('https://web.example.com', [FAIL, OK]);
  t.checker.results.set('https://internal.example.com', [FAIL]);
  await t.service.checkNow('web');
  await t.service.checkNow('internal');
  let p = /** @type {any} */ (t.service.publicSummary());
  assert.deepEqual([p.overall, p.monitors.map((/** @type {any} */ m) => [m.name, m.state]), p.incidents.length, p.incidents[0].closedAt], ['outage', [['Website', 'down']], 1, null]);
  assert.equal(JSON.stringify(p).includes('example.com'), false, 'no URLs');
  assert.equal(JSON.stringify(p).includes('503'), false, 'no error texts');
  clock.advance(120_000);
  await t.service.checkNow('web');
  p = t.service.publicSummary();
  assert.deepEqual([p.overall, p.monitors[0].state, p.monitors[0].uptime24h, p.incidents[0].durationSec], ['operational', 'up', 50, 120]);
  clock.advance(20 * 86_400_000);
  assert.deepEqual(t.service.maintain(), { maintenance: 0, subscribers: 0, checks: 3, incidents: 0, alerts: 0 });
});

test('checker: real HTTP, expected statuses, no redirects, timeout, SSRF guard for API monitors only', async (t) => {
  const srv = await targetServer();
  t.after(srv.close);
  const guard = new NetGuard({});
  const checker = new Checker({ guard });
  const m = (/** @type {string} */ path, /** @type {object} */ o = {}) => /** @type {any} */ ({ id: 'x', url: `${srv.url}${path}`, method: 'GET', timeout_ms: 1_000, expect_status: '[200]', origin: 'env', ...o });
  const ok = await checker.check(m('/ok'));
  assert.deepEqual([ok.ok, ok.status, ok.error], [true, 200, null]);
  assert.ok(ok.latencyMs >= 0);
  assert.deepEqual(await checker.check(m('/fail')).then((r) => [r.ok, r.status, r.error]), [false, 503, 'unexpected status 503']);
  assert.deepEqual(await checker.check(m('/fail', { expect_status: '[503]' })).then((r) => [r.ok, r.status]), [true, 503]);
  assert.deepEqual(await checker.check(m('/redirect')).then((r) => [r.ok, r.status]), [false, 302], 'redirects are not followed');
  assert.deepEqual(await checker.check(m('/ok', { method: 'HEAD' })).then((r) => r.ok), true);
  const slow = await checker.check(m('/slow', { timeout_ms: 300 }));
  assert.deepEqual([slow.ok, slow.status], [false, null]);
  assert.match(String(slow.error), /timed out after 300ms/);
  const blocked = await checker.check(m('/ok', { origin: 'api' }));
  assert.deepEqual([blocked.ok, blocked.status], [false, null]);
  assert.match(String(blocked.error), /scheme|not allowed|non-public/);
  const allowed = new Checker({ guard: new NetGuard({ allowHttp: true, allowPrivate: true, allowedHosts: ['127.0.0.1'] }) });
  assert.equal((await allowed.check(m('/ok', { origin: 'api' }))).ok, true);
});
