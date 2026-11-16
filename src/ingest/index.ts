import type { Database } from "bun:sqlite";
import type { Config } from "../config";
import { ingestClaude } from "./claude";
import { ingestCodex } from "./codex";
import { ingestOpenCode } from "./opencode";

export type IngestionStatus = {
  running: boolean;
  startedAt: number | null;
  finishedAt: number | null;
  label: string;
  lastDurationMs: number | null;
  lastError: string | null;
  errors: string[];
  runNumber: number;
};

let status: IngestionStatus = {
  running: false,
  startedAt: null,
  finishedAt: null,
  label: "Waiting",
  lastDurationMs: null,
  lastError: null,
  errors: [],
  runNumber: 0,
};

let timer: ReturnType<typeof setInterval> | null = null;
let active = false;

export function ingestionStatus(): IngestionStatus {
  return { ...status, errors: [...status.errors] };
}

export async function ingestOnce(
  db: Database,
  config: Config,
): Promise<IngestionStatus> {
  if (active) return ingestionStatus();
  active = true;
  const started = Date.now();
  status = {
    ...status,
    running: true,
    startedAt: started,
    label: "Starting scan",
    lastError: null,
    errors: [],
    runNumber: status.runNumber + 1,
  };
  const errors: string[] = [];
  try {
    const claude = await ingestClaude(db, config, (label) => {
      status.label = label;
      status.errors = [...errors];
    });
    errors.push(...claude.errors);
    status.label = "Codex";
    status.errors = [...errors];
    const codex = await ingestCodex(db, (label) => {
      status.label = label;
      status.errors = [...errors];
    });
    errors.push(...codex.errors);
    status.label = "OpenCode";
    status.errors = [...errors];
    const opencode = await ingestOpenCode(db, (label) => {
      status.label = label;
      status.errors = [...errors];
    });
    errors.push(...opencode.errors);
    status.label = "Ready";
  } catch (error: any) {
    errors.push(`${error?.message ?? error}`);
    status.label = "Scan failed";
  } finally {
    active = false;
    status = {
      ...status,
      running: false,
      finishedAt: Date.now(),
      lastDurationMs: Date.now() - started,
      lastError: errors[0] ?? null,
      errors,
    };
    const finishedAt = status.finishedAt;
    if (finishedAt) {
      db.query(
        "INSERT INTO meta(key,value) VALUES('last-scan',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      ).run(String(finishedAt));
    }
  }
  return ingestionStatus();
}

export function startIngestion(db: Database, config: Config): void {
  if (timer) return;
  void ingestOnce(db, config).catch((error) => {
    console.error("Initial usage scan failed", error);
  });
  timer = setInterval(() => {
    void ingestOnce(db, config).catch((error) => {
      console.error("Usage scan failed", error);
    });
  }, Math.max(15, config.scanIntervalSeconds) * 1000);
}

export function stopIngestion(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
