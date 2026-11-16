export type Price = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  peak?: { input: number; output: number; cacheRead: number; cacheWrite: number };
};

/** USD per million tokens. These are list-price estimates, not subscription charges. */
const PRICES: Record<string, Price> = {
  "claude-opus-5-5": {
    input: 15,
    output: 75,
    cacheRead: 1.5,
    cacheWrite: 18.75,
  },
  "claude-sonnet-5-5": {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
  },
  "claude-haiku-5-5": {
    input: 1,
    output: 5,
    cacheRead: 0.1,
    cacheWrite: 1.25,
  },
  "gpt-6.1-sol": { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 3.75 },
  "gpt-6-astra": { input: 1.25, output: 10, cacheRead: 0.15, cacheWrite: 1.25 },
  "gpt-6-luna": { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
  "gpt-5.6-luna": { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
  "deepseek-v4.1-flash": {
    input: 0.15,
    output: 0.6,
    cacheRead: 0.003,
    cacheWrite: 0,
    peak: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
  },
  "deepseek-v4.1-flash-free": {
    input: 0.15,
    output: 0.6,
    cacheRead: 0.003,
    cacheWrite: 0,
    peak: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
  },
  "deepseek-v4-pro": {
    input: 0.66,
    output: 1.98,
    cacheRead: 0.022,
    cacheWrite: 0,
    peak: { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 },
  },
  "kimi-k3.1-pro": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2 },
  "kimi-k3": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 },
  "glm-5.3": { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
  "glm-5.3-flash": { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 },
  "qwen3.8-max": { input: 2, output: 6, cacheRead: 0.25, cacheWrite: 2.5 },
  "qwen3.8-flash": { input: 0.15, output: 0.47, cacheRead: 0.016, cacheWrite: 0.2 },
  "minimax-m3": { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
  "mimo-v2.6-flash": {
    input: 0.14,
    output: 0.28,
    cacheRead: 0.0028,
    cacheWrite: 0,
  },
};

export type CostFields = {
  model: string;
  provider: string;
  timestamp: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
};

function isDeepSeekPeak(timestamp: number): boolean {
  const date = new Date(timestamp);
  const day = date.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = date.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

export function estimateCost(event: CostFields): number | null {
  const price = PRICES[event.model];
  if (!price) return null;
  const rate =
    price.peak &&
    event.provider === "opencode" &&
    isDeepSeekPeak(event.timestamp)
      ? price.peak
      : price;
  const outputTokens =
    event.output + (event.provider === "opencode" ? event.reasoning : 0);
  return (
    (event.input * rate.input +
      outputTokens * rate.output +
      event.cacheRead * rate.cacheRead +
      event.cacheWrite * rate.cacheWrite) /
    1_000_000
  );
}

export function knownModels(): string[] {
  return Object.keys(PRICES).sort();
}
