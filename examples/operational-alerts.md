# Operational alerts

atc-status is the human alert hub. Services publish `ops.*` events to atc-webhook-out; a webhook-out subscription delivers them here, signed, and each becomes an alert.

```bash
ALERT_HOOK_SECRET=<32+ characters, the same secret as the webhook-out subscription>
```

Webhook-out side (a seed, or create the subscription through its API):

```bash
SUBSCRIPTION_SEEDS=alert-hub|http://status.internal:3018/v1/hooks/webhook-out|ops.*|<the same secret>
```

Delivery: `POST /v1/hooks/webhook-out` with the raw JSON body and `X-Webhook-Signature`. No API key. Answer `202 {"outcome":"alerted","id":"alr_..."}`.

Outcomes:
- `alerted`: a new alert; if `NOTIFY_URL` is set an e-mail goes to `ALERT_EMAILS` (`CRITICAL` or `WARNING` prefix).
- `repeated`: same type and key already open inside `ALERT_DEDUPE_MIN` minutes; only `count` and `lastAt` grow.
- `ignored`: the event type does not start with `ops.`.

Known severities: `ops.backup.failed`, `ops.backup.stale`, `ops.payments.outbox_dead` critical; `ops.queue.dead_letter`, `ops.scheduler.job_failed`, `ops.webhook.subscription_disabled`, `ops.audit.denied_spike` warning; other `ops.*` info.

```bash
curl -s -H "Authorization: Bearer $ADMIN" "$STATUS/v1/alerts?state=open"
curl -s -X POST -H "Authorization: Bearer $ADMIN" "$STATUS/v1/alerts/alr_.../ack"
```

After an acknowledgement the next event of that kind is a new alert and mails again.

Pitfalls:
- A bad or stale signature (older than 5 minutes) answers 401; with no `ALERT_HOOK_SECRET` the hook answers 404.
- A failed e-mail keeps the alert and records `notifyError`; it is not retried.
- Acknowledging does not stop the producer; fix the cause.
