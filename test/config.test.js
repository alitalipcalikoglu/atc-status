import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Config, ConfigError } from '../src/config.js';
import { testEnv } from './helpers.js';

test('Config: defaults, roles, seeds, notify', () => {
  const c = Config.fromEnv(testEnv({ PORT: '', MONITOR_SEEDS: 'atc-auth=http://127.0.0.1:3002/,atc-media=https://media.example.com' }));
  assert.equal(c.port, 3018);
  assert.deepEqual(c.apiKeys.map((k) => [k.id, k.role]), [['console', 'admin'], ['dash', 'read']]);
  assert.deepEqual(c.seeds, [{ id: 'atc-auth', url: 'http://127.0.0.1:3002' }, { id: 'atc-media', url: 'https://media.example.com' }]);
  assert.deepEqual([c.notify, c.target.allowHttp, c.target.allowPrivate, c.limits.maxConcurrent, c.limits.seedIntervalSec], [null, false, false, 8, 60]);
  const n = Config.fromEnv(testEnv({ NOTIFY_URL: 'http://notify:3001/', NOTIFY_API_KEY: 'n'.repeat(40), ALERT_EMAILS: 'ops@example.com, oncall@example.com' }));
  assert.deepEqual([n.notify?.url, n.notify?.to, n.notify?.appName], ['http://notify:3001', ['ops@example.com', 'oncall@example.com'], 'atc-web']);
});

test('Config: rejects bad input', () => {
  const bad = (/** @type {Record<string,string>} */ o, /** @type {RegExp} */ re) => assert.throws(() => Config.fromEnv(testEnv(o)), (e) => e instanceof ConfigError && re.test(e.message));
  bad({ STATUS_API_KEYS: '' }, /STATUS_API_KEYS is required/);
  bad({ STATUS_API_KEYS: `a:${'a'.repeat(40)}:write` }, /must be read or admin/);
  bad({ MONITOR_SEEDS: 'Auth=http://x' }, /lowercase id/);
  bad({ MONITOR_SEEDS: 'a=ftp://x' }, /http\(s\) base URL/);
  bad({ MONITOR_SEEDS: 'a=http://u:p@x' }, /without credentials/);
  bad({ MONITOR_SEEDS: 'a=http://x,a=http://y' }, /listed twice/);
  bad({ NOTIFY_URL: 'http://n' }, /must be set together/);
  bad({ NOTIFY_URL: 'http://n', NOTIFY_API_KEY: 'n'.repeat(40) }, /ALERT_EMAILS is required/);
  bad({ NOTIFY_URL: 'http://n', NOTIFY_API_KEY: 'n'.repeat(40), ALERT_EMAILS: 'nope' }, /not an e-mail/);
  bad({ TARGET_ALLOW_PRIVATE: 'true' }, /TARGET_ALLOWED_HOSTS is required/);
  bad({ TLS_KEY_PATH: '/k.pem' }, /must be set together/);
});

test('Config: ALERT_EMAILS is capped at the notify recipient limit', () => {
  const many = Array.from({ length: 11 }, (_, i) => `u${i}@example.com`).join(',');
  assert.throws(() => Config.fromEnv(testEnv({ NOTIFY_URL: 'http://n', NOTIFY_API_KEY: 'n'.repeat(40), ALERT_EMAILS: many })), (e) => e instanceof ConfigError && /at most 10/.test(e.message));
  assert.equal(Config.fromEnv(testEnv({ NOTIFY_URL: 'http://n', NOTIFY_API_KEY: 'n'.repeat(40), ALERT_EMAILS: many.split(',').slice(0, 10).join(',') })).notify?.to.length, 10);
});

test('Config: ALERT_HOOK_SECRET needs 32 characters; empty disables the hook', () => {
  assert.equal(Config.fromEnv(testEnv()).alertHookSecret, null);
  assert.equal(Config.fromEnv(testEnv({ ALERT_HOOK_SECRET: 'h'.repeat(40) })).alertHookSecret, 'h'.repeat(40));
  assert.throws(() => Config.fromEnv(testEnv({ ALERT_HOOK_SECRET: 'short' })), ConfigError);
  assert.equal(Config.fromEnv(testEnv()).alertDedupeMin, 15);
});
