import { ConfigError, EnvReader, parseApiKeys, parseAudit, parseTarget } from '@atc-web/atc-service-core/config';

/** @typedef {import('./types.js').ApiKey} ApiKey */
/** @typedef {import('./types.js').KeyRole} KeyRole */
/** @typedef {import('./types.js').Seed} Seed */

export { ConfigError };

/** Validated service configuration. Build with {@link Config.fromEnv}. */
export class Config {
  static MIN_SECRET_LENGTH = 32;
  static SEED_PATTERN = /^[a-z][a-z0-9-]{0,56}$/;
  static EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;

  /** @param {import('./types.js').ConfigValues} v */
  constructor(v) {
    this.port = v.port;
    this.host = v.host;
    this.logLevel = v.logLevel;
    this.trustProxy = v.trustProxy;
    this.tls = v.tls;
    this.audit = v.audit;
    this.bodyLimit = v.bodyLimit;
    this.dbPath = v.dbPath;
    this.dbBackupDir = v.dbBackupDir;
    this.apiKeys = v.apiKeys;
    this.rateLimitMax = v.rateLimitMax;
    this.target = Object.freeze({ ...v.target });
    this.seeds = Object.freeze(v.seeds.map((s) => Object.freeze({ ...s })));
    this.notify = v.notify;
    this.alertHookSecret = v.alertHookSecret;
    this.alertDedupeMin = v.alertDedupeMin;
    this.limits = Object.freeze({ ...v.limits });
    this.page = Object.freeze({ ...v.page });
    Object.freeze(this);
  }

  /** @param {NodeJS.ProcessEnv} [env] @returns {Config} */
  static fromEnv(env = process.env) {
    const r = new EnvReader(env);
    const certPath = r.optional('TLS_CERT_PATH');
    const keyPath = r.optional('TLS_KEY_PATH');
    if (Boolean(certPath) !== Boolean(keyPath)) throw new ConfigError('TLS_CERT_PATH and TLS_KEY_PATH must be set together');
    return new Config({
      port: r.integer('PORT', 3018, { min: 0, max: 65535 }),
      host: r.optional('HOST') || '0.0.0.0',
      logLevel: r.optional('LOG_LEVEL') || 'info',
      trustProxy: r.boolean('TRUST_PROXY', false),
      tls: certPath ? { certPath, keyPath } : null,
      audit: parseAudit(r),
      bodyLimit: r.integer('BODY_LIMIT', 16_384, { min: 1_024 }),
      dbPath: r.optional('DB_PATH') || './data/status.db',
      dbBackupDir: r.optional('DB_BACKUP_DIR') || undefined,
      apiKeys: Config.#parseApiKeys(r.required('STATUS_API_KEYS')),
      rateLimitMax: r.integer('RATE_LIMIT_MAX', 600, { min: 1 }),
      target: parseTarget(r),
      seeds: Config.#parseSeeds(r.optional('MONITOR_SEEDS')),
      notify: Config.#parseNotify(r),
      alertHookSecret: Config.#parseHookSecret(r.optional('ALERT_HOOK_SECRET')),
      alertDedupeMin: r.integer('ALERT_DEDUPE_MIN', 15, { min: 1, max: 1_440 }),
      limits: {
        maxMonitors: r.integer('MAX_MONITORS', 500, { min: 1 }),
        maxConcurrent: r.integer('MAX_CONCURRENT', 8, { min: 1, max: 100 }),
        seedIntervalSec: r.integer('SEED_INTERVAL_SEC', 60, { min: 10, max: 86_400 }),
        checkRetentionDays: r.integer('CHECK_RETENTION_DAYS', 14, { min: 1, max: 3_650 }),
        incidentRetentionDays: r.integer('INCIDENT_RETENTION_DAYS', 365, { min: 1, max: 36_500 }),
        tickMs: r.integer('TICK_MS', 1_000, { min: 100 }),
      },
      page: {
        title: r.optional('STATUS_PAGE_TITLE') || 'Service status',
        cacheSec: r.integer('STATUS_PAGE_CACHE_SEC', 15, { min: 0, max: 3_600 }),
      },
    });
  }

  /**
   * `id=baseUrl,…`: each becomes two monitors, `<id>-health` and `<id>-ready`. Operator
   * configuration, so these URLs may be private (they are not passed through the SSRF guard).
   * @param {string} raw @returns {Seed[]}
   */
  static #parseSeeds(raw) {
    /** @type {Seed[]} */
    const out = [];
    for (const entry of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
      const at = entry.indexOf('=');
      const id = at > 0 ? entry.slice(0, at).trim() : '';
      const url = at > 0 ? entry.slice(at + 1).trim().replace(/\/+$/, '') : '';
      if (!Config.SEED_PATTERN.test(id)) throw new ConfigError(`MONITOR_SEEDS entry "${entry}" needs id=baseUrl with a lowercase id`);
      let parsed;
      try { parsed = new URL(url); } catch { throw new ConfigError(`MONITOR_SEEDS "${id}" needs an absolute http(s) base URL`); }
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new ConfigError(`MONITOR_SEEDS "${id}" needs an absolute http(s) base URL without credentials`);
      if (out.some((s) => s.id === id)) throw new ConfigError(`MONITOR_SEEDS id "${id}" is listed twice`);
      out.push({ id, url });
    }
    return out;
  }

  /** @param {EnvReader} r */
  static #parseNotify(r) {
    const url = r.optional('NOTIFY_URL').replace(/\/+$/, '');
    const apiKey = r.optional('NOTIFY_API_KEY');
    if (!url && !apiKey) return null;
    if (!url || !apiKey) throw new ConfigError('NOTIFY_URL and NOTIFY_API_KEY must be set together');
    if (!/^https?:\/\/[^\s]+$/.test(url)) throw new ConfigError('NOTIFY_URL must be an absolute http(s) URL');
    const to = r.list('ALERT_EMAILS');
    if (!to.length) throw new ConfigError('ALERT_EMAILS is required when NOTIFY_URL is set');
    // atc-notify accepts at most 10 recipients per message; more would make every alert fail with a 400.
    if (to.length > 10) throw new ConfigError('ALERT_EMAILS may list at most 10 addresses (atc-notify limit per message); use a distribution list');
    for (const e of to) if (!Config.EMAIL_PATTERN.test(e)) throw new ConfigError(`ALERT_EMAILS entry "${e}" is not an e-mail address`);
    return { url, apiKey, to, appName: r.optional('ALERT_APP_NAME') || 'atc-web', timeoutMs: r.integer('NOTIFY_TIMEOUT_MS', 10_000, { min: 500 }) };
  }

  /** @param {string} raw */
  static #parseHookSecret(raw) {
    if (!raw) return null;
    if (raw.length < Config.MIN_SECRET_LENGTH) throw new ConfigError(`ALERT_HOOK_SECRET must be at least ${Config.MIN_SECRET_LENGTH} characters`);
    return raw;
  }

  /** `id:secret:role`, role `read` or `admin`. @param {string} raw @returns {ApiKey[]} */
  static #parseApiKeys(raw) {
    return parseApiKeys(raw, 'STATUS_API_KEYS', { roles: ['read', 'admin'], minSecretLength: Config.MIN_SECRET_LENGTH, roleErrorMessage: () => 'must be read or admin' })
      .map(({ id, secret, role }) => ({ id, secret, role: /** @type {KeyRole} */ (role) }));
  }
}
