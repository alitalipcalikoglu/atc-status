# Incidents

With `failThreshold: 2`, the second failed check in a row opens an incident; later failures add to its `failures` and `lastError`; the first passing check closes it. A monitor has at most one open incident.

```bash
st "$STATUS/v1/incidents?state=open"
st "$STATUS/v1/incidents?monitor=shop&limit=20"
st $STATUS/v1/incidents/inc_mv8abcde0123456789abcdef
```

```json
{ "incident": { "id": "inc_mv8abcde0123456789abcdef", "monitor": "shop", "state": "closed", "openedAt": "2026-10-14T10:00:30.000Z",
  "closedAt": "2026-10-14T10:04:30.000Z", "durationSec": 240, "cause": "unexpected status 503", "lastError": "timed out after 3000ms",
  "failures": 8, "notifyError": null } }
```

`cause` is the error of the check that opened it. Closed incidents are deleted after `INCIDENT_RETENTION_DAYS`; checks after `CHECK_RETENTION_DAYS`.

Pitfalls:
- Pausing a monitor with an open incident keeps the incident open until a check passes (check now, or unpause).
- Deleting a monitor deletes its incidents.
