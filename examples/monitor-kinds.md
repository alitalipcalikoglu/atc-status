# Monitor kinds

`kind` is set when a monitor is created and cannot change (create another monitor instead). The default is `http`.

## Keyword check

```bash
st -X PUT $STATUS/v1/monitors/shop-home -d '{"name":"Shop home","url":"https://shop.example.com/","expectText":"Add to cart"}'
```

The status must be expected and the first 1 KiB of the body must contain the text. This catches a 200 page that says "maintenance". Needs `GET` (a `HEAD` response has no body: `400 INVALID_ARGUMENT`). Text beyond the first KiB is not seen.

## TCP: a port accepts connections

```bash
st -X PUT $STATUS/v1/monitors/mail-port -d '{"kind":"tcp","name":"SMTP","url":"https://mail.example.com:587","intervalSec":60}'
```

The target is written as `https://host:port` so the SSRF guard applies as for any API monitor; only host and port are used (443 when no port is given). Private addresses need `TARGET_ALLOW_PRIVATE`.

## TLS: valid certificate, not about to expire

```bash
st -X PUT $STATUS/v1/monitors/shop-cert -d '{"kind":"tls","name":"Shop certificate","url":"https://shop.example.com","warnDays":21,"intervalSec":3600}'
```

Fails when the handshake or chain validation fails (`certificate rejected: ...`), when the certificate has expired, or when it expires within `warnDays` (default 14): `certificate expires in 9 days`. Checking once an hour is plenty; the incident opens `failThreshold` checks later (set `failThreshold` to 1 for a certificate).

## Heartbeat: a job tells you it ran

For things nobody can poll: a nightly cron job, a backup script.

```bash
st -X PUT $STATUS/v1/monitors/nightly-backup -d '{"kind":"heartbeat","name":"Nightly backup","intervalSec":86400,"graceSec":3600,"failThreshold":1}'
```

```json
{ "created": true, "monitor": { "id": "nightly-backup", "kind": "heartbeat", "url": null, "graceSec": 3600, "lastPingAt": null, "...": "..." },
  "pingToken": "9d1c4e0b7a3f...", "pingPath": "/v1/ping/nightly-backup/9d1c4e0b7a3f..." }
```

The token is shown once (only its hash is stored). At the end of the job:

```bash
curl -fsS -X POST https://status.example.com/v1/ping/nightly-backup/9d1c4e0b7a3f...
```

No API key; the token in the path is the credential. `204` when recorded, `404` for a wrong token, an unknown monitor and a paused one alike. The monitor is up while the last ping is younger than `intervalSec + graceSec`; a monitor never pinged is judged from its creation. A ping on a monitor with an open incident closes it at once.

`PUT` with `{"rotateToken":true}` issues a new token (the old one stops working). A heartbeat is noticed up to one interval late: the check runs every `intervalSec`.

## The dead man's switch of the status service

Nothing inside the stack can tell you that atc-status itself stopped. Create a monitor on a different host (a healthchecks-style service, or a heartbeat monitor of another atc-status), then:

```bash
HEARTBEAT_URL=https://hc.example.com/ping/your-uuid
HEARTBEAT_INTERVAL_SEC=60
```

The service GETs that URL on start and then on the interval; failures are logged and counted in `status_heartbeat_out_total{result="failed"}`. If the pings stop, the other host alerts.

Pitfalls:
- `tcp`, `tls` and `heartbeat` monitors have no `method`, `expectStatus` or (heartbeat) `url`; sending them is `400 INVALID_ARGUMENT`.
- A heartbeat interval shorter than the job's real period raises false incidents; add the job's run time to `graceSec`.

## DNS: a name resolves (to the right thing)

```bash
curl -s -X PUT $STATUS/v1/monitors/dns-shop -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '{"kind":"dns","url":"shop.example.com","dnsType":"A","expectText":"203.0.113.7","intervalSec":300}'
```

`url` is a host name here. The check looks up `dnsType` (`A`, `AAAA`, `CNAME`, `MX`, `TXT`, `NS`; default `A`) and passes when there is at least one record and, with `expectText`, one record contains that text — the expected address, a CNAME target or a TXT verification string. Failures read like `A lookup failed: ENOTFOUND` or `no A record contains the expected text (got 198.51.100.1)`. Set `DNS_SERVERS` to ask specific resolvers instead of the system's. Only a lookup is made, so the SSRF guard does not apply to dns monitors.

