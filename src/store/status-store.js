/** @typedef {import('../types.js').MonitorRow} MonitorRow */
/** @typedef {import('../types.js').CheckRow} CheckRow */
/** @typedef {import('../types.js').IncidentRow} IncidentRow */

/** SQLite statements for monitors, checks and incidents. The service owns the rules. */
export class StatusStore {
  /** @param {import('../db.js').Database} db */
  constructor(db) {
    const raw = db.raw;
    this.raw = raw;
    this.stmt = {
      monitor: raw.prepare('SELECT * FROM monitors WHERE id = ?'),
      monitors: raw.prepare('SELECT * FROM monitors ORDER BY id'),
      count: raw.prepare('SELECT COUNT(*) AS n FROM monitors'),
      insert: raw.prepare(`INSERT INTO monitors (id, name, description, url, method, interval_sec, timeout_ms, expect_status, fail_threshold, public, paused, origin, next_at, created_by, created_at, updated_at)
        VALUES (:id, :name, :description, :url, :method, :interval_sec, :timeout_ms, :expect_status, :fail_threshold, :public, :paused, :origin, :next_at, :created_by, :created_at, :updated_at)`),
      update: raw.prepare(`UPDATE monitors SET name = :name, description = :description, url = :url, method = :method, interval_sec = :interval_sec, timeout_ms = :timeout_ms,
        expect_status = :expect_status, fail_threshold = :fail_threshold, public = :public, paused = :paused, next_at = :next_at, updated_at = :updated_at WHERE id = :id`),
      delete: raw.prepare('DELETE FROM monitors WHERE id = ?'),
      due: raw.prepare('SELECT * FROM monitors WHERE paused = 0 AND next_at <= ? ORDER BY next_at LIMIT ?'),
      claim: raw.prepare('UPDATE monitors SET next_at = ? WHERE id = ? AND next_at = ?'),
      result: raw.prepare('UPDATE monitors SET consecutive_failures = ?, last_check_at = ?, last_ok = ?, last_status = ?, last_latency_ms = ?, last_error = ? WHERE id = ?'),
      insertCheck: raw.prepare('INSERT INTO checks (monitor, at, ok, status, latency_ms, error) VALUES (?, ?, ?, ?, ?, ?)'),
      checks: raw.prepare('SELECT * FROM checks WHERE monitor = ? AND seq < ? ORDER BY seq DESC LIMIT ?'),
      window: raw.prepare('SELECT COUNT(*) AS total, SUM(ok) AS ok, AVG(CASE WHEN ok = 1 THEN latency_ms END) AS avg_ms FROM checks WHERE monitor = ? AND at >= ?'),
      pruneChecks: raw.prepare('DELETE FROM checks WHERE at < ?'),
      openOf: raw.prepare('SELECT * FROM incidents WHERE monitor = ? AND closed_at IS NULL'),
      openAll: raw.prepare('SELECT * FROM incidents WHERE closed_at IS NULL ORDER BY opened_at DESC'),
      incident: raw.prepare('SELECT * FROM incidents WHERE id = ?'),
      openIncident: raw.prepare('INSERT INTO incidents (id, monitor, opened_at, cause, last_error, failures) VALUES (?, ?, ?, ?, ?, ?)'),
      failIncident: raw.prepare('UPDATE incidents SET failures = failures + 1, last_error = ? WHERE id = ?'),
      closeIncident: raw.prepare('UPDATE incidents SET closed_at = ? WHERE id = ? AND closed_at IS NULL'),
      notifyError: raw.prepare('UPDATE incidents SET notify_error = ? WHERE id = ?'),
      pruneIncidents: raw.prepare('DELETE FROM incidents WHERE closed_at IS NOT NULL AND closed_at < ?'),
      since: raw.prepare('SELECT COUNT(*) AS n FROM incidents WHERE opened_at >= ?'),
    };
  }

