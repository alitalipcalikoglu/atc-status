/** JSON Schemas for the HTTP surface. */
export class Schemas {
  static monitorId = { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,63}$' };
  static pingParams = { type: 'object', properties: { id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,63}$' }, token: { type: 'string', pattern: '^[0-9a-f]{40}$' } }, required: ['id', 'token'] };
  static incidentId = { type: 'string', pattern: '^inc_[0-9a-z]{6,12}[0-9a-f]{16}$' };

  static putMonitor = {
    type: 'object', additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 100 },
      description: { type: 'string', maxLength: 500 },
      kind: { type: 'string', enum: ['http', 'tcp', 'tls', 'dns', 'heartbeat'] },
      dnsType: { type: 'string', enum: ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS'] },
      url: { type: 'string', minLength: 1, maxLength: 2_000, description: 'http/tcp/tls: an http(s) URL; dns: a host name.' },
      expectText: { type: ['string', 'null'], maxLength: 200 },
      warnDays: { type: 'integer', minimum: 1, maximum: 365 },
      graceSec: { type: 'integer', minimum: 0, maximum: 86_400 },
      rotateToken: { type: 'boolean' },
      method: { type: 'string', enum: ['GET', 'HEAD'] },
      intervalSec: { type: 'integer', minimum: 10, maximum: 86_400 },
      timeoutMs: { type: 'integer', minimum: 500, maximum: 60_000 },
      expectStatus: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'integer', minimum: 100, maximum: 599 } },
      failThreshold: { type: 'integer', minimum: 1, maximum: 20 },
      public: { type: 'boolean' },
      paused: { type: 'boolean' },
    },
  };

  static alertId = { type: 'string', pattern: '^alr_[0-9a-z]{6,12}[0-9a-f]{16}$' };
  static alertParams = { type: 'object', properties: { id: Schemas.alertId }, required: ['id'] };
  static alertsQuery = {
    type: 'object', additionalProperties: false,
    properties: { state: { type: 'string', enum: ['open', 'acked'] }, limit: { type: 'string', pattern: '^([1-9]|[1-9][0-9]|100)$' }, cursor: { type: 'string', pattern: '^[0-9]{1,15}~alr_[0-9a-z]{6,12}[0-9a-f]{16}$' } },
  };

  static maintenanceId = { type: 'string', pattern: '^mnt_[0-9a-z]{6,12}[0-9a-f]{12}$' };
  static maintenanceParams = { type: 'object', properties: { id: Schemas.maintenanceId }, required: ['id'] };
  static createMaintenance = {
    type: 'object', additionalProperties: false, required: ['title', 'startsAt', 'endsAt'],
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 120 }, message: { type: 'string', maxLength: 1_000 },
      monitors: { type: ['array', 'null'], maxItems: 100, items: Schemas.monitorId },
      startsAt: { type: 'string', format: 'date-time' }, endsAt: { type: 'string', format: 'date-time' },
    },
  };
  static incidentUpdate = { type: 'object', additionalProperties: false, required: ['status', 'message'], properties: { status: { type: 'string', enum: ['investigating', 'identified', 'monitoring', 'resolved'] }, message: { type: 'string', minLength: 1, maxLength: 2_000 } } };
  static subscriberParams = { type: 'object', properties: { id: { type: 'string', pattern: '^sub_[0-9a-z]{6,12}[0-9a-f]{12}$' } }, required: ['id'] };
  static tokenParams = { type: 'object', properties: { token: { type: 'string', pattern: '^[A-Za-z0-9_-]{20,64}$' } }, required: ['token'] };

  static monitorParams = { type: 'object', properties: { id: Schemas.monitorId }, required: ['id'] };
  static incidentParams = { type: 'object', properties: { id: Schemas.incidentId }, required: ['id'] };
  static checksQuery = { type: 'object', additionalProperties: false, properties: { limit: { type: 'string', pattern: '^([1-9]|[1-9][0-9]|1[0-9][0-9]|200)$' }, cursor: { type: 'string', pattern: '^[0-9]{1,15}$' } } };
  static incidentsQuery = {
    type: 'object', additionalProperties: false,
    properties: {
      monitor: Schemas.monitorId,
      state: { type: 'string', enum: ['open', 'closed'] },
      limit: { type: 'string', pattern: '^([1-9]|[1-9][0-9]|100)$' },
      cursor: { type: 'string', pattern: '^[0-9]{1,15}~inc_[0-9a-z]{6,12}[0-9a-f]{16}$' },
    },
  };
}
