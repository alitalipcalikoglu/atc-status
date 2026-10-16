import { randomBytes } from 'node:crypto';

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
      insert: raw.prepare(`INSERT INTO monitors (id, name, description, kind, dns_type, url, method, expect_text, warn_days, grace_sec, ping_hash, interval_sec, timeout_ms, expect_status, fail_threshold, public, paused, origin, next_at, created_by, created_at, updated_at)
        VALUES (:id, :name, :description, :kind, :dns_type, :url, :method, :expect_text, :warn_days, :grace_sec, :ping_hash, :interval_sec, :timeout_ms, :expect_status, :fail_threshold, :public, :paused, :origin, :next_at, :created_by, :created_at, :updated_at)`),
      update: raw.prepare(`UPDATE monitors SET name = :name, description = :description, dns_type = :dns_type, url = :url, method = :method, expect_text = :expect_text, warn_days = :warn_days, grace_sec = :grace_sec, ping_hash = :ping_hash, interval_sec = :interval_sec, timeout_ms = :timeout_ms,
        expect_status = :expect_status, fail_threshold = :fail_threshold, public = :public, paused = :paused, next_at = :next_at, updated_at = :updated_at WHERE id = :id`),
      delete: raw.prepare('DELETE FROM monitors WHERE id = ?'),
      ping: raw.prepare('UPDATE monitors SET last_ping_at = ? WHERE id = ?'),
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
      alert: raw.prepare('SELECT * FROM alerts WHERE id = ?'),
      alertRecent: raw.prepare('SELECT * FROM alerts WHERE type = ? AND dedupe_key = ? AND last_at >= ? ORDER BY last_at DESC LIMIT 1'),
      alertInsert: raw.prepare('INSERT INTO alerts (id, type, dedupe_key, severity, title, message, data, source, count, first_at, last_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)'),
      alertBump: raw.prepare('UPDATE alerts SET count = count + 1, last_at = ?, message = ?, data = ? WHERE id = ?'),
      alertAck: raw.prepare('UPDATE alerts SET acked_at = ?, acked_by = ? WHERE id = ? AND acked_at IS NULL'),
      alertNotify: raw.prepare('UPDATE alerts SET notify_error = ? WHERE id = ?'),
      alertOpen: raw.prepare('SELECT COUNT(*) AS n, SUM(CASE WHEN severity = \'critical\' THEN 1 ELSE 0 END) AS critical FROM alerts WHERE acked_at IS NULL'),
      alertPrune: raw.prepare('DELETE FROM alerts WHERE acked_at IS NOT NULL AND acked_at < ?'),
      since: raw.prepare('SELECT COUNT(*) AS n FROM incidents WHERE opened_at >= ?'),
      maintInsert: raw.prepare('INSERT INTO maintenance (id, title, message, monitors, starts_at, ends_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
      maintGet: raw.prepare('SELECT * FROM maintenance WHERE id = ?'),
      maintDelete: raw.prepare('DELETE FROM maintenance WHERE id = ?'),
      maintCurrent: raw.prepare('SELECT * FROM maintenance WHERE ends_at > ? ORDER BY starts_at, id'),
      maintRecent: raw.prepare('SELECT * FROM maintenance WHERE ends_at > ? ORDER BY starts_at DESC, id LIMIT ?'),
      maintPrune: raw.prepare('DELETE FROM maintenance WHERE ends_at < ?'),
      updInsert: raw.prepare('INSERT INTO incident_updates (incident, at, status, message, by) VALUES (?, ?, ?, ?, ?)'),
      updOf: raw.prepare('SELECT * FROM incident_updates WHERE incident = ? ORDER BY seq'),
      subByEmail: raw.prepare('SELECT * FROM subscribers WHERE email = ?'),
      subByToken: raw.prepare('SELECT * FROM subscribers WHERE token_hash = ?'),
      subInsert: raw.prepare('INSERT INTO subscribers (id, email, token_hash, unsub_token, confirmed_at, created_at) VALUES (?, ?, ?, ?, NULL, ?)'),
      subByUnsub: raw.prepare('SELECT * FROM subscribers WHERE unsub_token = ?'),
      subToken: raw.prepare('UPDATE subscribers SET token_hash = ? WHERE id = ?'),
      subConfirm: raw.prepare('UPDATE subscribers SET confirmed_at = ? WHERE id = ? AND confirmed_at IS NULL'),
      subDelete: raw.prepare('DELETE FROM subscribers WHERE id = ?'),
      subConfirmed: raw.prepare('SELECT * FROM subscribers WHERE confirmed_at IS NOT NULL ORDER BY created_at'),
      subAll: raw.prepare('SELECT * FROM subscribers WHERE id < ? ORDER BY id DESC LIMIT ?'),
      subCount: raw.prepare('SELECT COUNT(*) AS n, SUM(CASE WHEN confirmed_at IS NOT NULL THEN 1 ELSE 0 END) AS confirmed FROM subscribers'),
      subPrune: raw.prepare('DELETE FROM subscribers WHERE confirmed_at IS NULL AND created_at < ?'),
    };
  }

  /** @param {string} id @returns {MonitorRow|undefined} */
  monitor(id) { return /** @type {any} */ (this.stmt.monitor.get(id)); }
  /** @returns {MonitorRow[]} */
  monitors() { return /** @type {any} */ (this.stmt.monitors.all()); }
  count() { return Number(this.stmt.count.get()?.n ?? 0); }
  /** @param {MonitorRow} m */
  insert(m) { this.stmt.insert.run(/** @type {any} */ (StatusStore.#named({ ...m, kind: m.kind ?? 'http' }, ['id', 'name', 'description', 'kind', 'dns_type', 'url', 'method', 'expect_text', 'warn_days', 'grace_sec', 'ping_hash', 'interval_sec', 'timeout_ms', 'expect_status', 'fail_threshold', 'public', 'paused', 'origin', 'next_at', 'created_by', 'created_at', 'updated_at']))); }
  /** @param {MonitorRow} m */
  update(m) { this.stmt.update.run(/** @type {any} */ (StatusStore.#named(m, ['id', 'name', 'description', 'dns_type', 'url', 'method', 'expect_text', 'warn_days', 'grace_sec', 'ping_hash', 'interval_sec', 'timeout_ms', 'expect_status', 'fail_threshold', 'public', 'paused', 'next_at', 'updated_at']))); }
  /** @param {string} id */
  delete(id) { this.stmt.delete.run(id); }
  /** @param {string} id @param {number} at */
  ping(id, at) { this.stmt.ping.run(at, id); }

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
  /** @param {string} id @returns {import('../types.js').AlertRow|undefined} */
  alert(id) { return /** @type {any} */ (this.stmt.alert.get(id)); }
  /** Newest alert of this type and key that is still inside the dedupe window. @param {string} type @param {string} key @param {number} since @returns {import('../types.js').AlertRow|undefined} */
  alertRecent(type, key, since) { return /** @type {any} */ (this.stmt.alertRecent.get(type, key, since)); }
  /** @param {{ id: string, type: string, key: string, severity: string, title: string, message: string, data: string, source: string, at: number }} a */
  alertInsert(a) { this.stmt.alertInsert.run(a.id, a.type, a.key, a.severity, a.title, a.message, a.data, a.source, a.at, a.at); }
  /** @param {string} id @param {number} at @param {string} message @param {string} data */
  alertBump(id, at, message, data) { this.stmt.alertBump.run(at, message, data, id); }
  /** @param {string} id @param {number} at @param {string} by */
  alertAck(id, at, by) { return Number(this.stmt.alertAck.run(at, by, id).changes) === 1; }
  /** @param {string} id @param {string|null} error */
  alertNotifyError(id, error) { this.stmt.alertNotify.run(error ? error.slice(0, 500) : null, id); }
  alertCounts() { const r = this.stmt.alertOpen.get(); return { open: Number(r?.n ?? 0), critical: Number(r?.critical ?? 0) }; }
  /** @param {number} cutoff */
  alertsPrune(cutoff) { return Number(this.stmt.alertPrune.run(cutoff).changes); }
  /**
   * Newest first, keyset paged on (last_at, id).
   * @param {{ state?: 'open'|'acked', before?: { at: number, id: string }, limit: number }} q
   * @returns {import('../types.js').AlertRow[]}
   */
  alerts(q) {
    /** @type {string[]} */ const where = [];
    /** @type {(string|number)[]} */ const args = [];
    if (q.state === 'open') where.push('acked_at IS NULL');
    if (q.state === 'acked') where.push('acked_at IS NOT NULL');
    if (q.before) { where.push('(last_at < ? OR (last_at = ? AND id < ?))'); args.push(q.before.at, q.before.at, q.before.id); }
    return /** @type {any} */ (this.raw.prepare(`SELECT * FROM alerts ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY last_at DESC, id DESC LIMIT ?`).all(...args, q.limit));
  }

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

  /** @param {import('../types.js').MaintenanceRow} m */
  maintInsert(m) { this.stmt.maintInsert.run(m.id, m.title, m.message, m.monitors, m.starts_at, m.ends_at, m.created_by, m.created_at); }
  /** @param {string} id @returns {import('../types.js').MaintenanceRow|undefined} */
  maint(id) { return /** @type {any} */ (this.stmt.maintGet.get(id)); }
  /** @param {string} id */
  maintDelete(id) { return Number(this.stmt.maintDelete.run(id).changes) === 1; }
  /** Windows that have not ended yet (active and upcoming). @param {number} now @returns {import('../types.js').MaintenanceRow[]} */
  maintCurrent(now) { return /** @type {any} */ (this.stmt.maintCurrent.all(now)); }
  /** @param {number} since @param {number} limit @returns {import('../types.js').MaintenanceRow[]} */
  maintRecent(since, limit) { return /** @type {any} */ (this.stmt.maintRecent.all(since, limit)); }
  /** @param {number} cutoff */
  maintPrune(cutoff) { return Number(this.stmt.maintPrune.run(cutoff).changes); }
  /** @param {string} incident @param {number} at @param {string} status @param {string} message @param {string} by */
  addUpdate(incident, at, status, message, by) { this.stmt.updInsert.run(incident, at, status, message, by); }
  /** @param {string} incident @returns {import('../types.js').IncidentUpdateRow[]} */
  updates(incident) { return /** @type {any} */ (this.stmt.updOf.all(incident)); }
  /** @param {string} email @returns {import('../types.js').SubscriberRow|undefined} */
  subscriberByEmail(email) { return /** @type {any} */ (this.stmt.subByEmail.get(email)); }
  /** @param {string} hash @returns {import('../types.js').SubscriberRow|undefined} */
  subscriberByToken(hash) { return /** @type {any} */ (this.stmt.subByToken.get(hash)); }
  /** @param {string} id @param {string} email @param {string} hash @param {number} at */
  subscriberInsert(id, email, hash, at) { this.stmt.subInsert.run(id, email, hash, randomBytes(24).toString('base64url'), at); }
  /** @param {string} token @returns {import('../types.js').SubscriberRow|undefined} */
  subscriberByUnsub(token) { return /** @type {any} */ (this.stmt.subByUnsub.get(token)); }
  /** @param {string} id @param {string} hash */
  subscriberToken(id, hash) { this.stmt.subToken.run(hash, id); }
  /** @param {string} id @param {number} at */
  subscriberConfirm(id, at) { return Number(this.stmt.subConfirm.run(at, id).changes) === 1; }
  /** @param {string} id */
  subscriberDelete(id) { return Number(this.stmt.subDelete.run(id).changes) === 1; }
  /** @returns {import('../types.js').SubscriberRow[]} */
  subscribersConfirmed() { return /** @type {any} */ (this.stmt.subConfirmed.all()); }
  /** @param {number} limit @returns {import('../types.js').SubscriberRow[]} */
  /** Newest first; ids sort by creation time, so the last id of a page is the next cursor. @param {number} limit @param {string} [before] */
  subscribers(limit, before = '~') { return /** @type {any} */ (this.stmt.subAll.all(before, limit)); }
  subscriberCounts() { const r = this.stmt.subCount.get(); return { total: Number(r?.n ?? 0), confirmed: Number(r?.confirmed ?? 0) }; }
  /** Unconfirmed sign-ups older than the cutoff. @param {number} cutoff */
  subscribersPrune(cutoff) { return Number(this.stmt.subPrune.run(cutoff).changes); }

  /** @param {Record<string, any>} o @param {string[]} keys */
  static #named(o, keys) {
    return Object.fromEntries(keys.map((k) => [k, o[k] ?? null]));
  }
}
