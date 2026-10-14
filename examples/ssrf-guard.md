# Outbound safety

Monitors created through the API make requests from inside your network, so their URLs pass a guard:

- `https` only, unless `TARGET_ALLOW_HTTP=true`.
- No credentials in the URL.
- The host must resolve only to public addresses, unless `TARGET_ALLOW_PRIVATE=true` (which requires `TARGET_ALLOWED_HOSTS`).
- With `TARGET_ALLOWED_HOSTS`, only those hosts (or subdomains) may be monitored.
- The checked address is pinned for the connection (no DNS rebinding) and redirects are never followed.

```bash
st -X PUT $STATUS/v1/monitors/intranet -d '{"url":"http://10.0.0.8/health"}'
# 400 {"error":{"code":"TARGET_NOT_ALLOWED","message":"scheme \"http:\" is not allowed"}}
```

A URL that passes the static checks but later resolves to a private address fails each check with `host "…" resolves to non-public address …`.

Monitors from `MONITOR_SEEDS` are operator configuration and skip the guard.
