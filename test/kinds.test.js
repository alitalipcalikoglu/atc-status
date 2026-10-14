import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as tcpServer } from 'node:net';
import { createServer as tlsServer } from 'node:tls';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { NetGuard } from '@atc-web/atc-service-core/http';
import { StatusError } from '../src/domain/errors.js';
import { OutboundHeartbeat } from '../src/net/outbound-heartbeat.js';
import { Checker } from '../src/net/checker.js';
import { ADMIN_KEY, READ_KEY, bearer, buildApp, manualClock, targetServer, testService } from './helpers.js';

const dir = mkdtempSync(join(tmpdir(), 'status-kinds-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const trusted = new NetGuard({ allowHttp: true, allowPrivate: true });
const row = (/** @type {object} */ o) => /** @type {any} */ ({ id: 'x', kind: 'http', url: '', method: 'GET', timeout_ms: 1_000, expect_status: '[200]', origin: 'env', interval_sec: 60, created_at: 0, ...o });
const code = (/** @type {string} */ c) => (/** @type {any} */ e) => e instanceof StatusError && e.code === c;

test('http keyword check: the text must be in the first KiB of the body, also for expected non-2xx statuses', async (t) => {
  const srv = await targetServer();
  t.after(srv.close);
  const checker = new Checker({ guard: trusted });
  const m = (/** @type {object} */ o) => row({ url: `${srv.url}/ok`, ...o });
  assert.equal((await checker.check(m({ expect_text: 'fine' }))).ok, true);
  assert.deepEqual(await checker.check(m({ expect_text: 'missing' })).then((r) => [r.ok, r.status, r.error]), [false, 200, 'expected text not found in the response']);
  assert.equal((await checker.check(m({ url: `${srv.url}/fail`, expect_status: '[503]', expect_text: 'down' }))).ok, true);
});

test('tcp check: connects to host and port from the target; refused and filtered ports fail', async (t) => {
  const server = tcpServer((s) => s.end());
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  t.after(() => server.close());
  const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  const checker = new Checker({ guard: trusted });
  assert.deepEqual(await checker.check(row({ kind: 'tcp', url: `https://127.0.0.1:${port}` })).then((r) => [r.ok, r.status, r.error]), [true, null, null]);
  const closed = await checker.check(row({ kind: 'tcp', url: 'https://127.0.0.1:1' }));
  assert.equal(closed.ok, false);
  assert.match(String(closed.error), /connection failed/);
  const api = new Checker({ guard: new NetGuard({}) });
  assert.match(String((await api.check(row({ kind: 'tcp', origin: 'api', url: `https://127.0.0.1:${port}` }))).error), /non-public/, 'the SSRF guard applies to API monitors');
});

test('tls check: valid certificate passes, one expiring inside warnDays fails, an untrusted one fails', async (t) => {
  const cert = join(dir, 'cert.pem');
  const key = join(dir, 'key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '30', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  const server = tlsServer({ cert: readFileSync(cert), key: readFileSync(key) }, (s) => s.end());
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  t.after(() => server.close());
  const url = `https://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
  const trustedCa = new Checker({ guard: trusted, tlsOptions: { ca: readFileSync(cert) } });
  assert.deepEqual(await trustedCa.check(row({ kind: 'tls', url, warn_days: 14 })).then((r) => [r.ok, r.error]), [true, null]);
  assert.match(String((await trustedCa.check(row({ kind: 'tls', url, warn_days: 60 }))).error), /certificate expires in 2[89] days/);
  const strict = await new Checker({ guard: trusted }).check(row({ kind: 'tls', url, warn_days: 14 }));
  assert.equal(strict.ok, false);
  assert.match(String(strict.error), /certificate rejected|handshake failed/);
});

test('heartbeat: on time is up, a missed ping opens an incident, a late ping recovers at once; tokens are checked and rotated', async () => {
  const clock = manualClock();
  const { service, store } = testService(undefined, { now: clock.now, checker: new Checker({ guard: trusted, now: clock.now }) });
  const created = service.put('nightly', { kind: 'heartbeat', name: 'Nightly job', intervalSec: 3_600, graceSec: 600, failThreshold: 1 }, 'x');
  assert.deepEqual([created.created, created.monitor.kind, created.monitor.url, /^[0-9a-f]{40}$/.test(String(created.pingToken)), created.monitor.ping_hash === created.pingToken], [true, 'heartbeat', '', true, false], 'only a hash is stored');
  const token = /** @type {string} */ (created.pingToken);
  clock.advance(3_000_000);
  await service.ping('nightly', token);
  assert.equal(store.monitor('nightly')?.last_ping_at, clock.now());
  clock.advance(3_900_000);
  assert.equal((await service.checkNow('nightly')).result.ok, true, '3 900 s after the ping is inside interval + grace (4 200 s)');
  clock.advance(600_000);
  const late = await service.checkNow('nightly');
  assert.deepEqual([late.result.ok, late.result.error], [false, 'no ping for 4500s (expected every 3600s)']);
  assert.equal(service.stateOf(service.get('nightly')), 'down');
  await service.ping('nightly', token);
  assert.equal(service.stateOf(service.get('nightly')), 'up', 'the ping closes the incident without waiting for the next interval');
  await assert.rejects(service.ping('nightly', 'a'.repeat(40)), code('MONITOR_NOT_FOUND'));
  await assert.rejects(service.ping('missing', token), code('MONITOR_NOT_FOUND'));
  const rotated = service.put('nightly', { rotateToken: true }, 'x');
  assert.notEqual(rotated.pingToken, token);
  await assert.rejects(service.ping('nightly', token), code('MONITOR_NOT_FOUND'));
  await service.ping('nightly', /** @type {string} */ (rotated.pingToken));
  assert.equal(service.put('nightly', { name: 'Renamed' }, 'x').pingToken, null, 'the token is shown only on create and rotate');
});

test('heartbeat: never pinged is judged from creation; validation keeps the kinds apart', async () => {
  const clock = manualClock();
  const { service } = testService(undefined, { now: clock.now, checker: new Checker({ guard: trusted, now: clock.now }) });
  service.put('cron', { kind: 'heartbeat', intervalSec: 60, graceSec: 0, failThreshold: 1 }, 'x');
  clock.advance(61_000);
  assert.equal((await service.checkNow('cron')).result.error, 'no ping received yet');
  assert.throws(() => service.put('cron', { url: 'https://x.example/' }, 'x'), code('INVALID_ARGUMENT'));
  assert.throws(() => service.put('cron', { kind: 'http' }, 'x'), code('INVALID_ARGUMENT'), 'the kind is fixed');
  assert.throws(() => service.put('h', { url: 'https://x.example/', graceSec: 5 }, 'x'), code('INVALID_ARGUMENT'));
  assert.throws(() => service.put('h', { kind: 'tcp', url: 'https://x.example:25', expectText: 'a' }, 'x'), code('INVALID_ARGUMENT'));
  assert.throws(() => service.put('h', { kind: 'http', url: 'https://x.example/', warnDays: 5 }, 'x'), code('INVALID_ARGUMENT'));
  assert.throws(() => service.put('h', { url: 'https://x.example/', method: 'HEAD', expectText: 'a' }, 'x'), code('INVALID_ARGUMENT'));
  const tls = service.put('c', { kind: 'tls', url: 'https://x.example:443' }, 'x');
  assert.deepEqual([tls.monitor.kind, tls.monitor.warn_days, tls.monitor.expect_text], ['tls', 14, null]);
});

test('API: heartbeat pings need no key, the path token is the credential; the create response shows it once', async (t) => {
  const { app } = await buildApp();
  t.after(() => app.close());
  const put = await app.inject({ method: 'PUT', url: '/v1/monitors/backup-job', headers: bearer(ADMIN_KEY), payload: { kind: 'heartbeat', name: 'Backup job', intervalSec: 600 } });
  const body = JSON.parse(put.body);
  assert.deepEqual([put.statusCode, body.monitor.kind, body.monitor.url, body.monitor.graceSec, body.pingPath === `/v1/ping/backup-job/${body.pingToken}`], [201, 'heartbeat', null, 60, true]);
  assert.equal((await app.inject({ method: 'POST', url: body.pingPath })).statusCode, 204);
  assert.equal((await app.inject({ method: 'GET', url: body.pingPath })).statusCode, 204, 'curl-friendly GET works too');
  assert.equal((await app.inject({ method: 'POST', url: `/v1/ping/backup-job/${'0'.repeat(40)}` })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/ping/backup-job/short' })).statusCode, 400);
  const view = JSON.parse((await app.inject({ url: '/v1/monitors/backup-job', headers: bearer(READ_KEY) })).body);
  assert.equal(typeof view.monitor.lastPingAt, 'string');
  assert.equal(JSON.stringify(view).includes(body.pingToken), false, 'the token is never shown again');
});

test('outbound heartbeat: GETs its URL, counts outcomes, never throws', async () => {
  /** @type {string[]} */ const calls = [];
  let status = 200;
  const fetchImpl = /** @type {typeof fetch} */ (async (url) => { calls.push(String(url)); if (status === 0) throw new Error('refused'); return new Response('ok', { status }); });
  const hb = new OutboundHeartbeat({ url: 'https://hc.example/ping/abc', intervalSec: 60, fetchImpl });
  assert.equal(await hb.ping(), true);
  status = 500;
  assert.equal(await hb.ping(), false);
  status = 0;
  assert.equal(await hb.ping(), false);
  assert.deepEqual([calls.length, hb.stats], [3, { ok: 1, failed: 2 }]);
  assert.match(hb.metricLines().join('\n'), /status_heartbeat_out_total\{result="failed"\} 2/);
});
