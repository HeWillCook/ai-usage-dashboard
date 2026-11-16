import type { Database } from "bun:sqlite";
import type { Config } from "./config";
import {
  getAdvice,
  getLimitSnapshots,
  getMeta,
  type AdviceRecord,
} from "./db";
import { goStatus, type GoStatus } from "./go-usage";
import { ingestionStatus } from "./ingest";
import { estimateCost } from "./pricing";
import { formatDateTime, formatTime, hourOfDay, localParts } from "./time";

type EventRow = {
  id: string;
  provider: "claude" | "codex" | "opencode";
  subscription: "claude" | "codex" | "opencode-go" | "opencode-free";
  timestamp: number;
  model: string;
  project: string;
  session_id: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  reasoning: number;
  total: number;
};

type LimitRow = {
  id: string;
  provider: string;
  timestamp: number;
  kind: string;
  window: string;
  message: string;
  resets_at: number | null;
};

export type WindowView = {
  id: string;
  label: string;
  percent: number | null;
  resetAt: number | null;
  confidence: "exact" | "estimated" | "capped" | "stale" | "unknown";
  source: string;
  detail: string;
  updatedAt: number | null;
};

export type CardView = {
  id: "claude" | "codex" | "opencode";
  name: string;
  subtitle: string;
  windows: WindowView[];
  note: string;
  sparkline: number[];
  rangeTokens: number;
};

export type Dashboard = ReturnType<typeof buildDashboard>;

const RANGE_DAYS: Record<string, number> = {
  "1d": 1,
  "7d": 7,
  "30d": 30,
};
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function normalizeProject(path: string): string {
  if (!path) return "(unknown)";
  const parts = path.split("/").filter(Boolean);
  const t3Worktree = parts.indexOf("worktrees");
  if (t3Worktree >= 0 && parts[t3Worktree - 1] === ".t3" && parts[t3Worktree + 1]) {
    return parts[t3Worktree + 1];
  }
  const claudeWorktree = parts.indexOf("worktrees");
  if (
    claudeWorktree >= 0 &&
    parts[claudeWorktree - 1] === ".claude" &&
    parts[claudeWorktree + 1]
  ) {
    return parts[claudeWorktree + 1];
  }
  const t3Project = parts.indexOf("projects");
  if (t3Project >= 0 && parts[t3Project - 1] === ".t3" && parts[t3Project + 1]) {
    return parts[t3Project + 1];
  }
  if (path.includes("/.t3/scratch/")) return "Scratch";
  return parts.at(-1) || "(unknown)";
}

function emptyTotals() {
  return {
    tokens: 0,
    fresh: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    cost: 0,
    events: 0,
    unpriced: 0,
  };
}

function addEvent(
  totals: ReturnType<typeof emptyTotals>,
  event: EventRow,
  cost: number | null,
): void {
  totals.tokens += event.total;
  totals.fresh += freshTokens(event);
  totals.input += event.input;
  totals.output += event.output;
  totals.cacheRead += event.cache_read;
  totals.cacheWrite += event.cache_write;
  totals.reasoning += event.reasoning;
  totals.events += 1;
  if (cost == null) totals.unpriced += 1;
  else totals.cost += cost;
}

function rangeStart(db: Database, range: string, now: number): number {
  if (range === "all") {
    const row = db.query("SELECT MIN(timestamp) AS min FROM events").get() as {
      min: number | null;
    };
    return row.min ?? now - 30 * DAY;
  }
  return now - (RANGE_DAYS[range] ?? 7) * DAY;
}

function weighted(totals: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}): number {
  return (
    totals.input +
    totals.output * 4 +
    totals.cacheWrite * 1.25 +
    totals.cacheRead * 0.1
  );
}

function percent(current: number, cap: number | null): number | null {
  if (!cap || cap <= 0) return null;
  return Math.max(0, Math.round((current / cap) * 1000) / 10);
}

function quantile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * q;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function sumWeights(rows: EventRow[], start: number, end: number): number {
  let value = 0;
  for (const row of rows) {
    if (row.provider !== "claude" || row.timestamp < start || row.timestamp >= end) {
      continue;
    }
    value += weighted({
      input: row.input,
      output: row.output,
      cacheRead: row.cache_read,
      cacheWrite: row.cache_write,
    });
  }
  return value;
}

