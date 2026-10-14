# Monitors

```bash
st -X PUT $STATUS/v1/monitors/shop -d '{"name":"Shop","url":"https://shop.example.com/health","intervalSec":30,"timeoutMs":3000,"expectStatus":[200,204],"failThreshold":3,"public":true}'
```

`201` (or `200` when it existed):

```json
{ "created": true, "monitor": { "id": "shop", "name": "Shop", "url": "https://shop.example.com/health", "method": "GET", "intervalSec": 30, "timeoutMs": 3000,
  "expectStatus": [200, 204], "failThreshold": 3, "public": true, "paused": false, "origin": "api", "state": "unknown", "consecutiveFailures": 0,
  "lastCheck": null, "nextCheckAt": "2026-10-14T10:00:00.000Z", "uptime24h": null, "avgLatency24hMs": null, "createdBy": "atc-console", "...": "..." } }
```

Defaults on create: `GET`, every 60 s, 5 s timeout, expect `200`, incident after 2 failures, not public. Omitted fields keep their value on update. A new monitor, a changed URL or interval, or unpausing is checked within a second.

A check passes when the status is in `expectStatus` within `timeoutMs` (DNS, connect and response together). Redirects are not followed: a `302` is a failure unless you expect it. Use `HEAD` for endpoints that send large bodies.

States: `up` (last check passed), `degraded` (last check failed, below `failThreshold`), `down` (open incident), `unknown` (never checked), `paused`.

```bash
st -X POST $STATUS/v1/monitors/shop/check                 # check now, paused or not
st "$STATUS/v1/monitors/shop/checks?limit=20"             # newest first, nextCursor pages
st $STATUS/v1/monitors/shop                               # with uptime over 24h, 7d, 30d and the open incident
st -X PUT $STATUS/v1/monitors/shop -d '{"paused":true}'
st -X DELETE $STATUS/v1/monitors/shop                     # 204; checks and incidents go too
```

Besides `http` there are the kinds `tcp`, `tls` and `heartbeat`, see [Monitor kinds](monitor-kinds.md).

Pitfalls:
- `timeoutMs` may not exceed the interval (`400 INVALID_ARGUMENT`).
- `url` is required on create; the id is permanent (lowercase letters, digits, dashes).
