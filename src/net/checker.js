import { CallError, HttpCaller, NetGuard } from '@atc-web/atc-service-core/http';

/** @typedef {import('../types.js').MonitorRow} MonitorRow */
/** @typedef {import('../types.js').CheckResult} CheckResult */

/**
 * Performs one HTTP check. Monitors created through the API pass the SSRF guard (TARGET_* rules);
 * monitors seeded from MONITOR_SEEDS are operator configuration and may reach private addresses.
 * The vetted address is pinned for the connection; redirects are not followed; the whole check
 * is bounded by the monitor's timeout.
 */
export class Checker {
  static USER_AGENT = 'atc-status/1.0';

  /**
   * @param {object} o
   * @param {NetGuard} o.guard     For API monitors.
   * @param {NetGuard} [o.trusted] For seeded monitors.
   * @param {(target: any, method: string, headers: Record<string, string>, body: string, timeoutMs: number, label?: string) => Promise<{ httpStatus: number }>} [o.send]
   */
  constructor({ guard, trusted = new NetGuard({ allowHttp: true, allowPrivate: true }), send = HttpCaller.send }) {
    this.guard = guard;
    this.trusted = trusted;
    this.send = send;
  }

  /** @param {MonitorRow} m @returns {Promise<CheckResult>} */
  async check(m) {
    const started = performance.now();
    const expect = /** @type {number[]} */ (JSON.parse(m.expect_status));
    /** @type {number|null} */ let status = null;
    /** @type {string|null} */ let error = null;
    /** @type {NodeJS.Timeout|undefined} */ let timer;
    try {
      const vetted = await (m.origin === 'env' ? this.trusted : this.guard).resolve(m.url);
      const hard = new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new CallError(`timed out after ${m.timeout_ms}ms`, { retryable: true, code: 'TIMEOUT' })), m.timeout_ms); });
      const res = await Promise.race([this.send(vetted, m.method, { accept: '*/*', 'user-agent': Checker.USER_AGENT, 'content-length': '0' }, '', m.timeout_ms, 'monitor'), hard]);
      status = res.httpStatus;
    } catch (err) {
      const e = /** @type {{ httpStatus?: number|null, message?: string }} */ (err);
      if (typeof e.httpStatus === 'number') status = e.httpStatus;
      else error = String(e.message ?? err).slice(0, 300);
    } finally {
      clearTimeout(timer);
    }
    const ok = status !== null && expect.includes(status);
    if (!ok && error === null) error = `unexpected status ${status}`;
    return { ok, status, latencyMs: Math.round(performance.now() - started), error };
  }
}