function claudeWindows(
  allClaude: EventRow[],
  limits: LimitRow[],
  now: number,
  timezone: string,
): WindowView[] {
  const windows: WindowView[] = [];
  const definitions = [
    { id: "5h", label: "5-hour", span: 5 * HOUR },
    { id: "weekly", label: "Weekly", span: 7 * DAY },
  ];
  for (const def of definitions) {
    const history = limits
      .filter((event) => event.provider === "claude" && event.window === def.id)
      .sort((a, b) => a.timestamp - b.timestamp);
    const liveCap = [...history]
      .reverse()
      .find((event) => event.resets_at && event.resets_at > now);
    if (liveCap) {
      windows.push({
        id: def.id,
        label: def.label,
        percent: 100,
        resetAt: liveCap.resets_at,
        confidence: "capped",
        source: "Claude Code limit message",
        detail: "Confirmed capped from the logged limit message.",
        updatedAt: liveCap.timestamp,
      });
      continue;
    }
    if (!history.length && def.id === "weekly") continue;
    const caps = history
      .map((event) =>
        sumWeights(allClaude, event.timestamp - def.span, event.timestamp),
      )
      .filter((value) => value > 0);
    const cap = quantile(caps, 0.75);
    // A window that reset after a logged cap starts fresh at that reset, not a
    // trailing span ago, so a passed cap does not keep reading as 100%.
    const lastReset = history
      .map((event) => event.resets_at ?? 0)
      .filter((value) => value > now - def.span && value <= now)
      .reduce((max, value) => Math.max(max, value), 0);
    const windowStart = Math.max(now - def.span, lastReset);
    const current = sumWeights(allClaude, windowStart, now);
    let resetAt: number | null = null;
    if (def.id === "weekly" && lastReset) {
      resetAt = lastReset + def.span;
    }
    if (def.id === "5h") {
      const recent = allClaude.filter(
        (event) => event.provider === "claude" && event.timestamp >= windowStart,
      );
      if (recent.length) {
        resetAt = Math.min(...recent.map((event) => event.timestamp)) + def.span;
        if (resetAt <= now) resetAt = null;
      }
    }
    windows.push({
      id: def.id,
      label: def.label,
      percent: percent(current, cap),
      resetAt,
      confidence: cap ? "estimated" : "unknown",
      source: "Claude Code logs",
      detail: cap
        ? resetAt
          ? `Estimated from ${history.length} prior limit${history.length === 1 ? "" : "s"}; reset is approximate.`
          : `Estimated from ${history.length} prior limit${history.length === 1 ? "" : "s"}.`
        : `Needs one logged Claude ${def.label.toLowerCase()} limit to calibrate.`,
      updatedAt: allClaude.length
        ? Math.max(...allClaude.map((event) => event.timestamp))
        : null,
    });
  }
  return windows;
}

function codexWindows(
  db: Database,
  now: number,
  timezone: string,
): WindowView[] {
  return getLimitSnapshots(db, "codex")
    .sort((a, b) => (a.window === "weekly" ? -1 : 1))
    .map((snapshot) => {
      const resetPassed = Boolean(snapshot.resetsAt && snapshot.resetsAt < now);
      const stale =
        resetPassed ||
        Boolean(snapshot.updatedAt && now - snapshot.updatedAt > 8 * DAY);
      return {
        id: snapshot.window,
        label:
          snapshot.window === "weekly"
            ? "Weekly"
            : snapshot.window === "5h"
              ? "5-hour"
              : snapshot.window,
        percent: resetPassed ? null : snapshot.usedPercent,
        resetAt: resetPassed ? null : snapshot.resetsAt,
        confidence: stale ? ("stale" as const) : ("exact" as const),
        source: "Codex rate-limit snapshot",
        detail: resetPassed
          ? "The logged reset has passed; waiting for Codex to record a fresh window."
          : `Exact snapshot from ${formatDateTime(snapshot.updatedAt, timezone)}.`,
        updatedAt: snapshot.updatedAt,
      };
    });
}

function goWindows(
  db: Database,
  now: number,
  timezone: string,
  go: GoStatus,
): WindowView[] {
  return getLimitSnapshots(db, "opencode")
    .sort((a, b) => {
      const order: Record<string, number> = { rolling: 0, weekly: 1, monthly: 2 };
      return (order[a.window] ?? 9) - (order[b.window] ?? 9);
    })
    .map((snapshot) => ({
      id: snapshot.window,
      label:
        snapshot.window === "rolling"
          ? "Rolling 5-hour"
          : snapshot.window === "weekly"
            ? "Weekly"
            : "Monthly",
      percent: snapshot.usedPercent,
      resetAt: snapshot.resetsAt,
      confidence: go.ok ? ("exact" as const) : ("stale" as const),
      source: "OpenCode Go API",
      detail: go.ok
        ? `Server-reported ${formatTime(snapshot.updatedAt, timezone)}.`
        : `Last server snapshot ${formatTime(snapshot.updatedAt, timezone)}${go.error ? `; ${go.error}` : ""}.`,
      updatedAt: snapshot.updatedAt,
    }));
}

