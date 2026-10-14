import { createServer } from 'node:http';
import { NetGuard } from '@atc-web/atc-service-core/http';
import { readServiceVersion } from '@atc-web/atc-service-core/fastify';
import { Config } from '../src/config.js';
import { Database } from '../src/db.js';
import { AlertService } from '../src/domain/alert-service.js';
import { StatusService } from '../src/domain/status-service.js';
import { StatusApi } from '../src/http/status-api.js';
import { Checker } from '../src/net/checker.js';
import { StatusStore } from '../src/store/status-store.js';

export const ADMIN_KEY = 'a'.repeat(40);
export const READ_KEY = 'r'.repeat(40);

/** @param {Record<string, string>} [overrides] */
export function testEnv(overrides = {}) {
  return { PORT: '0', LOG_LEVEL: 'silent', DB_PATH: ':memory:', STATUS_API_KEYS: `console:${ADMIN_KEY}:admin,dash:${READ_KEY}:read`, STATUS_PAGE_CACHE_SEC: '0', ...overrides };
}

/** A clock tests move by hand. */
export function manualClock(start = 1_800_000_000_000) {
  const c = { t: start, now: () => c.t, advance: (/** @type {number} */ ms) => { c.t += ms; } };
  return c;
}

/**
 * A checker whose results tests script per URL: `results.set(url, [...])`; the last entry repeats.
 * @returns {Checker & { results: Map<string, import('../src/types.js').CheckResult[]>, calls: string[] }}
 */
export function scriptedChecker() {
  const c = /** @type {any} */ (new Checker({ guard: new NetGuard({}) }));
  c.results = new Map();
  c.calls = [];
  c.check = async (/** @type {any} */ m) => {
    c.calls.push(m.id);
    const list = c.results.get(m.url) ?? [{ ok: true, status: 200, latencyMs: 5, error: null }];
    return list.length > 1 ? list.shift() : list[0];
  };
  return c;
}

/** @param {Record<string, string>} [overrides] @param {{ now?: () => number, checker?: any, notifier?: any }} [o] */
export function testService(overrides, o = {}) {
  const config = Config.fromEnv(testEnv(overrides));
  const db = new Database(':memory:');
  const store = new StatusStore(db);
  const checker = o.checker ?? scriptedChecker();
  const service = new StatusService({ config, store, checker, notifier: o.notifier ?? null, now: o.now });
  const alerts = new AlertService({ config, store, notifier: o.notifier ?? null, now: o.now });
  return { config, db, store, service, alerts, checker };
}

/** @param {Record<string, string>} [overrides] @param {object} [deps] @param {{ now?: () => number, checker?: any, notifier?: any }} [o] */
export async function buildApp(overrides, deps = {}, o = {}) {
  const t = testService(overrides, o);
  const app = await new StatusApi({ ...t, version: readServiceVersion(import.meta.url), ...deps }).build();
  await app.ready();
  return { app, ...t };
}

/** @param {string} key */
export function bearer(key) {
  return { authorization: `Bearer ${key}` };
}

/**
 * A local HTTP server answering by path: `/ok` 200, `/fail` 503, `/slow` after 2 s, `/redirect` 302.
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
export async function targetServer() {
  const server = createServer((req, res) => {
    if (req.url === '/ok') return res.writeHead(200).end('fine');
    if (req.url === '/fail') return res.writeHead(503).end('down');
    if (req.url === '/redirect') return res.writeHead(302, { location: '/ok' }).end();
    if (req.url === '/slow') return setTimeout(() => res.writeHead(200).end(), 2_000).unref();
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
  return { url: `http://127.0.0.1:${addr.port}`, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r(undefined)); }) };
}
