# Alerts

```bash
NOTIFY_URL=http://notify.internal:3001
NOTIFY_API_KEY=<a notify key>
ALERT_EMAILS=ops@example.com,oncall@example.com
ALERT_APP_NAME=Acme
```

When an incident opens, every address gets `DOWN: <monitor name>` with the failure count and cause; when it closes, `RECOVERED: <monitor name>` with how long it was down. Both use atc-notify's `generic` e-mail template with the idempotency key `atc-status:<incident>:opened|closed`, so a repeated send never mails twice.

A failed send does not change the incident; the error is kept in `notifyError` (`opened: atc-notify responded 503`) and logged. It is not retried.

Pitfalls:
- `ALERT_EMAILS` is required when `NOTIFY_URL` is set.
- A flapping target mails on every open and close; raise `failThreshold` for it.
