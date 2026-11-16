import { describe, expect, test } from "bun:test";
import { estimateCost } from "../src/pricing";

describe("pricing", () => {
  test("prices Claude cache reads separately", () => {
    const cost = estimateCost({
      model: "claude-sonnet-5-5",
      provider: "claude",
      timestamp: Date.parse("2026-11-11T12:00:00Z"),
      input: 1_000_000,
      output: 100_000,
      cacheRead: 1_000_000,
      cacheWrite: 0,
      reasoning: 0,
    });
    expect(cost).toBeCloseTo(4.8, 4);
  });

  test("adds OpenCode reasoning to output tokens", () => {
    const cost = estimateCost({
      model: "deepseek-v4.1-flash",
      provider: "opencode",
      timestamp: Date.parse("2026-11-11T12:00:00Z"),
      input: 1_000_000,
      output: 100_000,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 100_000,
    });
    expect(cost).toBeCloseTo(0.27, 4);
  });

  test("returns null when the model has no known price", () => {
    expect(
      estimateCost({
        model: "mystery",
        provider: "opencode",
        timestamp: Date.now(),
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
      }),
    ).toBeNull();
  });
});
