# Public status page

No key needed:

```bash
curl -s $STATUS/status              # HTML
curl -s $STATUS/status/summary.json
```

```json
{ "title": "Service status", "overall": "operational", "updatedAt": "2026-10-14T10:00:00.000Z",
  "monitors": [{ "name": "atc-auth ready", "state": "up", "uptime24h": 100, "uptime7d": 99.95, "latencyMs": 4, "checkedAt": "2026-10-14T09:59:41.000Z" }],
  "incidents": [{ "monitor": "atc-auth ready", "openedAt": "2026-10-13T22:10:00.000Z", "closedAt": "2026-10-13T22:12:00.000Z", "durationSec": 120 }] }
```

Only monitors with `public: true` appear, by name. URLs, ids and error texts are never shown. `overall` is `outage` when any public monitor is down, `degraded` when one failed its last check, otherwise `operational`. The HTML has no scripts, a strict Content-Security-Policy, follows the reader's light or dark preference and works at phone width. Both are cached for `STATUS_PAGE_CACHE_SEC` (15 s) in the service and in `Cache-Control`; the JSON allows any origin.

Through the gateway (`routes.json`):

```json
{ "id": "status-page", "pathPrefix": "/status", "upstreams": ["http://127.0.0.1:3018"], "methods": ["GET", "HEAD"], "rateLimit": 600 }
```

`/status` and `/status/summary.json` are the only paths under that prefix, so nothing else of the service is reachable through it.

Pitfalls:
- The page title comes from `STATUS_PAGE_TITLE`; monitor names are what the public sees, so name them for customers.
