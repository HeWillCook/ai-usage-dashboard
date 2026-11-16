import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import type { UsageEvent } from "../db";
import { getMeta, insertEvents, setMeta } from "../db";
import type { ParserResult } from "./claude";

type Row = {
  id: string;
  session_id: string;
  model: string | null;
  provider: string | null;
  input: number | null;
  output: number | null;
  reasoning: number | null;
  cache_read: number | null;
  cache_write: number | null;
  created: number | null;
  directory: string | null;
  title: string | null;
};

function n(value: unknown): number {
  const v = Number(value);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

export async function ingestOpenCode(
  db: Database,
  progress?: (message: string) => void,
): Promise<ParserResult> {
  const path = join(homedir(), ".local", "share", "opencode", "opencode.db");
  progress?.("OpenCode");
  let source: Database;
  try {
    source = new Database(path, { readonly: true });
  } catch (error: any) {
    return {
      files: 0,
      events: 0,
      limits: 0,
      errors: [`${path}: ${error?.message ?? error}`],
    };
  }
  try {
    source.exec("PRAGMA busy_timeout = 5000");
    const last = Number(getMeta(db, "opencode-last") ?? 0);
    const since = last > 0 ? Math.max(0, last - 60 * 60 * 1000) : 0;
    const rows = source
      .query(
        `SELECT m.id, m.session_id,
           json_extract(m.data, '$.model.id') AS model,
           json_extract(m.data, '$.model.providerID') AS provider,
           json_extract(m.data, '$.tokens.input') AS input,
           json_extract(m.data, '$.tokens.output') AS output,
           json_extract(m.data, '$.tokens.reasoning') AS reasoning,
           json_extract(m.data, '$.tokens.cache.read') AS cache_read,
           json_extract(m.data, '$.tokens.cache.write') AS cache_write,
           COALESCE(json_extract(m.data, '$.time.created'), m.time_created) AS created,
           s.directory, s.title
         FROM session_message m
         JOIN session_v2 s ON s.id = m.session_id
         WHERE m.type = 'assistant'
           AND m.time_created >= ?
           AND (s.time_archived IS NULL OR s.time_archived = 0)
           AND COALESCE(s.title, '') <> 'usage-dash advice'
         ORDER BY m.time_created ASC`,
      )
      .all(since) as Row[];

    const events: UsageEvent[] = [];
    let maxCreated = last;
    for (const row of rows) {
      const input = n(row.input);
      const output = n(row.output);
      const reasoning = n(row.reasoning);
      const cacheRead = n(row.cache_read);
      const cacheWrite = n(row.cache_write);
      const total = input + output + reasoning + cacheRead + cacheWrite;
      if (total <= 0) continue;
      const timestamp = Number(row.created);
      if (!Number.isFinite(timestamp) || timestamp <= 0) continue;
      maxCreated = Math.max(maxCreated, timestamp);
      const go = row.provider === "opencode-go";
      events.push({
        id: `oc:${row.id}`,
        provider: "opencode",
        subscription: go ? "opencode-go" : "opencode-free",
        timestamp,
        model: row.model ?? "unknown",
        project: row.directory ?? "",
        sessionId: row.session_id,
        input,
        output,
        cacheRead,
        cacheWrite,
        reasoning,
        total,
      });
    }
    const inserted = insertEvents(db, events);
    if (maxCreated > last) setMeta(db, "opencode-last", String(maxCreated));
    return {
      files: 1,
      events: inserted,
      limits: 0,
      errors: [],
    };
  } catch (error: any) {
    return {
      files: 0,
      events: 0,
      limits: 0,
      errors: [`${path}: ${error?.message ?? error}`],
    };
  } finally {
    source.close();
  }
}
