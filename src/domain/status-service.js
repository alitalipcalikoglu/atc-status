import { randomBytes } from 'node:crypto';
import { StatusError } from './errors.js';

/** @typedef {import('../types.js').MonitorRow} MonitorRow */
/** @typedef {import('../types.js').IncidentRow} IncidentRow */
/** @typedef {import('../types.js').CheckResult} CheckResult */

/**
 * Monitor rules: due checks run with bounded concurrency; `failThreshold` failed checks in a row
 * open an incident (one per monitor at most); the first successful check closes it. Opening and
 * closing an incident e-mails ALERT_EMAILS through atc-notify when it is configured.
 */
export class StatusService {
  static ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
  static DEFAULTS = Object.freeze({ description: '', method: 'GET', intervalSec: 60, timeoutMs: 5_000, expectStatus: [200], failThreshold: 2, public: false, paused: false });
  static DAY = 86_400_000;

  /**
   * @param {object} deps
   * @param {import('../config.js').Config} deps.config
   * @param {import('../store/status-store.js').StatusStore} deps.store
   * @param {import('../net/checker.js').Checker} deps.checker
   * @param {import('../net/notifier.js').Notifier|null} [deps.notifier]
   * @param {() => number} [deps.now]
   * @param {import('../types.js').Logger} [deps.logger]
   */
  constructor({ config, store, checker, notifier = null, now = Date.now, logger }) {
    this.config = config;
    this.store = store;
    this.checker = checker;
    this.notifier = notifier;
    this.now = now;
    this.logger = logger;
    this.stopping = new AbortController();
    /** @type {Map<string, Promise<unknown>>} */
    this.inFlight = new Map();
    /** @type {{ at: number, value: unknown }|null} */
    this.pageCache = null;
  }

  /** Create the `<id>-health` / `<id>-ready` monitors of MONITOR_SEEDS; keep their URLs in step with the env. */
  seed() {
    const now = this.now();
    for (const s of this.config.seeds) {
      for (const kind of ['health', 'ready']) {
        const id = `${s.id}-${kind}`;
        const url = `${s.url}/${kind}`;
        const existing = this.store.monitor(id);
        if (!existing) {
          this.store.insert(/** @type {MonitorRow} */ ({
            id, name: `${s.id} ${kind}`, description: kind === 'health' ? 'Process is up' : 'Dependencies are ready', url, method: 'GET',
            interval_sec: this.config.limits.seedIntervalSec, timeout_ms: StatusService.DEFAULTS.timeoutMs, expect_status: '[200]', fail_threshold: StatusService.DEFAULTS.failThreshold,
            public: 1, paused: 0, origin: 'env', next_at: now, created_by: 'MONITOR_SEEDS', created_at: now, updated_at: now,
          }));
        } else if (existing.origin === 'env' && existing.url !== url) {
          this.store.update({ ...existing, url, next_at: now, updated_at: now });
        }
      }
    }
  }

  /** @returns {MonitorRow[]} */
  list() { return this.store.monitors(); }

  /** @param {string} id @returns {MonitorRow} */
  get(id) {
    const m = this.store.monitor(id);
    if (!m) throw new StatusError('MONITOR_NOT_FOUND', `no monitor "${id}"`);
    return m;
  }

