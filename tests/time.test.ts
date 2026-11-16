import { describe, expect, test } from "bun:test";
import { parseClaudeReset, zonedTimeToMs } from "../src/time";

describe("parseClaudeReset", () => {
  test("rolls a 5-hour reset to the next local occurrence", () => {
    const hitAt = Date.parse("2026-11-02T20:51:30.628Z");
    const reset = parseClaudeReset(
      "You've hit your 5-hour limit · resets 5:10pm (America/New_York)",
      hitAt,
      "America/New_York",
    );
    expect(reset).not.toBeNull();
    expect(reset!.resetAt).toBe(Date.parse("2026-11-02T22:10:00.000Z"));
  });

  test("rolls a weekly reset to the next day when the time has passed", () => {
    const hitAt = Date.parse("2026-11-12T02:26:00.000Z");
    const reset = parseClaudeReset(
      "You've hit your weekly limit · resets 1pm (America/New_York)",
      hitAt,
      "America/New_York",
    );
    expect(reset!.resetAt).toBe(Date.parse("2026-11-12T18:00:00.000Z"));
    expect(reset!.approximate).toBe(true);
  });

  test("returns null for unrelated text", () => {
    expect(parseClaudeReset("credit required", Date.now(), "UTC")).toBeNull();
  });
});

describe("zonedTimeToMs", () => {
  test("handles a daylight-saving offset", () => {
    const result = zonedTimeToMs(
      { year: 2026, month: 7, day: 1, hour: 12, minute: 0, second: 0 },
      "America/New_York",
    );
    expect(result).toBe(Date.parse("2026-07-01T16:00:00.000Z"));
  });
});
