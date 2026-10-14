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
      headers: { authorization: `Bearer ${this.target.apiKey}`, 'content-type': 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(this.target.timeoutMs),
      body: JSON.stringify({
        channel: 'email',
        template: 'generic',
        to: this.target.to,
        idempotencyKey: `atc-status:${incident.id}:${event}`,
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
      headers: { authorization: `Bearer ${this.target.apiKey}`, 'content-type': 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(this.target.timeoutMs),
      body: JSON.stringify({
        channel: 'email',
        template: 'generic',
        to: this.target.to,
        idempotencyKey: `atc-status:${alert.id}`,
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