const BUCKETS: Record<string, number> = {
  "15m": 15 * 60_000,
  "1h": HOUR,
  "3h": 3 * HOUR,
  "6h": 6 * HOUR,
  "1d": DAY,
};

/** Resolutions offered per range; the first is the default. */
export const RESOLUTIONS: Record<string, string[]> = {
  "1d": ["15m", "1h"],
  "7d": ["1h", "3h", "6h", "1d"],
  "30d": ["6h", "3h", "1d"],
  all: ["1d", "6h"],
};

type MetricArrays = { tokens: number[]; fresh: number[]; cost: number[] };
type TimelineSeries = MetricArrays & {
  key: string;
  label: string;
  provider: string;
};

/** Tokens that cost real work: everything except cache reads. */
export function freshTokens(row: {
  provider: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  reasoning: number;
}): number {
  const input =
    row.provider === "codex" ? Math.max(0, row.input - row.cache_read) : row.input;
  // Claude and Codex already count reasoning inside output; OpenCode does not.
  const output =
    row.provider === "opencode" ? row.output + row.reasoning : row.output;
  return input + output + row.cache_write;
}

function localOffset(timestamp: number, timezone: string): number {
  const p = localParts(timestamp, timezone);
  return (
    Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) -
    Math.floor(timestamp / 1000) * 1000
  );
}

/** Start of the bucket containing `timestamp`, aligned to local wall-clock time. */
function bucketStart(timestamp: number, size: number, timezone: string): number {
  const offset = localOffset(timestamp, timezone);
  return Math.floor((timestamp + offset) / size) * size - offset;
}

function timeline(
  rows: EventRow[],
  costs: (number | null)[],
  range: string,
  requested: string | undefined,
  start: number,
  now: number,
  timezone: string,
) {
  const options = RESOLUTIONS[range] ?? RESOLUTIONS["7d"];
  let resolution =
    requested && options.includes(requested) ? requested : options[0];
  if (range === "all" && !requested && now - start < 45 * DAY) resolution = "6h";
  const size = BUCKETS[resolution];
  const first = bucketStart(start, size, timezone);
  const starts: number[] = [];
  for (let at = first; at <= now && starts.length < 2000; ) {
    starts.push(at);
    // step by wall clock so DST days stay aligned
    const next = bucketStart(at + size + size / 2, size, timezone);
    at = next > at ? next : at + size;
  }
  // Last bucket starting at or before `timestamp` (robust across DST shifts).
  const locate = (timestamp: number): number | null => {
    if (!starts.length || timestamp < starts[0]) return null;
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= timestamp) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const blank = (): MetricArrays => ({
    tokens: new Array(starts.length).fill(0),
    fresh: new Array(starts.length).fill(0),
    cost: new Array(starts.length).fill(0),
  });
  const providers = new Map<string, TimelineSeries>();
  for (const id of ["claude", "codex", "opencode"]) {
    providers.set(id, { key: id, label: id, provider: id, ...blank() });
  }
  const models = new Map<string, TimelineSeries & { total: number }>();
  rows.forEach((row, rowIndex) => {
    const i = locate(row.timestamp);
    if (i == null) return;
    const fresh = freshTokens(row);
    const cost = costs[rowIndex] ?? 0;
    const provider = providers.get(row.provider)!;
    provider.tokens[i] += row.total;
    provider.fresh[i] += fresh;
    provider.cost[i] += cost;
    const modelKey = `${row.provider}:${row.model}`;
    let model = models.get(modelKey);
    if (!model) {
      model = { key: modelKey, label: row.model, provider: row.provider, total: 0, ...blank() };
      models.set(modelKey, model);
    }
    model.tokens[i] += row.total;
    model.fresh[i] += fresh;
    model.cost[i] += cost;
    model.total += row.total;
  });
  // Keep the chart legible: top models by volume, the rest folded into "Other".
  const ranked = [...models.values()].sort((a, b) => b.total - a.total);
  const top = ranked.slice(0, 7);
  const rest = ranked.slice(7);
  const modelSeries: TimelineSeries[] = top.map(({ total, ...series }) => series);
  if (rest.length) {
    const other: TimelineSeries = { key: "other", label: `${rest.length} other models`, provider: "other", ...blank() };
    for (const series of rest) {
      for (let i = 0; i < starts.length; i++) {
        other.tokens[i] += series.tokens[i];
        other.fresh[i] += series.fresh[i];
        other.cost[i] += series.cost[i];
      }
    }
    modelSeries.push(other);
  }
  return {
    resolution,
    resolutions: options,
    bucketMs: size,
    starts,
    providers: [...providers.values()],
    models: modelSeries,
  };
}

