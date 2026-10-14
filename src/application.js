import { NetGuard } from '@atc-web/atc-service-core/http';
import { AuditClient } from '@atc-web/atc-service-core/audit';
import { Lifecycle } from '@atc-web/atc-service-core/lifecycle';
import { readServiceVersion } from '@atc-web/atc-service-core/fastify';
import { Config } from './config.js';
import { Database } from './db.js';
import { AlertService } from './domain/alert-service.js';
import { StatusService } from './domain/status-service.js';
import { StatusApi } from './http/status-api.js';
import { Checker } from './net/checker.js';
import { Notifier } from './net/notifier.js';
import { StatusStore } from './store/status-store.js';
import { EventPublisher } from './events/event-publisher.js';

/** Composition root: wires configuration, storage, checker and HTTP, runs the check loop, owns the lifecycle. */
export class Application {
  static MAINTAIN_MS = 3_600_000;

  /** @param {Config} config */
  constructor(config) {
    this.config = config;
    this.version = readServiceVersion(import.meta.url);
    this.audit = new AuditClient({ target: config.audit });
    this.publisher = new EventPublisher({ source: 'atc-status', target: config.webhookOut });
    this.db = new Database(config.dbPath, { backupDir: config.dbBackupDir });
    this.store = new StatusStore(this.db);
    this.service = new StatusService({
      config, store: this.store,
      checker: new Checker({ guard: new NetGuard(config.target) }),
      notifier: config.notify ? new Notifier(config.notify) : null,
      publisher: this.publisher,
    });
    this.alerts = new AlertService({ config, store: this.store, notifier: config.notify ? new Notifier(config.notify) : null });
    /** @type {import('fastify').FastifyInstance|null} */
    this.app = null;
    /** @type {NodeJS.Timeout[]} */
    this.timers = [];
    /** @type {(reason: string) => Promise<void>} */
    this.shutdown = async () => {};
  }

  /** Build from `process.env`; exits with a readable message on bad configuration. */
  static fromEnv() {
    try {
      return new Application(Config.fromEnv());
    } catch (err) {
      if (err instanceof Error && err.name === 'ConfigError') {
        console.error(`configuration error: ${err.message}`);
        process.exit(1);
      }
      throw err;
    }
  }

  async start() {
    const { config } = this;
    const app = await new StatusApi({ config, audit: this.audit, publisher: this.publisher, service: this.service, alerts: this.alerts, db: this.db, version: this.version }).build();
    this.app = app;
    this.service.logger = app.log;
    this.alerts.logger = app.log;
    this.service.seed();
    const maintain = () => {
      try {
        const r = this.service.maintain();
        if (r.checks || r.incidents) app.log.info(r, 'status retention');
      } catch (err) { app.log.error({ err }, 'status retention failed'); }
    };
    maintain();
    const { shutdown } = Lifecycle.install({
      forceExitMs: 30_000,
      log: app.log,
      steps: [
        () => { for (const t of this.timers) clearInterval(t); this.service.stopping.abort(); },
        () => this.app?.close(),
        () => this.service.idle(),
        () => this.publisher.close(),
        () => this.audit.close(),
        () => this.db.close(),
      ],
    });
    this.shutdown = shutdown;
    this.audit.logger = app.log;
    this.publisher.logger = app.log;
    this.audit.start();
    await app.listen({ port: config.port, host: config.host });
    app.log.info({ tls: config.tls !== null, monitors: this.store.count(), notify: config.notify !== null }, config.tls ? 'serving HTTPS' : 'serving plain HTTP, terminate TLS at a reverse proxy');
    if (process.send) process.send('ready'); // PM2 wait_ready
    this.timers.push(setInterval(() => { this.service.runDue(); }, config.limits.tickMs), setInterval(maintain, Application.MAINTAIN_MS));
    for (const t of this.timers) t.unref();
  }
}
