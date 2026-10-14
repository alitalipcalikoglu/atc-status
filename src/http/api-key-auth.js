import { ApiKeyAuth as CoreApiKeyAuth } from '@atc-web/atc-service-core/auth';
import { StatusError } from '../domain/errors.js';

/** @typedef {import('../types.js').ApiKey} ApiKey */

/** Bearer API keys with two roles: `read` sees monitors, checks and incidents; `admin` also changes monitors. */
export class ApiKeyAuth {
  static GRANTS = Object.freeze({ read: ['read', 'admin'], admin: ['admin'] });

  /** @param {ApiKey[]} apiKeys */
  constructor(apiKeys) {
    this.core = new CoreApiKeyAuth(apiKeys.map((k) => ({ ...k, scopes: null })));
  }

  get hook() {
    return this.core.hook;
  }

  /** @param {'read'|'admin'} need */
  static require(need) {
    return CoreApiKeyAuth.require(need, {
      roleOf: (request) => /** @type {any} */ (request).apiKey?.role,
      makeError: (n) => new StatusError('FORBIDDEN', `this API key has no ${n} access`),
      grants: ApiKeyAuth.GRANTS,
    });
  }
}
