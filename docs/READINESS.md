# `atc-status` readiness contract

## Purpose
Uptime monitoring: HTTP checks of URLs (the platform's `/health` and `/ready` included), automatic
incidents, e-mail alerts through atc-notify and a public status page.

## Dependencies
`atc-notify` (optional, alerts), `atc-audit` (optional, events). The monitored URLs are not
dependencies: an unreachable target is a failed check, never a failed service.

## Persistence
SQLite at `DB_PATH` (`./data/status.db`; Docker `/data/status.db`), WAL. Tables: `monitors`,
`checks` (kept `CHECK_RETENTION_DAYS`), `incidents` (closed ones kept `INCIDENT_RETENTION_DAYS`;
a partial unique index allows one open incident per monitor). Migrations by `user_version`,
snapshot before upgrading, no down migrations.

## Health / readiness
`/health` no I/O. `/ready` database ping cached 10 s; the body names the monitor count, checker
state and whether alerts are enabled.

## Graceful shutdown
`SIGTERM`: no new checks, HTTP drains, running checks finish (each bounded by its timeout), audit
flush, database closes. Force exit 30 s; PM2 `kill_timeout` 35 s.

## Resource limits
`MAX_MONITORS` 500, `MAX_CONCURRENT` 8 checks, interval 10 s to 24 h, timeout 0.5-60 s (not more
than the interval), response bodies are drained and discarded (bounded by the timeout), `RATE_LIMIT_MAX` 600/min
per key, `BODY_LIMIT` 16 KiB.

## Timeouts
Per monitor `timeoutMs` for DNS, connect and response together. Alerts `NOTIFY_TIMEOUT_MS` 10 s.

## Retry policy
None inside a check: a failed check counts, the next one runs at the next interval. A failed alert
is recorded on the incident (`notifyError`), not retried.

## Idempotency
One open incident per monitor (enforced by the database). Alerts carry
`atc-status:<incident>:<opened|closed>` as the notify idempotency key. Monitor PUT is idempotent.

## Backup / restore
The SQLite file. After a restore, monitors continue at their next due time; an incident open at
backup time closes at the next passing check.

## Metrics
`status_monitor_up{monitor}`, `status_check_latency_ms{monitor}`, `status_incident_open{monitor}`,
`status_process_uptime_seconds`.

## Logging / tracing
Fastify request logs with request id and trace context, `authorization` redacted; incidents
opening and closing are logged.

## Security model
Bearer keys with `read`/`admin`. Monitors created through the API pass the SSRF guard (https,
public addresses, optional host allowlist; the resolved address is pinned; no redirects).
Monitors from `MONITOR_SEEDS` are operator configuration and may be private. The public page and
JSON show public monitors by name only: no URLs, no error texts; the HTML has no scripts and a
strict CSP.

## Scaling model
**B — single-node stateful.** One process per SQLite file (`instances: 1`); two processes would
check every monitor twice.

## Known failure modes
- The checker host loses its network: every monitor fails and incidents open for all of them.
- A slow target holds one of `MAX_CONCURRENT` slots for up to its timeout; others wait.
