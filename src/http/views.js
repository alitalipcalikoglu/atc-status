/** Response shapes. */
export class Views {
  /** @param {number|null|undefined} t */
  static iso(t) {
    return t === null || t === undefined ? null : new Date(Number(t)).toISOString();
  }

  /**
   * @param {import('../types.js').MonitorRow} m
   * @param {import('../domain/status-service.js').StatusService} s
   */
  static monitor(m, s) {
    const day = s.uptime(m.id, 1);
    return {
      id: m.id, name: m.name, description: m.description, url: m.url, method: m.method, intervalSec: Number(m.interval_sec), timeoutMs: Number(m.timeout_ms),
      expectStatus: JSON.parse(m.expect_status), failThreshold: Number(m.fail_threshold), public: m.public === 1, paused: m.paused === 1, origin: m.origin,
      state: s.stateOf(m), consecutiveFailures: Number(m.consecutive_failures),
      lastCheck: m.last_check_at === null ? null : { at: Views.iso(m.last_check_at), ok: m.last_ok === 1, status: m.last_status, latencyMs: m.last_latency_ms, error: m.last_error },
      nextCheckAt: m.paused === 1 ? null : Views.iso(m.next_at), uptime24h: day.uptime, avgLatency24hMs: day.avgMs,
      createdBy: m.created_by, createdAt: Views.iso(m.created_at), updatedAt: Views.iso(m.updated_at),
    };
  }

  /** @param {import('../types.js').CheckRow} c */
  static check(c) {
    return { at: Views.iso(c.at), ok: c.ok === 1, status: c.status, latencyMs: Number(c.latency_ms), error: c.error };
  }

  /** @param {import('../types.js').IncidentRow} i @param {number} now */
  static incident(i, now) {
    return {
      id: i.id, monitor: i.monitor, state: i.closed_at === null ? 'open' : 'closed', openedAt: Views.iso(i.opened_at), closedAt: Views.iso(i.closed_at),
      durationSec: Math.round(((i.closed_at ?? now) - i.opened_at) / 1000), cause: i.cause, lastError: i.last_error, failures: Number(i.failures), notifyError: i.notify_error,
    };
  }
}
