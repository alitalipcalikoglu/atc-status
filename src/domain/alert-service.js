import { Signer } from '@atc-web/atc-service-core/http';
import { Ids } from '@atc-web/atc-service-core/ids';
import { StatusError } from './errors.js';

/** @typedef {import('../types.js').AlertRow} AlertRow */

/**
 * The platform's alert hub. Services publish `ops.*` events to atc-webhook-out; a seeded
 * subscription delivers them here, signed. Each event becomes an alert (one per type and key
 * while it is open, repeats inside ALERT_DEDUPE_MIN only raise the counter) and the first of a
 * kind is e-mailed to ALERT_EMAILS through atc-notify. Alerts stay open until acknowledged.
 */
export class AlertService {
  /** Known ops events: severity and a readable title. Anything else under `ops.` is a warning. */
  static KNOWN = Object.freeze({
    'ops.backup.failed': { severity: 'critical', title: 'Backup failed' },
    'ops.backup.stale': { severity: 'critical', title: 'Backups are stale' },
    'ops.queue.dead_letter': { severity: 'warning', title: 'Messages moved to the dead-letter state' },
    'ops.scheduler.job_failed': { severity: 'warning', title: 'A scheduled job failed' },
    'ops.webhook.subscription_disabled': { severity: 'warning', title: 'A webhook subscription was disabled' },
    'ops.audit.denied_spike': { severity: 'warning', title: 'Many denied requests' },
    'ops.payments.outbox_dead': { severity: 'critical', title: 'Payment events could not be delivered' },
  });

  /**
   * @param {object} deps
   * @param {import('../config.js').Config} deps.config
   * @param {import('../store/status-store.js').StatusStore} deps.store
   * @param {import('../net/notifier.js').Notifier|null} [deps.notifier]
   * @param {() => number} [deps.now]
   * @param {import('../types.js').Logger} [deps.logger]
   */
  constructor({ config, store, notifier = null, now = Date.now, logger }) {
    this.config = config;
    this.store = store;
    this.notifier = notifier;
    this.now = now;
    this.logger = logger;
  }

  /**
   * Verify a webhook-out delivery and raise an alert for an `ops.*` event.
   * @param {string} raw @param {string|undefined} signature
   * @returns {Promise<{ outcome: 'alerted'|'repeated'|'ignored', id: string|null }>}
   */
  async receive(raw, signature) {
    const secret = this.config.alertHookSecret;
    if (!secret) throw new StatusError('HOOK_DISABLED', 'ALERT_HOOK_SECRET is not set; the alert hook is disabled');
    if (!signature || !Signer.verify([secret], raw, signature, { now: this.now() })) throw new StatusError('INVALID_SIGNATURE', 'signature does not match');
    /** @type {any} */
    let event;
    try { event = JSON.parse(raw); } catch { throw new StatusError('INVALID_ARGUMENT', 'body is not JSON'); }
    const type = String(event?.type ?? '');
    if (!/^ops\.[a-z0-9._-]{1,100}$/.test(type)) return { outcome: 'ignored', id: null };
    return this.raise({ type, data: event.data && typeof event.data === 'object' ? event.data : {}, source: String(event.source ?? 'webhook-out') });
  }

  /**
   * @param {{ type: string, data: Record<string, any>, source: string }} a
   * @returns {Promise<{ outcome: 'alerted'|'repeated', id: string }>}
   */
  async raise({ type, data, source }) {
    const known = /** @type {Record<string, { severity: 'warning'|'critical', title: string }>} */ (AlertService.KNOWN)[type];
    const severity = known?.severity ?? 'warning';
    const title = known?.title ?? type;
    const key = AlertService.keyOf(data);
    const message = AlertService.describe(type, data);
    const payload = JSON.stringify(data).slice(0, 4_000);
    const now = this.now();
    const recent = this.store.alertRecent(type, key, now - this.config.alertDedupeMin * 60_000);
    if (recent && recent.acked_at === null) {
      this.store.alertBump(recent.id, now, message, payload);
      return { outcome: 'repeated', id: recent.id };
    }
    const id = Ids.create('alr', now);
    this.store.alertInsert({ id, type, key, severity, title, message, data: payload, source, at: now });
    this.logger?.warn({ alert: id, type, key }, 'alert raised');
    if (this.notifier) {
      try { await this.notifier.alert(/** @type {AlertRow} */ (this.store.alert(id))); } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        this.store.alertNotifyError(id, m);
        this.logger?.warn({ alert: id, error: m }, 'alert e-mail failed');
      }
    }
    return { outcome: 'alerted', id };
  }

  /** @param {string} id @param {string} by */
  ack(id, by) {
    const a = this.store.alert(id);
    if (!a) throw new StatusError('ALERT_NOT_FOUND', `no alert "${id}"`);
    this.store.alertAck(id, this.now(), by);
    return /** @type {AlertRow} */ (this.store.alert(id));
  }

  /** What makes two events "the same alert": a queue, a subscription, a source, whatever names the subject. @param {Record<string, any>} d */
  static keyOf(d) {
    for (const k of ['queue', 'subscription', 'source', 'job', 'id', 'name']) if (typeof d[k] === 'string' && d[k]) return d[k].slice(0, 120);
    return '-';
  }

  /** One readable line from an event's data. @param {string} type @param {Record<string, any>} d */
  static describe(type, d) {
    const parts = Object.entries(d).filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v)).slice(0, 8).map(([k, v]) => `${k}: ${String(v).slice(0, 200)}`);
    return `${type}${parts.length ? ` (${parts.join(', ')})` : ''}`;
  }
}
