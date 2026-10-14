/**
 * Shared JSDoc typedefs for the status service. No runtime exports.
 */

/** @typedef {'read'|'admin'} KeyRole */

/**
 * @typedef {object} ApiKey
 * @property {string} id
 * @property {string} secret
 * @property {KeyRole} role
 */

/**
 * @typedef {object} Seed
 * @property {string} id    Becomes monitors `<id>-health` and `<id>-ready`.
 * @property {string} url   Base URL, no trailing slash.
 */

/**
 * @typedef {object} NotifyTarget
 * @property {string} url
 * @property {string} apiKey
 * @property {string[]} to
 * @property {string} appName
 * @property {number} timeoutMs
 */

/**
 * @typedef {object} Limits
 * @property {number} maxMonitors
 * @property {number} maxConcurrent        Checks running at the same time.
 * @property {number} seedIntervalSec      Interval of monitors created from MONITOR_SEEDS.
 * @property {number} checkRetentionDays
 * @property {number} incidentRetentionDays Closed incidents older than this are deleted.
 * @property {number} tickMs               How often due monitors are looked for.
 */

/**
 * @typedef {object} ConfigValues
 * @property {number} port
 * @property {string} host
 * @property {string} logLevel
 * @property {boolean} trustProxy
 * @property {{ certPath: string, keyPath: string }|null} tls
 * @property {{ url: string, apiKey: string }|null} audit
 * @property {{ url: string, apiKey: string, timeoutMs: number }|null} webhookOut  atc-webhook-out target for events; null = off.
 * @property {number} bodyLimit
 * @property {string} dbPath
 * @property {string|undefined} dbBackupDir
 * @property {ApiKey[]} apiKeys
 * @property {number} rateLimitMax
 * @property {{ allowHttp: boolean, allowPrivate: boolean, allowedHosts: string[] }} target
 * @property {Seed[]} seeds
 * @property {NotifyTarget|null} notify
 * @property {string|null} alertHookSecret  Signing secret of the webhook-out subscription that delivers ops.* events; null = hook disabled.
 * @property {number} alertDedupeMin  Repeats of the same alert inside this window raise a counter instead of another e-mail.
 * @property {Limits} limits
 * @property {{ title: string, cacheSec: number }} page
 */

/**
 * @typedef {object} MonitorRow
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {string} url
 * @property {'GET'|'HEAD'} method
 * @property {number} interval_sec
 * @property {number} timeout_ms
 * @property {string} expect_status   JSON array of accepted status codes.
 * @property {number} fail_threshold
 * @property {number} public
 * @property {number} paused
 * @property {'env'|'api'} origin
 * @property {number} consecutive_failures
 * @property {number|null} last_check_at
 * @property {number|null} last_ok          1/0, null before the first check.
 * @property {number|null} last_status
 * @property {number|null} last_latency_ms
 * @property {string|null} last_error
 * @property {number} next_at
 * @property {string} created_by
 * @property {number} created_at
 * @property {number} updated_at
 */

/**
 * @typedef {object} CheckRow
 * @property {number} seq
 * @property {string} monitor
 * @property {number} at
 * @property {number} ok
 * @property {number|null} status
 * @property {number} latency_ms
 * @property {string|null} error
 */

/**
 * @typedef {object} IncidentRow
 * @property {string} id
 * @property {string} monitor
 * @property {number} opened_at
 * @property {number|null} closed_at
 * @property {string} cause
 * @property {string|null} last_error
 * @property {number} failures
 * @property {string|null} notify_error
 */

/**
 * @typedef {object} AlertRow
 * @property {string} id
 * @property {string} type
 * @property {string} dedupe_key
 * @property {'warning'|'critical'} severity
 * @property {string} title
 * @property {string} message
 * @property {string} data       JSON.
 * @property {string} source
 * @property {number} count
 * @property {number} first_at
 * @property {number} last_at
 * @property {number|null} acked_at
 * @property {string|null} acked_by
 * @property {string|null} notify_error
 */

/** @typedef {{ ok: boolean, status: number|null, latencyMs: number, error: string|null }} CheckResult */

/** @typedef {import('fastify').FastifyBaseLogger} Logger */

export {};
