# Seeded monitors

```bash
MONITOR_SEEDS=atc-auth=http://127.0.0.1:3002,atc-media=http://127.0.0.1:3003
SEED_INTERVAL_SEC=60
```

On every start, each entry becomes two public monitors, `atc-auth-health` (`GET /health`) and `atc-auth-ready` (`GET /ready`), with `origin: "env"`. They are created when missing; when the base URL in the env changes, their URL follows. Everything else you change (name, interval, threshold, public, paused) stays.

Seeded URLs are operator configuration and may point at private addresses; they skip the SSRF guard that applies to API monitors.

Pitfalls:
- The URL of a seeded monitor cannot be changed through the API (`400`), and it cannot be deleted (`409 INVALID_STATE`): it would come back on the next start. Pause it, or remove it from `MONITOR_SEEDS` and then delete it.
- `/ready` of most services caches its check for 10 s, so a dependency failure shows up within one interval plus 10 s.
