import { createHash } from 'node:crypto';
/**
 * Incident e-mails through atc-notify's `generic` template. Idempotent per incident and event, so
 * a repeated send never mails twice.
 */
export class Notifier {
  /**
   * @param {import('../types.js').NotifyTarget} target
   * @param {typeof fetch} [fetchImpl]
   */
  constructor(target, fetchImpl = fetch) {
    this.target = target;
    this.fetch = fetchImpl;
  }

  /**
   * @param {'opened'|'closed'} event
   * @param {import('../types.js').IncidentRow} incident
   * @param {import('../types.js').MonitorRow} monitor
   */
  async incident(event, incident, monitor) {
    const opened = event === 'opened';
    const downFor = incident.closed_at ? Notifier.duration(incident.closed_at - incident.opened_at) : null;
    const res = await this.fetch(`${this.target.url}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.target.apiKey}`, 'content-type': 'application/json', 'idempotency-key': `atc-status:${incident.id}:${event}` },
      redirect: 'error',
      signal: AbortSignal.timeout(this.target.timeoutMs),
      body: JSON.stringify({
        channel: 'email',
        template: 'generic',
        to: this.target.to,
        data: {
          locale: 'en',
          appName: this.target.appName,
          subject: opened ? `DOWN: ${monitor.name}` : `RECOVERED: ${monitor.name}`,
          title: opened ? `${monitor.name} is down` : `${monitor.name} is back up`,
          paragraphs: opened
            ? [`The monitor ${monitor.id} failed ${incident.failures} checks in a row since ${new Date(incident.opened_at).toISOString()}.`, `Cause: ${incident.cause}`]
            : [`The monitor ${monitor.id} recovered at ${new Date(/** @type {number} */ (incident.closed_at)).toISOString()} after ${downFor}.`, `Incident ${incident.id}. Last error: ${incident.last_error ?? incident.cause}`],
        },
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let message = `atc-notify responded ${res.status}`;
      try { const j = JSON.parse(text); if (j?.error?.message) message = `atc-notify: ${j.error.message}`; } catch { /* not JSON */ }
      throw new Error(message);
    }
  }

  /** @param {import('../types.js').AlertRow} alert */
  async alert(alert) {
    const res = await this.fetch(`${this.target.url}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.target.apiKey}`, 'content-type': 'application/json', 'idempotency-key': `atc-status:${alert.id}` },
      redirect: 'error',
      signal: AbortSignal.timeout(this.target.timeoutMs),
      body: JSON.stringify({
        channel: 'email',
        template: 'generic',
        to: this.target.to,
        data: {
          locale: 'en',
          appName: this.target.appName,
          subject: `${alert.severity === 'critical' ? 'CRITICAL' : 'ALERT'}: ${alert.title}`.slice(0, 200),
          title: alert.title.slice(0, 200),
          paragraphs: [alert.message.slice(0, 1_900), `Type ${alert.type}, from ${alert.source}. Acknowledge it in the console to clear it.`],
        },
      }),
    });
    if (!res.ok) throw new Error(await Notifier.#reason(res));
  }

  /** @param {string} to @param {string} confirmUrl @param {string} pageTitle */
  async subscriberConfirm(to, confirmUrl, pageTitle) {
    await this.#generic(to, null, {
      subject: `Confirm your subscription to ${pageTitle}`.slice(0, 200),
      title: 'Confirm your subscription',
      paragraphs: [`Someone (hopefully you) asked to get an e-mail when something on "${pageTitle}" goes down or recovers.`, 'If that was not you, ignore this message; nothing happens without the click.'],
      button: { label: 'Confirm subscription', url: confirmUrl },
    });
  }

  /**
   * @param {'opened'|'closed'} event @param {import('../types.js').IncidentRow} incident @param {import('../types.js').MonitorRow} monitor
   * @param {string} to @param {string} unsubscribeUrl @param {string} pageTitle
   */
  async subscriberIncident(event, incident, monitor, to, unsubscribeUrl, pageTitle) {
    const opened = event === 'opened';
    // Idempotency-Key allows only A-Z a-z 0-9 . _ : - ; the address goes in as a hash.
    await this.#generic(to, `atc-status:${incident.id}:${event}:${createHash('sha256').update(to).digest('hex').slice(0, 16)}`, {
      subject: `${opened ? 'Outage' : 'Resolved'}: ${monitor.name}`.slice(0, 200),
      title: opened ? `${monitor.name} is having problems` : `${monitor.name} is working again`,
      paragraphs: [
        opened ? `We noticed a problem with ${monitor.name} at ${new Date(incident.opened_at).toISOString().replace('T', ' ').slice(0, 16)} UTC and are looking into it.` : `${monitor.name} recovered at ${new Date(/** @type {number} */ (incident.closed_at)).toISOString().replace('T', ' ').slice(0, 16)} UTC.`,
        `You get this because you subscribed to ${pageTitle}. Unsubscribe: ${unsubscribeUrl}`,
      ],
    });
  }

  /** @param {string} to @param {string|null} idempotencyKey @param {Record<string, unknown>} data */
  async #generic(to, idempotencyKey, data) {
    const res = await this.fetch(`${this.target.url}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.target.apiKey}`, 'content-type': 'application/json', ...(idempotencyKey ? { 'idempotency-key': idempotencyKey.slice(0, 255) } : {}) },
      redirect: 'error',
      signal: AbortSignal.timeout(this.target.timeoutMs),
      body: JSON.stringify({ channel: 'email', template: 'generic', to: [to], data: { locale: 'en', appName: this.target.appName, ...data } }),
    });
    if (!res.ok) throw new Error(await Notifier.#reason(res));
  }

  /** @param {Response} res */
  static async #reason(res) {
    const text = await res.text().catch(() => '');
    try { const j = JSON.parse(text); if (j?.error?.message) return `atc-notify: ${j.error.message}`; } catch { /* not JSON */ }
    return `atc-notify responded ${res.status}`;
  }

  /** @param {number} ms */
  static duration(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  }
}
