import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import type { UsageEvent, LimitEvent } from "../db";
import {
  insertEvents,
  insertLimitEvents,
  setMeta,
  upsertLimitSnapshot,
} from "../db";
import { ingestJsonl, walkFiles, type JsonlContext } from "./files";
import type { ParserResult } from "./claude";

function n(value: unknown): number {
  const v = Number(value);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function windowName(minutes: number): string {
  if (minutes === 300) return "5h";
  if (minutes === 10080) return "weekly";
  if (minutes === 1440) return "daily";
  return `${minutes}m`;
}

function windowLabel(minutes: number): string {
  if (minutes === 300) return "5-hour";
  if (minutes === 10080) return "weekly";
  if (minutes === 1440) return "daily";
  return `${Math.round(minutes / 60)}-hour`;
}

type Totals = {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
};

function parseTotals(value: any): Totals {
  return {
    input: n(value?.input_tokens),
    cached: n(value?.cached_input_tokens),
    cacheWrite: n(value?.cache_write_input_tokens),
    output: n(value?.output_tokens),
    reasoning: n(value?.reasoning_output_tokens),
  };
}

export function parseCodexLine(
  value: any,
  ctx: JsonlContext,
  db: Database,
  events: UsageEvent[],
  limits: LimitEvent[],
): void {
  const state = ctx.parserState;
  const payload = value?.payload ?? {};
  if (value?.type === "session_meta") {
    state.sessionId = payload.session_id ?? payload.id ?? state.sessionId;
    state.cwd = payload.cwd ?? state.cwd;
    state.provider = payload.model_provider ?? state.provider;
    return;
  }
  if (value?.type === "turn_context") {
    state.model = payload.model ?? state.model;
    state.cwd = payload.cwd ?? state.cwd;
    return;
  }
  if (value?.type !== "event_msg" || payload.type !== "token_count") return;
  const timestamp = Date.parse(value.timestamp);
  if (!Number.isFinite(timestamp)) return;
  const model = String(state.model ?? "unknown");
  const project = String(state.cwd ?? "");
  const sessionId = String(state.sessionId ?? "");
  const usage = payload.info ?? {};
  const last = parseTotals(usage.last_token_usage);
  const cumulative = parseTotals(usage.total_token_usage);

  let delta: Totals;
  if (cumulative.input + cumulative.output + cumulative.reasoning > 0) {
    const previous = state.lastTotals as Totals | undefined;
    if (previous) {
      const candidate = {
        input: cumulative.input - previous.input,
        cached: cumulative.cached - previous.cached,
        cacheWrite: cumulative.cacheWrite - previous.cacheWrite,
        output: cumulative.output - previous.output,
        reasoning: cumulative.reasoning - previous.reasoning,
      };
      const backwards =
        candidate.input < 0 ||
        candidate.output < 0 ||
        candidate.reasoning < 0;
      delta = backwards ? last : candidate;
    } else {
      delta = cumulative;
    }
    state.lastTotals = cumulative;
  } else {
    delta = last;
  }

  // OpenAI's cached input tokens are part of input tokens, not an addition.
  const total = delta.input + delta.output + delta.reasoning;
  if (total > 0) {
    events.push({
      id: `codex:${ctx.path}:${ctx.lineOffset}`,
      provider: "codex",
      subscription: "codex",
      timestamp,
      model,
      project,
      sessionId,
      input: delta.input,
      output: delta.output,
      cacheRead: delta.cached,
      cacheWrite: delta.cacheWrite,
      reasoning: delta.reasoning,
      total,
    });
  }

  const rateLimits = payload.rate_limits;
  if (rateLimits) {
    if (rateLimits.plan_type) setMeta(db, "codex-plan", String(rateLimits.plan_type));
    for (const key of ["primary", "secondary"] as const) {
      const window = rateLimits[key];
      if (!window || !Number.isFinite(Number(window.used_percent))) continue;
      const minutes = Number(window.window_minutes ?? 0);
      const id = windowName(minutes);
      const resetsAt = Number(window.resets_at)
        ? Number(window.resets_at) * 1000
        : null;
      upsertLimitSnapshot(db, {
        provider: "codex",
        window: id,
        usedPercent: Number(window.used_percent),
        resetsAt,
        updatedAt: timestamp,
        source: "codex-log",
        status: "exact",
        resetLabel: null,
      });
      if (Number(window.used_percent) >= 100 && resetsAt) {
        const limitId = `codex-limit:${rateLimits.limit_id ?? "codex"}:${id}:${resetsAt}`;
        limits.push({
          id: limitId,
          provider: "codex",
          timestamp,
          kind: "rate limit",
          window: id,
          message: `Codex ${windowLabel(minutes)} limit reached`,
          resetsAt,
        });
      }
    }
  }
}

export async function ingestCodex(
  db: Database,
  progress?: (message: string) => void,
): Promise<ParserResult> {
  const root = join(homedir(), ".codex", "sessions");
  const files = await walkFiles(root);
  let events = 0;
  let limits = 0;
  const errors: string[] = [];
  for (let i = 0; i < files.length; i++) {
    const path = files[i];
    progress?.(`Codex ${i + 1}/${files.length}`);
    const batch: UsageEvent[] = [];
    const limitBatch: LimitEvent[] = [];
    try {
      await ingestJsonl(db, path, "codex", (value, ctx) => {
        parseCodexLine(value, ctx, db, batch, limitBatch);
        if (batch.length >= 100) events += insertEvents(db, batch.splice(0));
        if (limitBatch.length >= 20) {
          limits += insertLimitEvents(db, limitBatch.splice(0));
        }
      });
      events += insertEvents(db, batch);
      limits += insertLimitEvents(db, limitBatch);
    } catch (error: any) {
      errors.push(`${path}: ${error?.message ?? error}`);
    }
  }
  return { files: files.length, events, limits, errors };
}