  /** @param {string} id @returns {MonitorRow|undefined} */
  monitor(id) { return /** @type {any} */ (this.stmt.monitor.get(id)); }
  /** @returns {MonitorRow[]} */
  monitors() { return /** @type {any} */ (this.stmt.monitors.all()); }
  count() { return Number(this.stmt.count.get()?.n ?? 0); }
  /** @param {MonitorRow} m */
  insert(m) { this.stmt.insert.run(/** @type {any} */ (StatusStore.#named(m, ['id', 'name', 'description', 'url', 'method', 'interval_sec', 'timeout_ms', 'expect_status', 'fail_threshold', 'public', 'paused', 'origin', 'next_at', 'created_by', 'created_at', 'updated_at']))); }
  /** @param {MonitorRow} m */
  update(m) { this.stmt.update.run(/** @type {any} */ (StatusStore.#named(m, ['id', 'name', 'description', 'url', 'method', 'interval_sec', 'timeout_ms', 'expect_status', 'fail_threshold', 'public', 'paused', 'next_at', 'updated_at']))); }
  /** @param {string} id */
  delete(id) { this.stmt.delete.run(id); }

  /** @param {number} now @param {number} limit @returns {MonitorRow[]} */
  due(now, limit) { return /** @type {any} */ (this.stmt.due.all(now, limit)); }
  /** Move `next_at` forward unless someone else already did. @param {MonitorRow} m @param {number} next */
  claim(m, next) { return Number(this.stmt.claim.run(next, m.id, m.next_at).changes) === 1; }

  /**
   * Record one check and the monitor's new state in one transaction.
   * @param {string} monitor @param {number} at @param {import('../types.js').CheckResult} r @param {number} failures
   */
  record(monitor, at, r, failures) {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      this.stmt.insertCheck.run(monitor, at, r.ok ? 1 : 0, r.status, r.latencyMs, r.error);
      this.stmt.result.run(failures, at, r.ok ? 1 : 0, r.status, r.latencyMs, r.error, monitor);
      this.raw.exec('COMMIT');
    } catch (err) {
      this.raw.exec('ROLLBACK');
      throw err;
    }
  }

  /** Newest first. @param {string} monitor @param {number} before @param {number} limit @returns {CheckRow[]} */
  checks(monitor, before, limit) { return /** @type {any} */ (this.stmt.checks.all(monitor, before, limit)); }

  /** @param {string} monitor @param {number} since */
  window(monitor, since) {
    const r = this.stmt.window.get(monitor, since);
    const total = Number(r?.total ?? 0);
    return { total, ok: Number(r?.ok ?? 0), avgMs: r?.avg_ms === null || r?.avg_ms === undefined ? null : Math.round(Number(r.avg_ms)) };
  }

  /** @param {number} cutoff */
  pruneChecks(cutoff) { return Number(this.stmt.pruneChecks.run(cutoff).changes); }

  /** @param {string} monitor @returns {IncidentRow|undefined} */
  openOf(monitor) { return /** @type {any} */ (this.stmt.openOf.get(monitor)); }
  /** @returns {IncidentRow[]} */
  openAll() { return /** @type {any} */ (this.stmt.openAll.all()); }
  /** @param {string} id @returns {IncidentRow|undefined} */
  incident(id) { return /** @type {any} */ (this.stmt.incident.get(id)); }
  /** @param {string} id @param {string} monitor @param {number} at @param {string} cause @param {number} failures */
  openIncident(id, monitor, at, cause, failures) { this.stmt.openIncident.run(id, monitor, at, cause, cause, failures); }
  /** @param {string} id @param {string} error */
  failIncident(id, error) { this.stmt.failIncident.run(error, id); }
  /** @param {string} id @param {number} at */
  closeIncident(id, at) { return Number(this.stmt.closeIncident.run(at, id).changes) === 1; }
  /** @param {string} id @param {string|null} error */
  setNotifyError(id, error) { this.stmt.notifyError.run(error ? error.slice(0, 500) : null, id); }
  /** @param {number} cutoff */
  pruneIncidents(cutoff) { return Number(this.stmt.pruneIncidents.run(cutoff).changes); }
  /** @param {number} since */
  incidentsSince(since) { return Number(this.stmt.since.get(since)?.n ?? 0); }

  /**
   * Newest first, keyset paged on (opened_at, id).
   * @param {{ monitor?: string, monitors?: string[], state?: 'open'|'closed', before?: { at: number, id: string }, limit: number }} q
   * @returns {IncidentRow[]}
   */
  incidents(q) {
    /** @type {string[]} */ const where = [];
    /** @type {(string|number)[]} */ const args = [];
    if (q.monitor) { where.push('monitor = ?'); args.push(q.monitor); }
    if (q.monitors) { where.push(`monitor IN (${q.monitors.map(() => '?').join(', ') || 'NULL'})`); args.push(...q.monitors); }
    if (q.state === 'open') where.push('closed_at IS NULL');
    if (q.state === 'closed') where.push('closed_at IS NOT NULL');
    if (q.before) { where.push('(opened_at < ? OR (opened_at = ? AND id < ?))'); args.push(q.before.at, q.before.at, q.before.id); }
    // Dynamic WHERE: prepared per call, never cached.
    return /** @type {any} */ (this.raw.prepare(`SELECT * FROM incidents ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY opened_at DESC, id DESC LIMIT ?`).all(...args, q.limit));
  }

  /** @param {Record<string, any>} o @param {string[]} keys */
  static #named(o, keys) {
    return Object.fromEntries(keys.map((k) => [k, o[k]]));
  }
}
