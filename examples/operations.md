# Operations

```bash
curl -s $STATUS/health   # {"status":"ok"}
curl -s $STATUS/ready    # {"status":"ok","monitors":36,"checker":"running","notify":"enabled"}
st $STATUS/v1/stats      # {"monitors":36,"up":35,"down":1,"degraded":0,"unknown":0,"paused":0,"openIncidents":1,"incidents24h":3,"notify":true}
```

Metrics (`read` key): `status_monitor_up{monitor}`, `status_check_latency_ms{monitor}`, `status_incident_open{monitor}`.

Retention runs at start and hourly: checks older than `CHECK_RETENTION_DAYS` (14), closed incidents older than `INCIDENT_RETENTION_DAYS` (365).

PM2: `pm2 start ecosystem.config.cjs` (one instance; two would check everything twice). Docker: `docker build -t atc-status . && docker run -p 3018:3018 -v atc-status-data:/data --env-file .env atc-status`.

Pitfalls:
- Run the status service where it sees the services the way users do; on the same host it cannot notice a network outage in front of them.
