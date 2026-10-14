# atc-status

Uptime monitoring for the platform and anything else with a URL. HTTP checks on an interval with expected statuses and timeouts, automatic incidents (opened after N failures in a row, closed by the first passing check), e-mail alerts through atc-notify, uptime and latency history, and a public status page (HTML and JSON) that shows public monitors by name only. The `/health` and `/ready` of every service come from one variable. HTTP only.

Runtime dependencies: `fastify`, `@fastify/rate-limit`, `@atc-web/atc-service-core`. Storage is SQLite via `node:sqlite` (Node 22.13+).

## Run

```bash
cp .env.example .env        # set STATUS_API_KEYS (and MONITOR_SEEDS)
npm ci
npm run dev
```

Production: `npm ci --omit=dev && pm2 start ecosystem.config.cjs`, or `docker build -t atc-status . && docker run -p 3018:3018 -v atc-status-data:/data --env-file .env atc-status`.

Tests and type check: `npm test`, `npm run typecheck`.

## Model

- **Monitor**: id, name, URL, `GET`/`HEAD`, `intervalSec`, `timeoutMs`, `expectStatus`, `failThreshold`, `public`, `paused`; `origin` `api` or `env` (from `MONITOR_SEEDS`).
- **Check**: one request; passes when the status is expected within the timeout. Redirects are not followed.
- **State**: `up`, `degraded` (failing, below the threshold), `down` (open incident), `unknown`, `paused`.
- **Incident**: opened by `failThreshold` failed checks in a row, one per monitor at most, closed by the first passing check; alerts on open and close.

## API

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/health`, `/ready`, `/v1/info` | none | Probes, identity |
| GET | `/status`, `/status/summary.json` | none | Public status page and its data |
| GET | `/metrics` | read | Prometheus text |
| GET | `/v1/monitors` | read | Monitors with state, last check, 24 h uptime |
| PUT / GET / DELETE | `/v1/monitors/:id` | admin / read / admin | Create or change; detail with 24 h, 7 d, 30 d uptime and the open incident; delete |
| POST | `/v1/monitors/:id/check` | admin | Check now |
| GET | `/v1/monitors/:id/checks` | read | Check history, cursor paging |
| GET | `/v1/incidents`, `/v1/incidents/:id` | read | Incidents by monitor and state |
| POST | `/v1/hooks/webhook-out` | signature | atc-webhook-out delivery; `ops.*` events become alerts |
| GET | `/v1/alerts` | read | Operational alerts by state |
| POST | `/v1/alerts/:id/ack` | admin | Acknowledge an alert |
| GET | `/v1/stats` | read | Monitors by state, open and recent incidents |

Errors: `{ "error": { "code", "message" } }` — `VALIDATION_FAILED`, `INVALID_ARGUMENT`, `TARGET_NOT_ALLOWED` (400), `FORBIDDEN` (403), `MONITOR_NOT_FOUND`, `INCIDENT_NOT_FOUND`, `ALERT_NOT_FOUND`, `HOOK_DISABLED` (404), `INVALID_SIGNATURE` (401), `INVALID_STATE`, `LIMIT_EXCEEDED` (409), `RATE_LIMITED` (429). Full contract: [openapi.yaml](openapi.yaml).

## Examples

Monitors, seeded monitors, incidents, alerts, the status page and the gateway route, the SSRF guard: [examples/README.md](examples/README.md).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT`, `HOST` | `3018`, `0.0.0.0` | Listen address |
| `STATUS_API_KEYS` | required | `id:secret:role`; role `read` or `admin` |
| `MONITOR_SEEDS`, `SEED_INTERVAL_SEC` | empty, `60` | `id=baseUrl,…` → `<id>-health` and `<id>-ready` monitors |
| `TARGET_ALLOW_HTTP`, `TARGET_ALLOW_PRIVATE`, `TARGET_ALLOWED_HOSTS` | `false`, `false`, empty | SSRF guard for API monitors |
| `MAX_MONITORS`, `MAX_CONCURRENT`, `TICK_MS` | `500`, `8`, `1000` | |
| `CHECK_RETENTION_DAYS`, `INCIDENT_RETENTION_DAYS` | `14`, `365` | |
| `STATUS_PAGE_TITLE`, `STATUS_PAGE_CACHE_SEC` | `Service status`, `15` | Public page |
| `NOTIFY_URL`, `NOTIFY_API_KEY`, `ALERT_EMAILS`, `ALERT_APP_NAME`, `NOTIFY_TIMEOUT_MS` | empty, empty, empty, `atc-web`, `10000` | Alerts (URL and key both or neither; recipients required with them) |
| `ALERT_HOOK_SECRET`, `ALERT_DEDUPE_MIN` | empty, `15` | Signing secret (>= 32 chars) of the webhook-out subscription that delivers `ops.*` events; empty disables the hook. Repeats of one alert inside the window are counted, not mailed again |
| `DB_PATH`, `DB_BACKUP_DIR`, `BODY_LIMIT`, `RATE_LIMIT_MAX` | `./data/status.db`, –, `16384`, `600` | |
| `TRUST_PROXY`, `TLS_CERT_PATH`, `TLS_KEY_PATH`, `LOG_LEVEL` | | As in every service |
| `WEBHOOK_OUT_URL`, `WEBHOOK_OUT_API_KEY`, `WEBHOOK_OUT_TIMEOUT_MS` | empty, empty, `5000` | Publish events to atc-webhook-out (URL and key both or neither; a `publish` key) |
| `AUDIT_URL`, `AUDIT_API_KEY` | empty | Forward audit events (both or neither) |

