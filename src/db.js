import { Database as CoreDatabase } from '@atc-web/atc-service-core/db';

/** SQLite connection with schema migrations applied on open. */
export class Database extends CoreDatabase {
  static MIGRATIONS = [
    `
    CREATE TABLE monitors (
      id                   TEXT PRIMARY KEY,
      name                 TEXT NOT NULL,
      description          TEXT NOT NULL DEFAULT '',
      url                  TEXT NOT NULL,
      method               TEXT NOT NULL CHECK (method IN ('GET', 'HEAD')),
      interval_sec         INTEGER NOT NULL,
      timeout_ms           INTEGER NOT NULL,
      expect_status        TEXT NOT NULL,
      fail_threshold       INTEGER NOT NULL,
      public               INTEGER NOT NULL DEFAULT 0,
      paused               INTEGER NOT NULL DEFAULT 0,
      origin               TEXT NOT NULL CHECK (origin IN ('env', 'api')),
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_check_at        INTEGER,
      last_ok              INTEGER,
      last_status          INTEGER,
      last_latency_ms      INTEGER,
      last_error           TEXT,
      next_at              INTEGER NOT NULL,
      created_by           TEXT NOT NULL,
      created_at           INTEGER NOT NULL,
      updated_at           INTEGER NOT NULL
    );
    CREATE INDEX monitors_due ON monitors (paused, next_at);

    CREATE TABLE checks (
      seq        INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor    TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
      at         INTEGER NOT NULL,
      ok         INTEGER NOT NULL,
      status     INTEGER,
      latency_ms INTEGER NOT NULL,
      error      TEXT
    );
    CREATE INDEX checks_monitor ON checks (monitor, at);
    CREATE INDEX checks_at ON checks (at);

    -- One open incident per monitor at most (closed_at IS NULL).
    CREATE TABLE incidents (
      id           TEXT PRIMARY KEY,
      monitor      TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
      opened_at    INTEGER NOT NULL,
      closed_at    INTEGER,
      cause        TEXT NOT NULL,
      last_error   TEXT,
      failures     INTEGER NOT NULL,
      notify_error TEXT
    );
    CREATE UNIQUE INDEX incidents_open ON incidents (monitor) WHERE closed_at IS NULL;
    CREATE INDEX incidents_opened ON incidents (opened_at DESC);
    `,
  ];
}
