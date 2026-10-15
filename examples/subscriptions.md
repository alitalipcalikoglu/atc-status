# Subscriptions to the status page

Visitors can ask for an e-mail when a public monitor goes down or recovers. It needs `STATUS_PUBLIC_URL` (the address people use to reach `/status`; links in the mails point there) and atc-notify (`NOTIFY_URL`, `NOTIFY_API_KEY`). Then the page shows a "Get updates" form.

## The flow

1. The form posts `email` to `/status/subscribe`. The answer is always "Check your inbox" for a valid address — it does not tell whether the address was already on the list. Ten requests per minute per address.
2. A confirmation mail links to `/status/subscribe/<token>`. Opening it shows a button; only the button (a POST) confirms, so mail scanners that follow links do not subscribe anyone. Unconfirmed sign-ups are dropped after two days.
3. From then on, an incident opening or closing on a public monitor sends one mail to every confirmed subscriber, with a link to `/status/unsubscribe/<token>` (again a button). The unsubscribe link is the same in every mail.

## Administration

```bash
curl -s $STATUS/v1/subscribers -H "Authorization: Bearer $ADMIN"
curl -s -X DELETE $STATUS/v1/subscribers/$ID -H "Authorization: Bearer $ADMIN"
```

The list holds e-mail addresses, so it needs an admin key. `MAX_SUBSCRIBERS` (default 2000) caps the list; `0` turns subscriptions off.

## Pitfalls

- Mails go through atc-notify, so its suppression list and per-recipient quota apply.
- Maintenance windows suppress incidents, so subscribers are not mailed for planned work; announce it with the window's message on the page instead.
- Serve `/status` and `/status/*` through the gateway (the subscription form posts there).