  /**
   * Create or change a monitor. Omitted fields keep their value (defaults on create). A seeded
   * monitor's URL belongs to MONITOR_SEEDS and cannot be changed here.
   * @param {string} id
   * @param {{ name?: string, description?: string, url?: string, method?: 'GET'|'HEAD', intervalSec?: number, timeoutMs?: number, expectStatus?: number[], failThreshold?: number, public?: boolean, paused?: boolean }} body
   * @param {string} by
   * @returns {{ monitor: MonitorRow, created: boolean }}
   */
  put(id, body, by) {
    if (!StatusService.ID_PATTERN.test(id)) throw new StatusError('INVALID_ARGUMENT', 'id must be lowercase letters, digits and dashes');
    const existing = this.store.monitor(id);
    if (!existing && !body.url) throw new StatusError('INVALID_ARGUMENT', 'url is required for a new monitor');
    if (!existing && this.store.count() >= this.config.limits.maxMonitors) throw new StatusError('LIMIT_EXCEEDED', `at most ${this.config.limits.maxMonitors} monitors`);
    if (existing?.origin === 'env' && body.url !== undefined && body.url !== existing.url) throw new StatusError('INVALID_ARGUMENT', 'the URL of a monitor from MONITOR_SEEDS is set by that variable');
    if (body.url !== undefined && existing?.origin !== 'env') {
      try { this.checker.guard.check(body.url); } catch (err) { throw new StatusError('TARGET_NOT_ALLOWED', /** @type {Error} */ (err).message); }
    }
    const d = StatusService.DEFAULTS;
    const now = this.now();
    const interval = body.intervalSec ?? existing?.interval_sec ?? d.intervalSec;
    const timeout = body.timeoutMs ?? existing?.timeout_ms ?? d.timeoutMs;
    if (timeout > interval * 1000) throw new StatusError('INVALID_ARGUMENT', 'timeoutMs must not exceed the interval');
    const paused = body.paused ?? (existing ? existing.paused === 1 : d.paused);
    // Check soon after creating, unpausing or changing what or how often to check.
    const reschedule = !existing || (existing.paused === 1 && !paused) || (body.url !== undefined && body.url !== existing.url) || interval !== existing.interval_sec;
    /** @type {MonitorRow} */
    const m = /** @type {any} */ ({
      ...(existing ?? { origin: 'api', created_by: by, created_at: now }),
      id,
      name: body.name ?? existing?.name ?? id,
      description: body.description ?? existing?.description ?? d.description,
      url: body.url ?? existing?.url,
      method: body.method ?? existing?.method ?? d.method,
      interval_sec: interval,
      timeout_ms: timeout,
      expect_status: body.expectStatus ? JSON.stringify([...new Set(body.expectStatus)].sort((a, b) => a - b)) : existing?.expect_status ?? JSON.stringify(d.expectStatus),
      fail_threshold: body.failThreshold ?? existing?.fail_threshold ?? d.failThreshold,
      public: (body.public ?? (existing ? existing.public === 1 : d.public)) ? 1 : 0,
      paused: paused ? 1 : 0,
      next_at: reschedule ? now : /** @type {MonitorRow} */ (existing).next_at,
      updated_at: now,
    });
    if (existing) this.store.update(m); else this.store.insert(m);
    this.pageCache = null;
    return { monitor: this.get(id), created: !existing };
  }

  /** @param {string} id */
  delete(id) {
    const m = this.get(id);
    if (m.origin === 'env') throw new StatusError('INVALID_STATE', 'this monitor comes from MONITOR_SEEDS and would come back on restart; pause it instead');
    this.store.delete(id);
    this.pageCache = null;
  }

  /** Check one monitor now, paused or not. @param {string} id */
  async checkNow(id) {
    const m = this.get(id);
    const result = await this.#run(m);
    return { result, monitor: this.get(id) };
  }

