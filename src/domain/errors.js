/** Domain error with a stable code and the HTTP status the API maps it to. */
export class StatusError extends Error {
  /** @type {Record<string, number>} */
  static STATUS = {
    MONITOR_NOT_FOUND: 404,
    INCIDENT_NOT_FOUND: 404,
    ALERT_NOT_FOUND: 404,
    INVALID_SIGNATURE: 400,
    HOOK_DISABLED: 503,
    INVALID_STATE: 409,
    LIMIT_EXCEEDED: 409,
    INVALID_ARGUMENT: 400,
    TARGET_NOT_ALLOWED: 400,
    FORBIDDEN: 403,
  };

  /**
   * @param {keyof typeof StatusError.STATUS} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'StatusError';
    this.code = code;
    this.statusCode = StatusError.STATUS[code];
    this.details = details;
  }
}
