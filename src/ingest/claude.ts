import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import type { UsageEvent, LimitEvent } from "../db";
import { insertEvents, insertLimitEvents } from "../db";
import { parseClaudeReset } from "../time";
import { ingestJsonl, walkFiles, type JsonlContext } from "./files";
import type { Config } from "../config";

export type ParserResult = {
  files: number;
  events: number;
  limits: number;
  errors: string[];
};

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function limitKind(text: string): string {
  if (/5-hour|5 hour/i.test(text)) return "5-hour";
  if (/weekly|7-day|seven-day/i.test(text)) return "weekly";
  if (/usage credits/i.test(text)) return "credits";
  return "rate limit";
}

function limitWindow(text: string): string {
  if (/5-hour|5 hour/i.test(text)) return "5h";
  if (/weekly|7-day|seven-day/i.test(text)) return "weekly";
  return "unknown";
}

export function parseClaudeLine(
  value: any,
  ctx: JsonlContext,
  timezone: string,
  events: UsageEvent[],
  limits: LimitEvent[],
): void {
  if (value?.type !== "assistant") return;
  const timestamp = Date.parse(value.timestamp);
  if (!Number.isFinite(timestamp)) return;
  const message = value.message ?? {};
  const model = typeof message.model === "string" ? message.model : "unknown";

  if (
    (value.isApiErrorMessage || message.model === "<synthetic>") &&
    (value.error === "rate_limit" || value.apiErrorStatus === 429)
  ) {
    const content = message.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .filter((part: any) => part?.type === "text")
              .map((part: any) => part.text)
              .join(" ")
          : "";
    if (!text) return;
    const reset = parseClaudeReset(text, timestamp, timezone);
    const kind = limitKind(text);
    limits.push({
      id: `claude-limit:${value.uuid ?? `${ctx.path}:${ctx.lineOffset}`}`,
      provider: "claude",
      timestamp,
      kind,
      window: limitWindow(text),
      message: String(text).slice(0, 500),
      resetsAt: reset?.resetAt ?? null,
    });
    return;
  }

  const usage = message.usage;
  if (!usage) return;
  const input = num(usage.input_tokens);
  const output = num(usage.output_tokens);
  const cacheRead = num(usage.cache_read_input_tokens);
  const cacheWrite = num(usage.cache_creation_input_tokens);
  const reasoning = num(usage.output_tokens_details?.thinking_tokens);
  const total = input + output + cacheRead + cacheWrite;
  if (total <= 0) return;
  const messageId =
    message.id ??
    value.requestId ??
    value.uuid ??
    `${ctx.path}:${ctx.lineOffset}`;
  events.push({
    id: `claude:${messageId}:${value.requestId ?? ""}`,
    provider: "claude",
    subscription: "claude",
    timestamp,
    model,
    project: String(value.cwd ?? ""),
    sessionId: String(value.sessionId ?? ""),
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning,
    total,
  });
}

export async function ingestClaude(
  db: Database,
  config: Config,
  progress?: (message: string) => void,
): Promise<ParserResult> {
  const root = join(homedir(), ".claude", "projects");
  const files = await walkFiles(root);
  let events = 0;
  let limits = 0;
  const errors: string[] = [];
  for (let i = 0; i < files.length; i++) {
    const path = files[i];
    progress?.(`Claude ${i + 1}/${files.length}`);
    const batch: UsageEvent[] = [];
    const limitBatch: LimitEvent[] = [];
    try {
      await ingestJsonl(db, path, "claude", (value, ctx) => {
        parseClaudeLine(value, ctx, config.timezone, batch, limitBatch);
        if (batch.length >= 250) {
          events += insertEvents(db, batch.splice(0));
        }
        if (limitBatch.length >= 50) {
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
