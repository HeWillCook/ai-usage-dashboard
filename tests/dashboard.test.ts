import { describe, expect, test } from "bun:test";
import { freshTokens } from "../src/dashboard";

const row = { input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: 0 };

describe("freshTokens", () => {
  test("Claude: input + output (reasoning already inside) + cache writes, no cache reads", () => {
    expect(
      freshTokens({ ...row, provider: "claude", input: 10, output: 50, reasoning: 20, cache_read: 9000, cache_write: 300 }),
    ).toBe(360);
  });

  test("Codex: input includes cached reads, so they are subtracted", () => {
    expect(
      freshTokens({ ...row, provider: "codex", input: 1000, cache_read: 900, output: 40, reasoning: 10 }),
    ).toBe(140);
  });

  test("OpenCode: reasoning is reported separately and counted", () => {
    expect(
      freshTokens({ ...row, provider: "opencode", input: 100, output: 30, reasoning: 20, cache_read: 5000 }),
    ).toBe(150);
  });
});
