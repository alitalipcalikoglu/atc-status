# Events

```bash
WEBHOOK_OUT_URL=http://webhook-out.internal:3009
WEBHOOK_OUT_API_KEY=<a webhook-out key with the publish role>
```

| Event | When | Data |
|---|---|---|
| `incident.opened` | A monitor reached `failThreshold` failures in a row | `id`, `monitor`, `name`, `cause`, `failures` |
| `incident.closed` | The first successful check after an incident | `id`, `monitor`, `name`, `cause`, `failures` |

These are for systems that react to an outage (a pager, a chat bridge, a deploy freeze), not for people: the e-mail alerts (`ALERT_EMAILS`) are separate and independent. The payload has no monitor URL and no error text, so a subscriber outside the trust zone learns only that the named monitor is down.

Events are best effort (in-memory queue, retries, lost on a restart). The incident list stays the record.

Pitfalls:
- Do not subscribe atc-status's own alert hub to `incident.*`: the hub takes `ops.*` events only.
