import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { CallError, HttpCaller, NetGuard } from '@atc-web/atc-service-core/http';

/** @typedef {import('../types.js').MonitorRow} MonitorRow */
/** @typedef {import('../types.js').CheckResult} CheckResult */

/**
 * Performs one check, by the monitor's kind:
 * - `http`: a request; the status must be expected and, with `expect_text`, the first KiB of the body must contain the text.
 * - `tcp`: the port accepts a connection.
 * - `tls`: the handshake succeeds with a valid certificate that does not expire within `warn_days`.
 * - `heartbeat`: a ping arrived within interval plus grace (nothing is contacted).
 * Targets of monitors created through the API pass the SSRF guard (TARGET_* rules); monitors seeded
 * from MONITOR_SEEDS are operator configuration and may reach private addresses. The vetted address is
 * pinned for the connection; redirects are not followed; the whole check is bounded by the monitor's timeout.
 */
export class Checker {
  static USER_AGENT = 'atc-status/1.0';
  static DAY = 86_400_000;

  /**
   * @param {object} o
   * @param {NetGuard} o.guard     For API monitors.
   * @param {NetGuard} [o.trusted] For seeded monitors.
   * @param {(target: any, method: string, headers: Record<string, string>, body: string, timeoutMs: number, label?: string) => Promise<{ httpStatus: number, response?: string }>} [o.send]
   * @param {import('node:tls').ConnectionOptions} [o.tlsOptions]  Extra TLS options (tests pass a private CA).
   * @param {() => number} [o.now]
   */
  constructor({ guard, trusted = new NetGuard({ allowHttp: true, allowPrivate: true }), send = HttpCaller.send, tlsOptions = {}, now = Date.now }) {
    this.guard = guard;
    this.trusted = trusted;
    this.send = send;
    this.tlsOptions = tlsOptions;
    this.now = now;
  }

  /** @param {MonitorRow} m @returns {Promise<CheckResult>} */
  async check(m) {
    const started = performance.now();
    /** @type {{ ok: boolean, status: number|null, error: string|null }} */
    let r;
    if (m.kind === 'heartbeat') r = this.#heartbeat(m);
    else {
      /** @type {NodeJS.Timeout|undefined} */ let timer;
      try {
        const vetted = await (m.origin === 'env' ? this.trusted : this.guard).resolve(m.url);
        const hard = new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new CallError(`timed out after ${m.timeout_ms}ms`, { retryable: true, code: 'TIMEOUT' })), m.timeout_ms); });
        r = await Promise.race([m.kind === 'tcp' ? this.#tcp(vetted, m.timeout_ms) : m.kind === 'tls' ? this.#tls(vetted, m) : this.#http(vetted, m), hard]);
      } catch (err) {
        r = { ok: false, status: null, error: String(/** @type {Error} */ (err).message ?? err).slice(0, 300) };
      } finally {
        clearTimeout(timer);
      }
    }
    return { ...r, latencyMs: Math.round(performance.now() - started) };
  }

  /** @param {MonitorRow} m */
  #heartbeat(m) {
    const since = m.last_ping_at ?? m.created_at;
    const late = this.now() - since - (m.interval_sec + (m.grace_sec ?? 0)) * 1000;
    if (late <= 0) return { ok: true, status: null, error: null };
    return { ok: false, status: null, error: m.last_ping_at === null ? 'no ping received yet' : `no ping for ${Math.round((this.now() - since) / 1000)}s (expected every ${m.interval_sec}s)` };
  }

  /** @param {import('@atc-web/atc-service-core/http').VettedTarget} vetted @param {MonitorRow} m */
  async #http(vetted, m) {
    const expect = /** @type {number[]} */ (JSON.parse(m.expect_status));
    /** @type {number|null} */ let status = null;
    let snippet = '';
    let error = null;
    try {
      const res = await this.send(vetted, m.method, { accept: '*/*', 'user-agent': Checker.USER_AGENT, 'content-length': '0' }, '', m.timeout_ms, 'monitor');
      status = res.httpStatus;
      snippet = res.response ?? '';
    } catch (err) {
      const e = /** @type {{ httpStatus?: number|null, response?: string, message?: string }} */ (err);
      if (typeof e.httpStatus === 'number') { status = e.httpStatus; snippet = e.response ?? ''; } else error = String(e.message ?? err).slice(0, 300);
    }
    let ok = status !== null && expect.includes(status);
    if (!ok && error === null) error = `unexpected status ${status}`;
    if (ok && m.expect_text && !snippet.includes(m.expect_text)) { ok = false; error = 'expected text not found in the response'; }
    return { ok, status, error };
  }

  /** @param {import('@atc-web/atc-service-core/http').VettedTarget} vetted @param {number} timeoutMs @returns {Promise<{ ok: boolean, status: null, error: string|null }>} */
  #tcp(vetted, timeoutMs) {
    return new Promise((resolve) => {
      const socket = netConnect({ host: vetted.address, port: Number(vetted.url.port) || 443, family: vetted.family });
      const done = (/** @type {string|null} */ error) => { socket.destroy(); resolve({ ok: error === null, status: null, error }); };
      socket.setTimeout(timeoutMs, () => done(`timed out after ${timeoutMs}ms`));
      socket.once('connect', () => done(null));
      socket.once('error', (err) => done(`connection failed: ${err.message}`.slice(0, 300)));
    });
  }

  /** @param {import('@atc-web/atc-service-core/http').VettedTarget} vetted @param {MonitorRow} m @returns {Promise<{ ok: boolean, status: null, error: string|null }>} */
  #tls(vetted, m) {
    return new Promise((resolve) => {
      const socket = tlsConnect({ host: vetted.address, port: Number(vetted.url.port) || 443, servername: vetted.url.hostname.replace(/^\[|\]$/g, ''), ...this.tlsOptions });
      const done = (/** @type {string|null} */ error) => { socket.destroy(); resolve({ ok: error === null, status: null, error }); };
      socket.setTimeout(m.timeout_ms, () => done(`timed out after ${m.timeout_ms}ms`));
      socket.once('secureConnect', () => {
        const left = Math.floor((Date.parse(socket.getPeerCertificate().valid_to) - this.now()) / Checker.DAY);
        if (!socket.authorized) done(`certificate rejected: ${socket.authorizationError}`.slice(0, 300));
        else if (Number.isNaN(left)) done('certificate has no expiry date');
        else if (left < (m.warn_days ?? 14)) done(left < 0 ? 'certificate has expired' : `certificate expires in ${left} days`);
        else done(null);
      });
      socket.once('error', (err) => done(`handshake failed: ${err.message}`.slice(0, 300)));
    });
  }
}
