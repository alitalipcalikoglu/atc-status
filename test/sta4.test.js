import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { test } from 'node:test';
import { NetGuard } from '@atc-web/atc-service-core/http';
import { StatusError } from '../src/domain/errors.js';
import { Checker } from '../src/net/checker.js';
import { manualClock, testService, buildApp, ADMIN_KEY, bearer } from './helpers.js';

const FAIL = { ok: false, status: 503, latencyMs: 9, error: 'unexpected status 503' };
const OK = { ok: true, status: 200, latencyMs: 5, error: null };
const code = (/** @type {string} */ c) => (/** @type {any} */ e) => e instanceof StatusError && e.code === c;

/** A tiny UDP DNS server: A queries for known names answer one address, everything else NXDOMAIN. @param {Record<string, string>} names */
async function dnsServer(names) {
  const sock = createSocket('udp4');
  sock.on('message', (msg, rinfo) => {
    let i = 12; const labels = [];
    while (msg[i] !== 0) { labels.push(msg.subarray(i + 1, i + 1 + msg[i]).toString()); i += msg[i] + 1; }
    const qEnd = i + 5;
    const name = labels.join('.').toLowerCase();
    const qtype = msg.readUInt16BE(i + 1);
    const ip = qtype === 1 ? names[name] : undefined;
    const head = Buffer.from(msg.subarray(0, 12));
    head.writeUInt16BE(ip ? 0x8180 : 0x8183, 2); // response, recursion available; rcode 3 = NXDOMAIN
    head.writeUInt16BE(1, 4); head.writeUInt16BE(ip ? 1 : 0, 6); head.writeUInt16BE(0, 8); head.writeUInt16BE(0, 10);
    const answer = ip ? Buffer.concat([Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4]), Buffer.from(ip.split('.').map(Number))]) : Buffer.alloc(0);
    sock.send(Buffer.concat([head, msg.subarray(12, qEnd), answer]), rinfo.port, rinfo.address);
  });
  await new Promise((r) => sock.bind(0, '127.0.0.1', () => r(undefined)));
  return { server: `127.0.0.1:${sock.address().port}`, close: () => sock.close() };
}

test('dns monitor: the name must resolve; expected text must be in a record; validation of the host name', async (t) => {
  const dns = await dnsServer({ 'shop.example.test': '203.0.113.7' });
  t.after(dns.close);
  const checker = new Checker({ guard: new NetGuard({}), dnsServers: [dns.server] });
  const row = (/** @type {object} */ o) => /** @type {any} */ ({ id: 'd', kind: 'dns', dns_type: 'A', url: 'shop.example.test', timeout_ms: 1_000, expect_text: null, origin: 'api', ...o });
  assert.deepEqual(await checker.check(row({})).then((r) => [r.ok, r.error]), [true, null]);
  assert.deepEqual(await checker.check(row({ expect_text: '203.0.113.7' })).then((r) => r.ok), true);
  const wrong = await checker.check(row({ expect_text: '198.51.100.1' }));
  assert.match(String(wrong.error), /no A record contains the expected text \(got 203\.0\.113\.7\)/);
  const missing = await checker.check(row({ url: 'nope.example.test' }));
  assert.match(String(missing.error), /A lookup failed: ENOTFOUND/);

  const s = testService();
  const m = s.service.put('dns-shop', { kind: 'dns', url: 'shop.example.test', dnsType: 'A', expectText: '203.0.113.7' }, 'x').monitor;
  assert.deepEqual([m.kind, m.dns_type, m.url, m.expect_text], ['dns', 'A', 'shop.example.test', '203.0.113.7']);
  assert.throws(() => s.service.put('dns-bad', { kind: 'dns', url: 'https://x.test/' }, 'x'), code('INVALID_ARGUMENT'));
  assert.throws(() => s.service.put('http-x', { url: 'https://x.test/', dnsType: 'MX' }, 'x'), code('INVALID_ARGUMENT'), 'dnsType belongs to dns monitors');
});

test('maintenance: failures inside a window open no incident and the monitor shows maintenance; afterwards they do', async () => {
  const clock = manualClock();
  const s = testService(undefined, { now: clock.now });
  const url = 'https://api.example.com/health';
  s.service.put('api', { url, failThreshold: 1, public: true }, 'x');
  s.checker.results.set(url, [FAIL]);
  const iso = (/** @type {number} */ ms) => new Date(ms).toISOString();
  assert.throws(() => s.service.createMaintenance({ title: 'x', startsAt: iso(clock.now() + 2000), endsAt: iso(clock.now() + 1000) }, 'ops'), code('INVALID_ARGUMENT'));
  assert.throws(() => s.service.createMaintenance({ title: 'x', monitors: ['nope'], startsAt: iso(clock.now()), endsAt: iso(clock.now() + 1000) }, 'ops'), code('MONITOR_NOT_FOUND'));
  const w = s.service.createMaintenance({ title: 'Database upgrade', message: 'Short interruptions', monitors: ['api'], startsAt: iso(clock.now() - 1000), endsAt: iso(clock.now() + 3_600_000) }, 'ops');
  await s.service.checkNow('api');
  assert.deepEqual([s.store.openAll().length, s.service.stateOf(s.service.get('api'))], [0, 'maintenance']);
  const page = /** @type {any} */ (s.service.publicSummary());
  assert.deepEqual([page.overall, page.maintenance[0].title, page.maintenance[0].active, page.monitors[0].state], ['maintenance', 'Database upgrade', true, 'maintenance']);
  s.service.deleteMaintenance(w.id);
  assert.throws(() => s.service.deleteMaintenance(w.id), code('MAINTENANCE_NOT_FOUND'));
  await s.service.checkNow('api');
  assert.equal(s.store.openAll().length, 1, 'outside the window the failure opens an incident');
});