  /** Start the checks that are due, within MAX_CONCURRENT. Resolves when the started checks finish. */
  runDue() {
    if (this.stopping.signal.aborted) return Promise.resolve();
    const free = this.config.limits.maxConcurrent - this.inFlight.size;
    if (free <= 0) return Promise.resolve();
    const now = this.now();
    /** @type {Promise<unknown>[]} */
    const started = [];
    for (const m of this.store.due(now, free + this.inFlight.size)) {
      if (started.length >= free) break;
      if (this.inFlight.has(m.id) || !this.store.claim(m, now + m.interval_sec * 1000)) continue;
      started.push(this.#run(m).catch((err) => this.logger?.error({ err, monitor: m.id }, 'check failed to run')));
    }
    return Promise.all(started);
  }

  /** Drop checks and closed incidents past their retention. */
  maintain() {
    const now = this.now();
    return {
      checks: this.store.pruneChecks(now - this.config.limits.checkRetentionDays * StatusService.DAY),
      incidents: this.store.pruneIncidents(now - this.config.limits.incidentRetentionDays * StatusService.DAY),
      alerts: this.store.alertsPrune(now - this.config.limits.incidentRetentionDays * StatusService.DAY),
    };
  }

  /** Resolves when every running check has finished. */
  async idle() {
    await Promise.allSettled([...this.inFlight.values()]);
  }

  /** @param {MonitorRow} m @returns {'up'|'down'|'degraded'|'unknown'|'paused'} */
  stateOf(m) {
    if (m.paused === 1) return 'paused';
    if (this.store.openOf(m.id)) return 'down';
    if (m.last_ok === null) return 'unknown';
    return m.last_ok === 1 ? 'up' : 'degraded';
  }

  /** Share of successful checks and mean latency over the last `days`. @param {string} id @param {number} days */
  uptime(id, days) {
    const w = this.store.window(id, this.now() - days * StatusService.DAY);
    return { checks: w.total, uptime: w.total ? Math.round((w.ok / w.total) * 100_000) / 1_000 : null, avgMs: w.avgMs };
  }

  stats() {
    const ms = this.list();
    /** @type {Record<string, number>} */
    const by = { up: 0, down: 0, degraded: 0, unknown: 0, paused: 0 };
    for (const m of ms) by[this.stateOf(m)]++;
    return { monitors: ms.length, ...by, openIncidents: this.store.openAll().length, incidents24h: this.store.incidentsSince(this.now() - StatusService.DAY), openAlerts: this.store.alertCounts().open, criticalAlerts: this.store.alertCounts().critical, notify: this.notifier !== null };
  }

  /**
   * The public status page data: public monitors only, by name; no URLs, no error texts.
   * Cached for STATUS_PAGE_CACHE_SEC.
   */
  publicSummary() {
    const now = this.now();
    if (this.pageCache && now - this.pageCache.at < this.config.page.cacheSec * 1000) return this.pageCache.value;
    const ms = this.list().filter((m) => m.public === 1);
    const ids = ms.map((m) => m.id);
    const names = new Map(ms.map((m) => [m.id, m.name]));
    const monitors = ms.map((m) => {
      const state = this.stateOf(m);
      return { name: m.name, state, uptime24h: this.uptime(m.id, 1).uptime, uptime7d: this.uptime(m.id, 7).uptime, latencyMs: m.last_ok === 1 ? m.last_latency_ms : null, checkedAt: m.last_check_at === null ? null : new Date(m.last_check_at).toISOString() };
    });
    const states = new Set(monitors.map((m) => m.state));
    const overall = states.has('down') ? 'outage' : states.has('degraded') ? 'degraded' : 'operational';
    const incidents = this.store.incidents({ monitors: ids, limit: 20 }).map((i) => ({
      monitor: names.get(i.monitor) ?? i.monitor, openedAt: new Date(i.opened_at).toISOString(), closedAt: i.closed_at === null ? null : new Date(i.closed_at).toISOString(),
      durationSec: Math.round(((i.closed_at ?? now) - i.opened_at) / 1000),
    }));
    const value = { title: this.config.page.title, overall, updatedAt: new Date(now).toISOString(), monitors, incidents };
    this.pageCache = { at: now, value };
    return value;
  }

  /** @param {MonitorRow} m @returns {Promise<CheckResult>} */
  #run(m) {
    const running = this.inFlight.get(m.id);
    if (running) return /** @type {Promise<CheckResult>} */ (running);
    const p = (async () => {
      try {
        const result = await this.checker.check(m);
        await this.#apply(m.id, result);
        return result;
      } finally {
        this.inFlight.delete(m.id);
      }
    })();
    this.inFlight.set(m.id, p);
    return p;
  }

  /** @param {string} id @param {CheckResult} r */
  async #apply(id, r) {
    const m = this.store.monitor(id);
    if (!m) return; // deleted while the check ran
    const at = this.now();
    const failures = r.ok ? 0 : m.consecutive_failures + 1;
    this.store.record(id, at, r, failures);
    const open = this.store.openOf(id);
    if (r.ok && open) {
      if (this.store.closeIncident(open.id, at)) await this.#notify('closed', /** @type {IncidentRow} */ (this.store.incident(open.id)), m);
    } else if (!r.ok && open) {
      this.store.failIncident(open.id, String(r.error));
    } else if (!r.ok && failures >= m.fail_threshold) {
      const incidentId = `inc_${at.toString(36)}${randomBytes(8).toString('hex')}`;
      this.store.openIncident(incidentId, id, at, String(r.error), failures);
      await this.#notify('opened', /** @type {IncidentRow} */ (this.store.incident(incidentId)), m);
    }
    this.pageCache = null;
  }

  /** @param {'opened'|'closed'} event @param {IncidentRow} incident @param {MonitorRow} m */
  async #notify(event, incident, m) {
    this.logger?.[event === 'opened' ? 'warn' : 'info']({ monitor: m.id, incident: incident.id }, `incident ${event}`);
    if (!this.notifier) return;
    try {
      await this.notifier.incident(event, incident, m);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.store.setNotifyError(incident.id, `${event}: ${message}`);
      this.logger?.warn({ incident: incident.id, error: message }, 'incident alert failed');
    }
  }
}