## Security notes

- Monitors created through the API pass the SSRF guard: https and public addresses by default, optional host allowlist, the resolved address is pinned, redirects are never followed.
- The public page and JSON show public monitors by name only; no URLs, ids or error texts. The HTML has no scripts and a strict CSP; every value is escaped.
- Monitor URLs are visible to every key (`read` included); do not put secrets in them.

## Code layout

```
src/
  application.js            composition root, check loop, retention, lifecycle
  config.js, db.js, types.js
  domain/status-service.js  monitors, seeding, due checks, incident rules, uptime, public summary
  store/status-store.js     SQLite statements
  net/checker.js            one HTTP check (guard, pinned address, timeout)
  net/notifier.js           incident e-mails through atc-notify
  http/                     StatusApi routes, StatusPage (HTML), ApiKeyAuth, Schemas, Views
test/                       node:test suites
```

## Out of scope by design

- TCP, ICMP, DNS, TLS-expiry and keyword (body) checks; checks from several regions.
- Maintenance windows, manual incident updates and subscriptions on the status page.
- Alert channels other than e-mail.

## Events

With `WEBHOOK_OUT_URL` set, an opened or closed incident publishes `incident.opened` or `incident.closed` (id, monitor, name, cause, failures; no URL, no error text). Best effort; see [examples/events.md](examples/events.md). The alert hub (`/v1/hooks/webhook-out`) is the receiving side for `ops.*` events, see [examples/operational-alerts.md](examples/operational-alerts.md).

## Audit events

With `AUDIT_URL` and `AUDIT_API_KEY` set, `atc-status.monitor.upsert` (meta: created, settings) and `atc-status.monitor.delete` and `atc-status.alert.ack` are forwarded with `success`, or `denied` on 403. Details: [examples/audit-events.md](examples/audit-events.md).

## Scaling model

**B — single-node stateful.** One process per SQLite file; two would check every monitor twice. See [docs/READINESS.md](docs/READINESS.md).

## Observability

Request logs with request id and trace context; incident open/close log lines; `/metrics` (up, latency, open incident per monitor); `/v1/stats`; `/ready`.

Event publishing is observable as `events_publish_enabled`, `events_publish_total{result="published|sent|dropped|failed"}` and `events_publish_pending`.

Audit forwarding is observable too: `audit_forward_enabled`, `audit_forward_events_total{result="recorded|sent|dropped|failed"}` and `audit_forward_pending`. A rising `dropped`, or a `pending` that does not drain, means audit events are being lost or delayed; alert on it.

## Backup / restore

The SQLite file at `DB_PATH` (atc-backup can copy it). After a restore, monitors continue at their next due time and open incidents close at the next passing check.

## License

MIT, see [LICENSE](LICENSE).
