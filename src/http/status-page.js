/** Server-rendered public status page. No scripts; every value is escaped. */
export class StatusPage {
  static CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
  static LABELS = Object.freeze({
    overall: { operational: 'All systems operational', degraded: 'Some systems are degraded', outage: 'Some systems are down', maintenance: 'Maintenance in progress' },
    state: { up: 'Operational', degraded: 'Degraded', down: 'Down', unknown: 'No data', paused: 'Paused', maintenance: 'Maintenance' },
    update: { investigating: 'Investigating', identified: 'Identified', monitoring: 'Monitoring', resolved: 'Resolved' },
  });

  /** @param {unknown} v */
  static escape(v) {
    return String(v).replace(/[&<>"']/g, (c) => /** @type {Record<string, string>} */ ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  /** @param {number|null} v */
  static pct(v) {
    return v === null ? '–' : `${v.toFixed(v === 100 ? 0 : 2)}%`;
  }

  /** @param {number} s */
  static duration(s) {
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86_400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
    return `${Math.floor(s / 86_400)}d ${Math.floor((s % 86_400) / 3600)}h`;
  }

  /**
   * A short page for the subscription flow, in the status page's look.
   * @param {string} pageTitle @param {string} title @param {string} text @param {string} [form]  Trusted markup (a fixed form).
   * @param {string} [home]  Link back to the status page.
   */
  static message(pageTitle, title, text, form = '', home = '/status') {
    const e = StatusPage.escape;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${e(title)} · ${e(pageTitle)}</title>
<style>body{margin:0;background:#f6f7f9;color:#1d2330;font:15px/1.5 system-ui,sans-serif}main{max-width:520px;margin:12vh auto;padding:0 16px}h1{font-size:1.3rem}button{padding:8px 16px;border:0;border-radius:8px;background:#1d2330;color:#fff;font:inherit;font-weight:600;cursor:pointer}a{color:inherit}@media (prefers-color-scheme: dark){body{background:#11151c;color:#e7eaf0}button{background:#e7eaf0;color:#11151c}}</style></head>
<body><main><h1>${e(title)}</h1><p>${e(text)}</p>${form}<p><a href="${e(home)}">${e(pageTitle)}</a></p></main></body></html>`;
  }

  /** @param {any} d The value of StatusService#publicSummary(). */
  static render(d) {
    const e = StatusPage.escape;
    const rows = d.monitors.map((/** @type {any} */ m) => `
      <li class="row">
        <span class="dot ${e(m.state)}" aria-hidden="true"></span>
        <span class="name">${e(m.name)}</span>
        <span class="meta">${e(StatusPage.pct(m.uptime24h))} <small>24 h</small> · ${e(StatusPage.pct(m.uptime7d))} <small>7 d</small>${m.latencyMs === null ? '' : ` · ${e(m.latencyMs)} ms`}</span>
        <span class="state ${e(m.state)}">${e(StatusPage.LABELS.state[/** @type {'up'} */ (m.state)] ?? m.state)}</span>
      </li>`).join('');
    const incidents = d.incidents.length ? d.incidents.map((/** @type {any} */ i) => `
      <li class="row">
        <span class="dot ${i.closedAt ? 'up' : 'down'}" aria-hidden="true"></span>
        <span class="name">${e(i.monitor)}</span>
        <span class="meta"><time datetime="${e(i.openedAt)}">${e(i.openedAt.replace('T', ' ').slice(0, 16))} UTC</time> · ${e(StatusPage.duration(i.durationSec))}</span>
        <span class="state ${i.closedAt ? 'up' : 'down'}">${i.closedAt ? 'Resolved' : 'Ongoing'}</span>
      </li>${(i.updates ?? []).length ? `<li class="row updates">${i.updates.slice(-3).reverse().map((/** @type {any} */ u) => `<p><strong>${e(StatusPage.LABELS.update[/** @type {'resolved'} */ (u.status)] ?? u.status)}</strong> <time datetime="${e(u.at)}">${e(u.at.replace('T', ' ').slice(0, 16))} UTC</time> — ${e(u.message)}</p>`).join('')}</li>` : ''}`).join('') : '<li class="row empty">No incidents recorded.</li>';
    const maintenance = (d.maintenance ?? []).map((/** @type {any} */ w) => `
      <li class="row">
        <span class="dot maintenance" aria-hidden="true"></span>
        <span class="name">${e(w.title)}</span>
        <span class="meta"><time datetime="${e(w.startsAt)}">${e(w.startsAt.replace('T', ' ').slice(0, 16))}</time> – <time datetime="${e(w.endsAt)}">${e(w.endsAt.replace('T', ' ').slice(0, 16))} UTC</time>${w.monitors ? ` · ${e(w.monitors.join(', '))}` : ''}</span>
        <span class="state maintenance">${w.active ? 'In progress' : 'Planned'}</span>
        ${w.message ? `<p class="note">${e(w.message)}</p>` : ''}
      </li>`).join('');
    const subscribe = d.subscribe ? `<h2>Get updates</h2><form class="sub" method="post" action="status/subscribe"><label for="email">E-mail me when something goes down or recovers</label><span class="sub-row"><input id="email" name="email" type="email" required autocomplete="email" placeholder="you@example.com"><button type="submit">Subscribe</button></span></form>` : '';
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${e(d.title)}</title>
<style>
  :root { --bg: #f6f7f9; --card: #fff; --text: #1d2330; --muted: #626b7a; --line: #e3e6eb; --ok: #1f8a4c; --warn: #b7791f; --bad: #c53030; --none: #8a93a3; --maint: #2b6cb0; }
  @media (prefers-color-scheme: dark) { :root { --bg: #11151c; --card: #191e27; --text: #e7eaf0; --muted: #9aa3b2; --line: #2a313d; --ok: #48bb78; --warn: #ecc94b; --bad: #fc8181; --none: #6b7484; --maint: #63b3ed; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 32px 16px 48px; }
  h1 { font-size: 1.5rem; margin: 0 0 16px; }
  h2 { font-size: 1rem; margin: 28px 0 10px; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
  .banner { padding: 14px 16px; border-radius: 10px; font-weight: 600; color: #fff; }
  .banner.operational { background: var(--ok); } .banner.degraded { background: var(--warn); } .banner.outage { background: var(--bad); }
  ul { list-style: none; margin: 0; padding: 0; background: var(--card); border: 1px solid var(--line); border-radius: 10px; }
  .row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; padding: 12px 16px; border-top: 1px solid var(--line); }
  .row:first-child { border-top: 0; }
  .row.empty { color: var(--muted); }
  .dot { width: 10px; height: 10px; border-radius: 50%; flex: none; background: var(--none); }
  .name { font-weight: 600; flex: 1 1 160px; min-width: 0; overflow-wrap: anywhere; }
  .meta { color: var(--muted); font-size: .875rem; }
  .state { font-size: .875rem; font-weight: 600; margin-left: auto; }
  .up { color: var(--ok); } .dot.up { background: var(--ok); }
  .degraded { color: var(--warn); } .dot.degraded { background: var(--warn); }
  .down { color: var(--bad); } .dot.down { background: var(--bad); }
  .unknown, .paused { color: var(--none); }
  .maintenance { color: var(--maint); } .dot.maintenance { background: var(--maint); } .banner.maintenance { background: var(--maint); }
  .updates { display: block; color: var(--muted); font-size: .875rem; } .updates p, .note { margin: 2px 0; flex-basis: 100%; color: var(--muted); font-size: .875rem; }
  .sub { display: grid; gap: 8px; } .sub-row { display: flex; flex-wrap: wrap; gap: 8px; } .sub input { flex: 1 1 200px; min-width: 0; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); color: var(--text); font: inherit; } .sub button, form button { padding: 8px 16px; border: 0; border-radius: 8px; background: var(--text); color: var(--bg); font: inherit; font-weight: 600; cursor: pointer; }
  footer { margin-top: 24px; color: var(--muted); font-size: .8125rem; } footer a { color: inherit; }
</style>
</head>
<body>
<main>
  <h1>${e(d.title)}</h1>
  <div class="banner ${e(d.overall)}" role="status">${e(StatusPage.LABELS.overall[/** @type {'operational'} */ (d.overall)])}</div>
  ${maintenance ? `<h2>Maintenance</h2>
  <ul>${maintenance}</ul>` : ''}
  <h2>Services</h2>
  <ul>${rows || '<li class="row empty">No public monitors.</li>'}</ul>
  <h2>Recent incidents</h2>
  <ul>${incidents}</ul>
  ${subscribe}
  <footer>Updated <time datetime="${e(d.updatedAt)}">${e(d.updatedAt.replace('T', ' ').slice(0, 19))} UTC</time> · <a href="status/summary.json">JSON</a></footer>
</main>
</body>
</html>
`;
  }
}
