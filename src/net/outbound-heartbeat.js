/**
 * Dead man's switch for the status service itself: GET a URL every `intervalSec` (a healthchecks-style
 * ping on a host that is not this one). If this service or its host stops, the pings stop and the
 * external monitor alerts, which nothing inside the stack can do. Failures are logged and counted, never thrown.
 */
export class OutboundHeartbeat {
  /**
   * @param {object} o
   * @param {string} o.url  Operator configuration: no SSRF guard.
   * @param {number} o.intervalSec
   * @param {number} [o.timeoutMs]
   * @param {typeof fetch} [o.fetchImpl]
   */
  constructor({ url, intervalSec, timeoutMs = 5_000, fetchImpl = fetch }) {
    this.url = url;
    this.intervalSec = intervalSec;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
    this.stats = { ok: 0, failed: 0 };
    /** @type {{ warn: Function }|undefined} */
    this.logger = undefined;
    /** @type {NodeJS.Timeout|null} */
    this.timer = null;
  }

  /** One ping. Resolves true when the URL answered 2xx. */
  async ping() {
    try {
      const res = await this.fetch(this.url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs), headers: { 'user-agent': 'atc-status/1.0' } });
      await res.arrayBuffer().catch(() => {});
      if (!res.ok) throw new Error(`answered ${res.status}`);
      this.stats.ok += 1;
      return true;
    } catch (err) {
      this.stats.failed += 1;
      this.logger?.warn({ err: err instanceof Error ? err.message : String(err) }, 'outbound heartbeat failed');
      return false;
    }
  }

  start() {
    void this.ping();
    this.timer = setInterval(() => { void this.ping(); }, this.intervalSec * 1000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** @returns {string[]} */
  metricLines() {
    return [
      '# HELP status_heartbeat_out_total Pings of HEARTBEAT_URL by outcome.',
      '# TYPE status_heartbeat_out_total counter',
      `status_heartbeat_out_total{result="ok"} ${this.stats.ok}`,
      `status_heartbeat_out_total{result="failed"} ${this.stats.failed}`,
    ];
  }
}