function weekHeatmap(rows: EventRow[], timezone: string) {
  // weekday 0 = Monday … 6 = Sunday; values in total and fresh tokens
  const tokens = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const fresh = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const row of rows) {
    const p = localParts(row.timestamp, timezone);
    const weekday = (new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay() + 6) % 7;
    tokens[weekday][p.hour] += row.total;
    fresh[weekday][p.hour] += freshTokens(row);
  }
  return { tokens, fresh };
}

function sessionHistogram(rows: EventRow[]): { label: string; count: number }[] {
  const sessions = new Map<
    string,
    { start: number; end: number; provider: string }
  >();
  for (const row of rows) {
    if (!row.session_id) continue;
    const key = `${row.provider}:${row.session_id}`;
    const value = sessions.get(key);
    if (!value) {
      sessions.set(key, {
        start: row.timestamp,
        end: row.timestamp,
        provider: row.provider,
      });
    } else {
      value.start = Math.min(value.start, row.timestamp);
      value.end = Math.max(value.end, row.timestamp);
    }
  }
  const bins = [0, 0, 0, 0, 0, 0];
  for (const session of sessions.values()) {
    const minutes = (session.end - session.start) / 60_000;
    const index =
      minutes < 5 ? 0 : minutes < 15 ? 1 : minutes < 30 ? 2 : minutes < 60 ? 3 : minutes < 120 ? 4 : 5;
    bins[index]++;
  }
  return ["<5m", "5–15m", "15–30m", "30–60m", "1–2h", "2h+"].map(
    (label, index) => ({ label, count: bins[index] }),
  );
}

function parseAdvice(record: AdviceRecord | null) {
  if (!record) return null;
  let parsed: any = null;
  try {
    parsed = JSON.parse(record.payload);
  } catch {
    parsed = { headline: record.payload, recommendations: [] };
  }
  return {
    generatedAt: record.generatedAt,
    model: record.model,
    headline: String(parsed?.headline ?? record.payload),
    recommendations: Array.isArray(parsed?.recommendations)
      ? parsed.recommendations.slice(0, 2).map(String)
      : [],
    error: record.error,
  };
}

