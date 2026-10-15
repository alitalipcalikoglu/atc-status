# status examples

Scenario-driven walkthroughs of every feature. Requests to `/v1/*` need `Authorization: Bearer <secret>` from `STATUS_API_KEYS`. Base URL below is `http://localhost:3018`.

| Example | Shows |
|---|---|
| [Monitors](monitors.md) | Creating and changing a monitor, expected statuses, pausing, check now, deleting |
| [Monitor kinds](monitor-kinds.md) | Keyword, TCP and TLS-expiry checks, heartbeats for cron jobs, the dead man's switch |
| [Seeded monitors](seeded-monitors.md) | `/health` and `/ready` of every service from `MONITOR_SEEDS` |
| [Incidents](incidents.md) | When incidents open and close, browsing them |
| [Maintenance and incident updates](maintenance-and-updates.md) | Planned windows that open no incident, written updates on the public page |
| [Subscriptions](subscriptions.md) | E-mail subscriptions to the public page: double opt-in, unsubscribe, administration |
| [Alerts](alerts.md) | E-mails through atc-notify when an incident opens and closes |
| [Operational alerts](operational-alerts.md) | `ops.*` events from webhook-out become alerts: dedupe, e-mail, acknowledge |
| [Events](events.md) | `incident.opened` and `incident.closed` through atc-webhook-out |
| [Public status page](status-page.md) | `/status` and `/status/summary.json`, what is shown, serving it through the gateway |
| [Outbound safety](ssrf-guard.md) | The SSRF guard for monitors created through the API |
| [API keys and roles](keys-and-roles.md) | read and admin |
| [Operations](operations.md) | Health, readiness, metrics, stats, retention, PM2, Docker |
| [Audit events](audit-events.md) | Which actions are forwarded to the audit service |

```bash
export STATUS=http://localhost:3018
export ADMIN=<an admin secret>
alias st='curl -s -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json"'
```
