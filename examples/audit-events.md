# Audit events

With `AUDIT_URL` and `AUDIT_API_KEY` set, monitor changes are forwarded with outcome `success`, or `denied` on 403:

| Action | Target | Meta |
|---|---|---|
| `atc-status.monitor.upsert` | monitor | `created`, `settings` (the request body) |
| `atc-status.monitor.delete` | monitor | – |

The actor is the API key id. Checks, check-now, incidents and reads are not audited (they are in the check and incident history).
