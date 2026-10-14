/** JSON Schemas for the HTTP surface. */
export class Schemas {
  static monitorId = { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,63}$' };
  static incidentId = { type: 'string', pattern: '^inc_[0-9a-z]{6,12}[0-9a-f]{16}$' };

  static putMonitor = {
    type: 'object', additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 100 },
      description: { type: 'string', maxLength: 500 },
      url: { type: 'string', minLength: 8, maxLength: 2_000, pattern: '^https?://' },
      method: { type: 'string', enum: ['GET', 'HEAD'] },
      intervalSec: { type: 'integer', minimum: 10, maximum: 86_400 },
      timeoutMs: { type: 'integer', minimum: 500, maximum: 60_000 },
      expectStatus: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'integer', minimum: 100, maximum: 599 } },
      failThreshold: { type: 'integer', minimum: 1, maximum: 20 },
      public: { type: 'boolean' },
      paused: { type: 'boolean' },
    },
  };

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
