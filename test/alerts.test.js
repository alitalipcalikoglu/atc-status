import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Signer } from '@atc-web/atc-service-core/http';
import { AlertService } from '../src/domain/alert-service.js';
import { ADMIN_KEY, READ_KEY, bearer, buildApp, manualClock, testService } from './helpers.js';

const SECRET = 'h'.repeat(40);
const code = (/** @type {string} */ c) => (/** @type {any} */ e) => e.code === c;
/** A webhook-out delivery body, signed the way webhook-out signs it. @param {string} type @param {object} data @param {string} [secret] @param {number} [t] */
const delivery = (type, data, secret = SECRET, t = 1_800_000_000) => {
  const body = JSON.stringify({ id: 'evt_1', type, createdAt: new Date().toISOString(), data });
  return { body, signature: Signer.sign(body, t, [secret]) };
};

test('alert hub: signed ops.* events become alerts, the first of a kind is e-mailed, repeats only count', async () => {
  const clock = manualClock();
  /** @type {string[]} */ const mails = [];
  const notifier = { incident: async () => {}, alert: async (/** @type {any} */ a) => { mails.push(`${a.severity}:${a.title}:${a.message}`); } };
  const t = testService({ ALERT_HOOK_SECRET: SECRET, ALERT_DEDUPE_MIN: '15' }, { now: clock.now, notifier });
  let d = delivery('ops.queue.dead_letter', { queue: 'emails', count: 3 });
  assert.deepEqual(await t.alerts.receive(d.body, d.signature).then((r) => r.outcome), 'alerted');
  assert.deepEqual(mails, ['warning:Messages moved to the dead-letter state:ops.queue.dead_letter (queue: emails, count: 3)']);
  clock.advance(60_000);
  d = delivery('ops.queue.dead_letter', { queue: 'emails', count: 5 });
  assert.equal((await t.alerts.receive(d.body, d.signature)).outcome, 'repeated');
  d = delivery('ops.queue.dead_letter', { queue: 'reports', count: 1 });
  assert.equal((await t.alerts.receive(d.body, d.signature)).outcome, 'alerted', 'another queue is another alert');
  assert.equal(mails.length, 2);
  const [open] = t.store.alerts({ state: 'open', limit: 10 }).filter((a) => a.dedupe_key === 'emails');
  assert.deepEqual([open.count, open.message.includes('count: 5')], [2, true]);
  const backup = delivery('ops.backup.failed', { source: 'atc-auth', error: 'disk full' });
  await t.alerts.receive(backup.body, backup.signature);
  assert.equal(mails.at(-1)?.startsWith('critical:Backup failed'), true);
  assert.deepEqual(t.store.alertCounts(), { open: 3, critical: 1 });
  t.alerts.ack(open.id, 'console');
  assert.equal(t.store.alertCounts().open, 2);
  clock.advance(60_000);
  d = delivery('ops.queue.dead_letter', { queue: 'emails', count: 1 });
  assert.equal((await t.alerts.receive(d.body, d.signature)).outcome, 'alerted', 'after an acknowledgement the next one is new again');
  const other = delivery('payment.created', { id: 'pay_1' });
  assert.deepEqual(await t.alerts.receive(other.body, other.signature), { outcome: 'ignored', id: null }, 'only ops.* events are alerts');
});

test('alert hub: bad signature, stale timestamp, wrong secret and a disabled hook are refused; a failed e-mail is recorded', async () => {
  const t = testService({ ALERT_HOOK_SECRET: SECRET }, { now: () => 1_800_000_000_000, notifier: { incident: async () => {}, alert: async () => { throw new Error('atc-notify responded 503'); } } });
  const good = delivery('ops.scheduler.job_failed', { job: 'nightly' });
  await assert.rejects(t.alerts.receive(good.body, undefined), code('INVALID_SIGNATURE'));
  await assert.rejects(t.alerts.receive(good.body.replace('nightly', 'other'), good.signature), code('INVALID_SIGNATURE'));
  const wrong = delivery('ops.scheduler.job_failed', { job: 'nightly' }, 'x'.repeat(40));
  await assert.rejects(t.alerts.receive(wrong.body, wrong.signature), code('INVALID_SIGNATURE'));
  const stale = delivery('ops.scheduler.job_failed', { job: 'nightly' }, SECRET, 1_800_000_000 - 3600);
  await assert.rejects(t.alerts.receive(stale.body, stale.signature), code('INVALID_SIGNATURE'));
  const r = await t.alerts.receive(good.body, good.signature);
  assert.equal(r.outcome, 'alerted', 'the alert exists even though the e-mail failed');
  assert.equal(t.store.alert(/** @type {string} */ (r.id))?.notify_error, 'atc-notify responded 503');
  const off = testService({}, { now: () => 1_800_000_000_000 });
  await assert.rejects(off.alerts.receive(good.body, good.signature), code('HOOK_DISABLED'));
  assert.equal(AlertService.keyOf({ subscription: 'x' }), 'x');
  assert.equal(AlertService.keyOf({}), '-');
});

test('API: the hook takes the raw signed body without a key; alerts are listed and acknowledged by admins', async (t) => {
  const { app } = await buildApp({ ALERT_HOOK_SECRET: SECRET });
  t.after(() => app.close());
  const d = delivery('ops.webhook.subscription_disabled', { subscription: 'shop-hook', failures: 10 }, SECRET, Math.floor(Date.now() / 1000));
  const hook = (/** @type {string} */ body, /** @type {string|undefined} */ sig) => app.inject({ method: 'POST', url: '/v1/hooks/webhook-out', payload: body, headers: { 'content-type': 'application/json', ...(sig ? { 'x-webhook-signature': sig } : {}) } });
  assert.equal((await hook(d.body, undefined)).statusCode, 400);
  const ok = await hook(d.body, d.signature);
  assert.deepEqual([ok.statusCode, JSON.parse(ok.body).outcome], [202, 'alerted']);
  const list = JSON.parse((await app.inject({ url: '/v1/alerts?state=open', headers: bearer(READ_KEY) })).body);
  assert.deepEqual([list.items.length, list.items[0].type, list.items[0].severity, list.items[0].key, list.items[0].data.failures], [1, 'ops.webhook.subscription_disabled', 'warning', 'shop-hook', 10]);
  assert.equal((await app.inject({ method: 'POST', url: `/v1/alerts/${list.items[0].id}/ack`, headers: bearer(READ_KEY) })).statusCode, 403);
  const ack = JSON.parse((await app.inject({ method: 'POST', url: `/v1/alerts/${list.items[0].id}/ack`, headers: bearer(ADMIN_KEY) })).body);
  assert.deepEqual([ack.alert.state, ack.alert.ackedBy], ['acked', 'console']);
  assert.equal(JSON.parse((await app.inject({ url: '/v1/alerts?state=open', headers: bearer(READ_KEY) })).body).items.length, 0);
  assert.equal(JSON.parse((await app.inject({ url: '/v1/stats', headers: bearer(READ_KEY) })).body).openAlerts, 0);
  assert.match((await app.inject({ url: '/metrics', headers: bearer(READ_KEY) })).body, /status_alerts_open\{severity="critical"\} 0/);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/alerts/alr_nope/ack', headers: bearer(ADMIN_KEY) })).statusCode, 400);
});
