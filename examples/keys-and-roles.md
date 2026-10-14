# API keys and roles

```bash
STATUS_API_KEYS=atc-console:<64 hex>:admin,grafana:<64 hex>:read
```

| Role | Can |
|---|---|
| `read` | Monitors, checks, incidents, stats, metrics |
| `admin` | Also create, change, check now and delete monitors |

The role is required. The public page and JSON need no key.
