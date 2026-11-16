import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type UsageEvent = {
  id: string;
  provider: "claude" | "codex" | "opencode";
  subscription: "claude" | "codex" | "opencode-go" | "opencode-free";
  timestamp: number;
  model: string;
  project: string;
  sessionId: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  total: number;
};

export type LimitEvent = {
  id: string;
  provider: "claude" | "codex" | "opencode";
  timestamp: number;
  kind: string;
  window: string;
  message: string;
  resetsAt: number | null;
};

export type LimitSnapshot = {
  provider: string;
  window: string;
  usedPercent: number;
  resetsAt: number | null;
  updatedAt: number;
  source: string;
  status: string;
  resetLabel?: string | null;
};

export type AdviceRecord = {
  generatedAt: number;
  model: string;
  payload: string;
  error: string | null;
};

export function openDb(path: string): Database {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path, { create: true, strict: false });
  db.exec(`PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS file_state (
      path TEXT PRIMARY KEY,
      inode TEXT,
      offset INTEGER NOT NULL DEFAULT 0,
      size INTEGER NOT NULL DEFAULT 0,
      mtime INTEGER NOT NULL DEFAULT 0,
      parser TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT '{}',
      error TEXT,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      subscription TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      model TEXT NOT NULL,
      project TEXT NOT NULL DEFAULT '',
      session_id TEXT NOT NULL DEFAULT '',
      input INTEGER NOT NULL DEFAULT 0,
      output INTEGER NOT NULL DEFAULT 0,
      cache_read INTEGER NOT NULL DEFAULT 0,
      cache_write INTEGER NOT NULL DEFAULT 0,
      reasoning INTEGER NOT NULL DEFAULT 0,
      total INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS events_time_idx ON events(timestamp);
    CREATE INDEX IF NOT EXISTS events_provider_time_idx ON events(provider, timestamp);
    CREATE INDEX IF NOT EXISTS events_model_idx ON events(model);

    CREATE TABLE IF NOT EXISTS limit_events (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      kind TEXT NOT NULL,
      window TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL DEFAULT '',
      resets_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS limit_events_time_idx ON limit_events(timestamp);

    CREATE TABLE IF NOT EXISTS limit_snapshots (
      provider TEXT NOT NULL,
      window TEXT NOT NULL,
      used_percent REAL NOT NULL,
      resets_at INTEGER,
      updated_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ok',
      reset_label TEXT,
      PRIMARY KEY(provider, window)
    );

    CREATE TABLE IF NOT EXISTS advice (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      generated_at INTEGER NOT NULL,
      model TEXT NOT NULL,
      payload TEXT NOT NULL,
      error TEXT
    );
  `);
  return db;
}

export function getMeta(db: Database, key: string): string | null {
  const row = db.query("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | null;
  return row?.value ?? null;
}

export function setMeta(db: Database, key: string, value: string): void {
  db.query(
    "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(key, value);
}

export function insertEvents(db: Database, events: UsageEvent[]): number {
  if (!events.length) return 0;
  const stmt = db.query(`INSERT OR IGNORE INTO events
    (id, provider, subscription, timestamp, model, project, session_id,
     input, output, cache_read, cache_write, reasoning, total)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let inserted = 0;
  const tx = db.transaction((rows: UsageEvent[]) => {
    for (const event of rows) {
      const result = stmt.run(
        event.id,
        event.provider,
        event.subscription,
        event.timestamp,
        event.model,
        event.project,
        event.sessionId,
        event.input,
        event.output,
        event.cacheRead,
        event.cacheWrite,
        event.reasoning,
        event.total,
      );
      inserted += result.changes;
    }
  });
  tx(events);
  return inserted;
}

export function insertLimitEvents(db: Database, events: LimitEvent[]): number {
  if (!events.length) return 0;
  const stmt = db.query(`INSERT OR IGNORE INTO limit_events
    (id, provider, timestamp, kind, window, message, resets_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  let inserted = 0;
  const tx = db.transaction((rows: LimitEvent[]) => {
    for (const event of rows) {
      const result = stmt.run(
        event.id,
        event.provider,
        event.timestamp,
        event.kind,
        event.window,
        event.message,
        event.resetsAt,
      );
      inserted += result.changes;
    }
  });
  tx(events);
  return inserted;
}

export function upsertLimitSnapshot(db: Database, snapshot: LimitSnapshot): void {
  db.query(`INSERT INTO limit_snapshots
    (provider, window, used_percent, resets_at, updated_at, source, status, reset_label)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider, window) DO UPDATE SET
      used_percent=excluded.used_percent,
      resets_at=excluded.resets_at,
      updated_at=excluded.updated_at,
      source=excluded.source,
      status=excluded.status,
      reset_label=excluded.reset_label`).run(
    snapshot.provider,
    snapshot.window,
    snapshot.usedPercent,
    snapshot.resetsAt,
    snapshot.updatedAt,
    snapshot.source,
    snapshot.status,
    snapshot.resetLabel ?? null,
  );
}

export function getLimitSnapshots(db: Database, provider: string): LimitSnapshot[] {
  return db
    .query(
      "SELECT provider, window, used_percent AS usedPercent, resets_at AS resetsAt, updated_at AS updatedAt, source, status, reset_label AS resetLabel FROM limit_snapshots WHERE provider = ? ORDER BY window",
    )
    .all(provider) as LimitSnapshot[];
}

export function getAdvice(db: Database): AdviceRecord | null {
  const row = db
    .query(
      "SELECT generated_at AS generatedAt, model, payload, error FROM advice WHERE id = 1",
    )
    .get() as AdviceRecord | null;
  return row ?? null;
}

export function saveAdvice(db: Database, advice: AdviceRecord): void {
  db.query(`INSERT INTO advice(id, generated_at, model, payload, error)
    VALUES (1, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      generated_at=excluded.generated_at,
      model=excluded.model,
      payload=excluded.payload,
      error=excluded.error`).run(
    advice.generatedAt,
    advice.model,
    advice.payload,
    advice.error,
  );
}