export function buildDashboard(
  db: Database,
  config: Config,
  requestedRange = config.range,
  requestedResolution?: string,
) {
  const now = Date.now();
  const range = ["1d", "7d", "30d", "all"].includes(requestedRange)
    ? requestedRange
    : "7d";
  const start = rangeStart(db, range, now);
  const allClaude = db
    .query(
      `SELECT id, provider, subscription, timestamp, model, project, session_id,
        input, output, cache_read, cache_write, reasoning, total
       FROM events WHERE provider = 'claude' ORDER BY timestamp`,
    )
    .all() as EventRow[];
  const rows = db
    .query(
      `SELECT id, provider, subscription, timestamp, model, project, session_id,
        input, output, cache_read, cache_write, reasoning, total
       FROM events WHERE timestamp >= ? ORDER BY timestamp`,
    )
    .all(start) as EventRow[];
  const allLimits = db
    .query(
      `SELECT id, provider, timestamp, kind, window, message,
        resets_at FROM limit_events ORDER BY timestamp DESC`,
    )
    .all() as LimitRow[];
  const seenLimits = new Set<string>();
  const limits = allLimits.filter((event) => {
    if (event.timestamp < start) return false;
    const key = `${event.provider}:${event.window}:${event.resets_at ?? Math.floor(event.timestamp / 60_000)}`;
    if (seenLimits.has(key)) return false;
    seenLimits.add(key);
    return true;
  });

  const totals = emptyTotals();
  const providerTotals: Record<string, ReturnType<typeof emptyTotals>> = {
    claude: emptyTotals(),
    codex: emptyTotals(),
    opencode: emptyTotals(),
  };
  const modelMap = new Map<
    string,
    ReturnType<typeof emptyTotals> & {
      model: string;
      provider: string;
      lastAt: number;
    }
  >();
  const projectMap = new Map<
    string,
    { project: string; tokens: number; fresh: number; cost: number }
  >();
  const hourBins = Array.from({ length: 24 }, (_, hour) => ({ hour, tokens: 0 }));
  const costs = rows.map((row) =>
    estimateCost({
      model: row.model,
      provider: row.provider,
      timestamp: row.timestamp,
      input: row.input,
      output: row.output,
      cacheRead: row.cache_read,
      cacheWrite: row.cache_write,
      reasoning: row.reasoning,
    }),
  );
  rows.forEach((row, rowIndex) => {
    const cost = costs[rowIndex];
    addEvent(totals, row, cost);
    addEvent(providerTotals[row.provider], row, cost);
    const modelKey = `${row.provider}:${row.model}`;
    let model = modelMap.get(modelKey);
    if (!model) {
      model = {
        ...emptyTotals(),
        model: row.model,
        provider: row.provider,
        lastAt: row.timestamp,
      };
      modelMap.set(modelKey, model);
    }
    addEvent(model, row, cost);
    model.lastAt = Math.max(model.lastAt, row.timestamp);
    const projectKey = normalizeProject(row.project);
    let project = projectMap.get(projectKey);
    if (!project) {
      project = { project: projectKey, tokens: 0, fresh: 0, cost: 0 };
      projectMap.set(projectKey, project);
    }
    project.tokens += row.total;
    project.fresh += freshTokens(row);
    project.cost += costs[rowIndex] ?? 0;
    hourBins[hourOfDay(row.timestamp, config.timezone)].tokens += row.total;
  });

  const models = [...modelMap.values()]
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 12)
    .map((model) => ({
      model: model.model,
      provider: model.provider,
      tokens: model.tokens,
      input: model.input,
      output: model.output,
      cacheRead: model.cacheRead,
      cacheWrite: model.cacheWrite,
      reasoning: model.reasoning,
      cost: model.cost,
      fresh: model.fresh,
      events: model.events,
      lastAt: model.lastAt,
    }));
  const projects = [...projectMap.values()]
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 8);
  const go = goStatus();
  const codexPlan = getMeta(db, "codex-plan");
  const series = timeline(
    rows,
    costs,
    range,
    requestedResolution,
    start,
    now,
    config.timezone,
  );
  const card = (
    id: "claude" | "codex" | "opencode",
    name: string,
    subtitle: string,
    windows: WindowView[],
    note: string,
  ): CardView => {
    const sparkline = series.providers.find((item) => item.key === id)!.tokens;
    return {
      id,
      name,
      subtitle,
      windows,
      note,
      sparkline,
      rangeTokens: sparkline.reduce((sum, value) => sum + value, 0),
    };
  };
  const cards: CardView[] = [
    card(
      "claude",
      "Claude",
      "Claude Code",
      claudeWindows(allClaude, allLimits, now, config.timezone),
      "No live percentage is logged. Estimates are calibrated against limits you have actually hit.",
    ),
    card(
      "codex",
      "Codex",
      codexPlan ? `ChatGPT · ${codexPlan}` : "ChatGPT",
      codexWindows(db, now, config.timezone),
      "Uses the exact rate-limit snapshot Codex writes during a session.",
    ),
    card(
      "opencode",
      "OpenCode Go",
      config.go.plan === "go-plus"
        ? "Go Plus"
        : config.go.plan === "go-teams"
          ? "Go Teams"
          : "Go",
      goWindows(db, now, config.timezone, go),
      "All three windows come straight from the OpenCode usage endpoint.",
    ),
  ];

  return {
    generatedAt: now,
    range,
    timezone: config.timezone,
    cards,
    totals,
    providers: providerTotals,
    series,
    models,
    projects,
    hours: hourBins,
    heatmap: weekHeatmap(rows, config.timezone),
    sessions: sessionHistogram(rows),
    limits: limits.map((event) => ({
      id: event.id,
      provider: event.provider,
      timestamp: event.timestamp,
      kind: event.kind,
      window: event.window,
      message: event.message,
      resetsAt: event.resets_at,
    })),
    advice: parseAdvice(getAdvice(db)),
    ingestion: ingestionStatus(),
    go,
    config: {
      port: config.port,
      plan: config.go.plan,
      adviceModel: config.advice.model,
    },
  };
}
