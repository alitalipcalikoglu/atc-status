import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Notifier } from '../src/net/notifier.js';

test('notifier: generic e-mail per incident event with an idempotency key; errors carry the notify message', async () => {
  /** @type {any[]} */ const calls = [];
  const target = { url: 'http://notify.test', apiKey: 'n'.repeat(40), to: ['ops@example.com'], appName: 'Acme', timeoutMs: 1000 };
  const n = new Notifier(target, /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return new Response('{}', { status: 202 }); }));
  const incident = /** @type {any} */ ({ id: 'inc_x', opened_at: 0, closed_at: 125_000, cause: 'unexpected status 503', last_error: 'timed out', failures: 3 });
  const monitor = /** @type {any} */ ({ id: 'shop', name: 'Shop' });
  await n.incident('opened', { ...incident, closed_at: null }, monitor);
  await n.incident('closed', incident, monitor);
  assert.deepEqual(calls.map((c) => [c.url, c.init.headers.authorization, c.body.channel, c.body.template, c.body.to, c.body.idempotencyKey, c.body.data.subject]), [
    ['http://notify.test/v1/messages', `Bearer ${'n'.repeat(40)}`, 'email', 'generic', ['ops@example.com'], 'atc-status:inc_x:opened', 'DOWN: Shop'],
    ['http://notify.test/v1/messages', `Bearer ${'n'.repeat(40)}`, 'email', 'generic', ['ops@example.com'], 'atc-status:inc_x:closed', 'RECOVERED: Shop'],
  ]);
  assert.match(calls[1].body.data.paragraphs[0], /after 2m 5s/);
  const failing = new Notifier(target, /** @type {any} */ (async () => new Response(JSON.stringify({ error: { message: 'template not found' } }), { status: 422 })));
  await assert.rejects(failing.incident('opened', incident, monitor), /atc-notify: template not found/);
});
