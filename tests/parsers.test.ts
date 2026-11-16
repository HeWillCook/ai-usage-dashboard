import { describe, expect, test } from "bun:test";
import { parseClaudeLine } from "../src/ingest/claude";
import { parseCodexLine } from "../src/ingest/codex";
import { openDb } from "../src/db";
import type { UsageEvent, LimitEvent } from "../src/db";
import type { JsonlContext } from "../src/ingest/files";

function context(state: Record<string, any> = {}): JsonlContext {
  return { path: "/tmp/test.jsonl", line: 1, lineOffset: 0, parserState: state };
}

describe("Claude parser", () => {
  test("extracts usage metadata without message content", () => {
    const events: UsageEvent[] = [];
    const limits: LimitEvent[] = [];
    parseClaudeLine(
      {
        type: "assistant",
        timestamp: "2026-11-11T12:00:00Z",
        cwd: "/Users/me/project",
        sessionId: "s1",
        requestId: "req_1",
        message: {
          id: "msg_1",
          model: "claude-opus-5-5",
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cache_read_input_tokens: 100,
            cache_creation_input_tokens: 30,
            output_tokens_details: { thinking_tokens: 5 },
          },
        },
      },
      context(),
      "America/New_York",
      events,
      limits,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      model: "claude-opus-5-5",
      input: 10,
      output: 20,
      cacheRead: 100,
      cacheWrite: 30,
      reasoning: 5,
      total: 160,
      project: "/Users/me/project",
    });
    expect(limits).toHaveLength(0);
  });

  test("captures a synthetic limit message", () => {
    const events: UsageEvent[] = [];
    const limits: LimitEvent[] = [];
    parseClaudeLine(
      {
        type: "assistant",
        timestamp: "2026-11-02T20:51:30.628Z",
        uuid: "u1",
        error: "rate_limit",
        apiErrorStatus: 429,
        isApiErrorMessage: true,
        message: {
          model: "<synthetic>",
          content: [
            {
              type: "text",
              text: "You've hit your 5-hour limit · resets 5:10pm (America/New_York)",
            },
          ],
        },
      },
      context(),
      "America/New_York",
      events,
      limits,
    );
    expect(events).toHaveLength(0);
    expect(limits).toHaveLength(1);
    expect(limits[0].window).toBe("5h");
    expect(limits[0].resetsAt).toBe(Date.parse("2026-11-02T22:10:00Z"));
  });
});

describe("Codex parser", () => {
  test("turns cumulative token counts into deltas", () => {
    const db = openDb(":memory:");
    const events: UsageEvent[] = [];
    const limits: LimitEvent[] = [];
    const state: Record<string, any> = {};
    parseCodexLine(
      {
        timestamp: "2026-11-11T12:00:00Z",
        type: "session_meta",
        payload: { id: "s1", cwd: "/tmp/p", model_provider: "openai" },
      },
      context(state),
      db,
      events,
      limits,
    );
    parseCodexLine(
      {
        timestamp: "2026-11-11T12:00:01Z",
        type: "turn_context",
        payload: { model: "gpt-6.1-sol", cwd: "/tmp/p" },
      },
      context(state),
      db,
      events,
      limits,
    );
    const token = (input: number, cached: number, output: number, resets: number) => ({
      timestamp: "2026-11-11T12:01:00Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: input,
            cached_input_tokens: cached,
            cache_write_input_tokens: 0,
            output_tokens: output,
            reasoning_output_tokens: 0,
            total_tokens: input + output,
          },
          last_token_usage: {
            input_tokens: input,
            cached_input_tokens: cached,
            output_tokens: output,
            reasoning_output_tokens: 0,
            total_tokens: input + output,
          },
        },
        rate_limits: {
          primary: { used_percent: 42, window_minutes: 10080, resets_at: resets },
          secondary: null,
          plan_type: "plus",
        },
      },
    });
    parseCodexLine(token(1_000, 400, 50, 1_800_000_000), context(state), db, events, limits);
    parseCodexLine(token(1_600, 800, 90, 1_800_000_000), context(state), db, events, limits);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      input: 600,
      cacheRead: 400,
      output: 40,
      total: 640,
      model: "gpt-6.1-sol",
    });
    const snapshot = db
      .query("SELECT used_percent AS used, window FROM limit_snapshots WHERE provider='codex'")
      .get() as { used: number; window: string };
    expect(snapshot).toEqual({ used: 42, window: "weekly" });
    db.close();
  });
});
