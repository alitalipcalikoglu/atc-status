import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AuditClient } from '@atc-web/atc-service-core/audit';
import { ADMIN_KEY, READ_KEY, bearer, buildApp } from './helpers.js';

const silent = { warn() {}, error() {} };

test('API: monitor changes and deletes are audit events; checks and reads are not', async (t) => {
  const audit = new AuditClient({ target: { url: 'http://audit.test', apiKey: 'a'.repeat(40) }, logger: silent, fetch: async () => new Response('{}', { status: 200 }) });
  const { app } = await buildApp(undefined, { audit });
  t.after(() => app.close());
  const a = { ...bearer(ADMIN_KEY), 'user-agent': 'test-agent' };
  await app.inject({ method: 'PUT', url: '/v1/monitors/web', headers: a, payload: { url: 'https://web.example.com' } });
  await app.inject({ method: 'PUT', url: '/v1/monitors/web', headers: a, payload: { paused: true } });
  await app.inject({ method: 'POST', url: '/v1/monitors/web/check', headers: a });
  await app.inject({ url: '/v1/monitors', headers: a });
  await app.inject({ method: 'DELETE', url: '/v1/monitors/web', headers: a });
  assert.deepEqual(audit.buffer.map((e) => e.action), ['atc-status.monitor.upsert', 'atc-status.monitor.upsert', 'atc-status.monitor.delete']);
  const [created, paused, del] = audit.buffer;
  assert.deepEqual([created.actor, created.target, created.meta, paused.meta, del.target], [{ type: 'apikey', id: 'console' }, { type: 'monitor', id: 'web' }, { created: true, settings: { url: 'https://web.example.com' } }, { created: false, settings: { paused: true } }, { type: 'monitor', id: 'web' }]);
  const n = audit.buffer.length;
  assert.equal((await app.inject({ method: 'PUT', url: '/v1/monitors/x', headers: bearer(READ_KEY), payload: {} })).statusCode, 403);
  assert.deepEqual([audit.buffer.length, audit.buffer.at(-1)?.outcome], [n + 1, 'denied']);
});
