import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ADMIN_KEY, READ_KEY, bearer, buildApp, manualClock } from './helpers.js';

const FAIL = { ok: false, status: 500, latencyMs: 3, error: 'unexpected status 500' };

test('API: probes, info, auth', async (t) => {
  const { app } = await buildApp();
  t.after(() => app.close());
  assert.deepEqual(JSON.parse((await app.inject({ url: '/ready' })).body), { status: 'ok', monitors: 0, checker: 'running', notify: 'disabled', alertHook: 'disabled' });
  assert.equal(JSON.parse((await app.inject({ url: '/v1/info' })).body).service, 'atc-status');
  assert.equal((await app.inject({ url: '/v1/monitors' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'PUT', url: '/v1/monitors/x', headers: bearer(READ_KEY), payload: { url: 'https://x.example.com' } })).statusCode, 403);
  assert.equal((await app.inject({ url: '/openapi.yaml' })).statusCode, 200);
});

test('API: monitors, check now, checks, incidents, stats, metrics', async (t) => {
  const clock = manualClock();
  const { app, checker } = await buildApp(undefined, {}, { now: clock.now });
  t.after(() => app.close());
  const a = bearer(ADMIN_KEY);
  let res = await app.inject({ method: 'PUT', url: '/v1/monitors/shop', headers: a, payload: { name: 'Shop', url: 'https://shop.example.com/health', failThreshold: 1, public: true } });
  assert.equal(res.statusCode, 201);
  assert.deepEqual([JSON.parse(res.body).monitor.state, JSON.parse(res.body).monitor.origin], ['unknown', 'api']);
  assert.equal((await app.inject({ method: 'PUT', url: '/v1/monitors/shop', headers: a, payload: { intervalSec: 5 } })).statusCode, 400);
  assert.equal(JSON.parse((await app.inject({ method: 'PUT', url: '/v1/monitors/bad', headers: a, payload: { url: 'http://10.0.0.1/' } })).body).error.code, 'TARGET_NOT_ALLOWED');
  checker.results.set('https://shop.example.com/health', [FAIL, { ok: true, status: 200, latencyMs: 4, error: null }]);
  res = await app.inject({ method: 'POST', url: '/v1/monitors/shop/check', headers: a });
  assert.deepEqual([JSON.parse(res.body).check.ok, JSON.parse(res.body).monitor.state], [false, 'down']);
  const open = JSON.parse((await app.inject({ url: '/v1/incidents?state=open', headers: bearer(READ_KEY) })).body).items;
  assert.deepEqual([open.length, open[0].monitor, open[0].cause], [1, 'shop', 'unexpected status 500']);
  assert.equal(JSON.parse((await app.inject({ url: `/v1/incidents/${open[0].id}`, headers: bearer(READ_KEY) })).body).incident.state, 'open');
  const detail = JSON.parse((await app.inject({ url: '/v1/monitors/shop', headers: bearer(READ_KEY) })).body);
  assert.deepEqual([detail.openIncident.id, detail.uptime['24h'].checks], [open[0].id, 1]);
  clock.advance(30_000);
  await app.inject({ method: 'POST', url: '/v1/monitors/shop/check', headers: a });
  assert.equal(JSON.parse((await app.inject({ url: '/v1/incidents?state=closed', headers: a })).body).items[0].durationSec, 30);
  const checks = JSON.parse((await app.inject({ url: '/v1/monitors/shop/checks?limit=1', headers: a })).body);
  assert.deepEqual([checks.items[0].ok, typeof checks.nextCursor], [true, 'string']);
  const older = JSON.parse((await app.inject({ url: `/v1/monitors/shop/checks?limit=1&cursor=${checks.nextCursor}`, headers: a })).body);
  assert.deepEqual([older.items[0].ok, older.nextCursor], [false, null]);
  assert.equal(JSON.parse((await app.inject({ url: '/v1/stats', headers: a })).body).up, 1);
  assert.match((await app.inject({ url: '/metrics', headers: bearer(READ_KEY) })).body, /status_monitor_up\{monitor="shop"\} 1/);
  assert.equal((await app.inject({ url: '/v1/monitors/nope', headers: a })).statusCode, 404);
  assert.equal((await app.inject({ method: 'DELETE', url: '/v1/monitors/shop', headers: a })).statusCode, 204);
  assert.deepEqual(JSON.parse((await app.inject({ url: '/v1/monitors', headers: a })).body).items, []);
});

test('public: status page and JSON without a key, public monitors only, escaped, strict CSP', async (t) => {
  const { app } = await buildApp({ STATUS_PAGE_TITLE: 'Acme <status>' });
  t.after(() => app.close());
  const a = bearer(ADMIN_KEY);
  await app.inject({ method: 'PUT', url: '/v1/monitors/web', headers: a, payload: { name: '<b>Web</b>', url: 'https://web.example.com', public: true } });
  await app.inject({ method: 'PUT', url: '/v1/monitors/secret', headers: a, payload: { name: 'Secret DB', url: 'https://db.internal.example.com' } });
  await app.inject({ method: 'POST', url: '/v1/monitors/web/check', headers: a });
  const json = await app.inject({ url: '/status/summary.json' });
  assert.equal(json.statusCode, 200);
  const d = JSON.parse(json.body);
  assert.deepEqual([d.title, d.overall, d.monitors.map((/** @type {any} */ m) => [m.name, m.state])], ['Acme <status>', 'operational', [['<b>Web</b>', 'up']]]);
  assert.equal(json.headers['access-control-allow-origin'], '*');
  const page = await app.inject({ url: '/status' });
  assert.equal(page.statusCode, 200);
  assert.match(String(page.headers['content-type']), /^text\/html/);
  assert.match(String(page.headers['content-security-policy']), /default-src 'none'/);
  assert.ok(page.body.includes('&lt;b&gt;Web&lt;/b&gt;') && page.body.includes('Acme &lt;status&gt;'));
  assert.equal(page.body.includes('<b>Web</b>'), false);
  assert.equal(page.body.includes('Secret DB') || page.body.includes('example.com'), false);
  assert.equal(page.body.includes('<script'), false);
});
