# Maintenance and incident updates

## Planned maintenance

```bash
curl -s -X POST $STATUS/v1/maintenance -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '{"title":"Database upgrade","message":"Checkout may be slow for a few minutes.","monitors":["shop-api"],"startsAt":"2026-10-20T22:00:00Z","endsAt":"2026-10-20T23:00:00Z"}'
```

`201` with the window (`state`: `planned`, `active` or `ended`). While it is active:

- failures of the listed monitors (every monitor when `monitors` is empty or null) open no incident and send no alert; checks still run and are recorded;
- those monitors show `maintenance` in the console, `/v1/monitors` and on the public page, whose banner says "Maintenance in progress" when nothing is down;
- the public page lists active windows and those starting within 14 days (by monitor name; windows that touch no public monitor are not shown).

A window lasts at most 30 days and must end in the future. End it early or cancel it with `DELETE /v1/maintenance/:id`. `GET /v1/maintenance` lists `current` (active and planned) and `past` (last 30 days). An incident that was already open before the window stays open.

## Written updates on an incident

```bash
curl -s -X POST $STATUS/v1/incidents/$ID/updates -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '{"status":"identified","message":"A bad deploy; rolling back."}'
```

Statuses: `investigating`, `identified`, `monitoring`, `resolved`. Updates are listed under the incident in `GET /v1/incidents/:id` and the last three appear on the public page. `resolved` on an open incident closes it at once, with the usual closing alert and subscriber mail; the next failed checks can open a new one.

Pitfalls: messages are public when the monitor is public — write them for customers. Maintenance does not pause a monitor; pause it if you do not want its checks recorded.