test('incident updates: written updates appear on the public page; resolved closes the incident', async () => {
  const clock = manualClock();
  /** @type {string[]} */ const mails = [];
  const notifier = {
    incident: async (/** @type {string} */ ev) => { mails.push(`alert:${ev}`); },
    subscriberConfirm: async (/** @type {string} */ to, /** @type {string} */ link) => { mails.push(`confirm:${to}:${link}`); },
    subscriberIncident: async (/** @type {string} */ ev, /** @type {any} */ _i, /** @type {any} */ _m, /** @type {string} */ to, /** @type {string} */ unsub) => { mails.push(`sub:${ev}:${to}:${unsub}`); },
  };
  const s = testService({ STATUS_PUBLIC_URL: 'https://status.example.test' }, { now: clock.now, notifier });
  const url = 'https://api.example.com/health';
  s.service.put('api', { url, failThreshold: 1, public: true }, 'x');
  s.checker.results.set(url, [FAIL]);

  // subscriptions: double opt-in, confirmed subscribers hear about public monitors
  await s.service.subscribe('Reader@Example.com');
  const link = /** @type {string} */ (mails.find((m) => m.startsWith('confirm:'))).split(':').slice(2).join(':');
  assert.match(link, /^https:\/\/status\.example\.test\/status\/subscribe\/[A-Za-z0-9_-]{32}$/);
  assert.throws(() => s.service.confirmSubscriber('x'.repeat(32)), code('SUBSCRIBER_NOT_FOUND'));
  s.service.confirmSubscriber(/** @type {string} */ (link.split('/').pop()));
  assert.equal(s.store.subscriberCounts().confirmed, 1);
  await s.service.subscribe('reader@example.com');
  assert.equal(mails.filter((m) => m.startsWith('confirm:')).length, 1, 'an address already subscribed gets no second mail');

  await s.service.checkNow('api');
  const [open] = s.store.openAll();
  const subMail = /** @type {string} */ (mails.find((m) => m.startsWith('sub:opened:reader@example.com:')));
  assert.ok(subMail, 'the subscriber was told');
  await s.service.updateIncident(open.id, { status: 'identified', message: 'A bad deploy; rolling back.' }, 'ops');
  let page = /** @type {any} */ (s.service.publicSummary());
  assert.deepEqual(page.incidents[0].updates.map((/** @type {any} */ u) => [u.status, u.message]), [['identified', 'A bad deploy; rolling back.']]);
  await s.service.updateIncident(open.id, { status: 'resolved', message: 'Fixed.' }, 'ops');
  assert.notEqual(s.store.incident(open.id)?.closed_at, null, 'resolved closes the incident');
  assert.ok(mails.includes('alert:closed'));
  await assert.rejects(s.service.updateIncident('inc_x', { status: 'monitoring', message: 'x' }, 'ops'), code('INCIDENT_NOT_FOUND'));

  const subMails = mails.filter((m) => m.startsWith('sub:'));
  assert.deepEqual(subMails.map((m) => m.split(':').slice(3).join(':')), [subMails[0].split(':').slice(3).join(':'), subMails[0].split(':').slice(3).join(':')], 'the unsubscribe link stays the same in every mail');
  const unsub = subMail.split(':').slice(3).join(':').split('/').pop();
  s.service.unsubscribe(/** @type {string} */ (unsub));
  assert.equal(s.store.subscriberCounts().total, 0);
  page = /** @type {any} */ (s.service.publicSummary());
  assert.equal(page.subscribe, true);

  const off = testService();
  await assert.rejects(off.service.subscribe('a@b.co'), code('SUBSCRIPTIONS_DISABLED'));
});

test('HTTP: maintenance and update routes, the public subscription pages, the status page shows maintenance and the form', async (t) => {
  /** @type {string[]} */ const links = [];
  const notifier = { incident: async () => {}, subscriberConfirm: async (/** @type {string} */ _to, /** @type {string} */ link) => { links.push(link); }, subscriberIncident: async () => {} };
  const { app } = await buildApp({ STATUS_PUBLIC_URL: 'https://status.example.test' }, {}, { notifier });
  t.after(() => app.close());
  const h = { ...bearer(ADMIN_KEY), 'content-type': 'application/json' };
  let res = await app.inject({ method: 'POST', url: '/v1/maintenance', headers: h, payload: { title: 'Network work', startsAt: new Date(Date.now() - 1000).toISOString(), endsAt: new Date(Date.now() + 3_600_000).toISOString() } });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(res.json().maintenance.state, 'active');
  res = await app.inject({ url: '/v1/maintenance', headers: h });
  assert.equal(res.json().current.length, 1);
  const html = (await app.inject({ url: '/status' })).body;
  assert.match(html, /Network work/);
  assert.match(html, /<form class="sub" method="post" action="status\/subscribe">/);
  res = await app.inject({ method: 'POST', url: '/status/subscribe', payload: 'email=someone%40example.com', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Check your inbox/);
  const path = new URL(/** @type {string} */ (links[0])).pathname;
  const get = await app.inject({ url: path });
  assert.match(get.body, /<form method="post">/);
  res = await app.inject({ method: 'POST', url: path });
  assert.match(res.body, /Subscribed/);
  res = await app.inject({ url: '/v1/subscribers', headers: h });
  assert.deepEqual([res.json().counts.confirmed, res.json().items[0].email], [1, 'someone@example.com']);
  assert.equal((await app.inject({ method: 'POST', url: '/status/subscribe', payload: 'email=nope', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).statusCode, 400);
});
