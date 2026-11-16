import type { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import type { Config } from "./config";
import { buildDashboard } from "./dashboard";
import { getAdvice, saveAdvice } from "./db";
import { formatDateTime, relativeDuration } from "./time";

let running = false;

export function adviceRunning(): boolean {
  return running;
}

function summary(db: Database, config: Config): string {
  const data = buildDashboard(db, config, "30d");
  const now = data.generatedAt;
  const compact = {
    now: new Date(now).toISOString(),
    timezone: data.timezone,
    limits: data.cards.map((card) => ({
      subscription: card.name,
      windows: card.windows.map((window) => ({
        window: window.label,
        percent: window.percent,
        confidence: window.confidence,
        resetAt: window.resetAt
          ? new Date(window.resetAt).toISOString()
          : null,
        resetIn: window.resetAt
          ? relativeDuration(window.resetAt - now)
          : null,
      })),
    })),
    last30Days: {
      tokensIncludingCache: data.totals.tokens,
      input: data.totals.input,
      output: data.totals.output,
      cacheRead: data.totals.cacheRead,
      cacheWrite: data.totals.cacheWrite,
      reasoning: data.totals.reasoning,
      estimatedApiCostUsd: Math.round(data.totals.cost * 100) / 100,
    },
    models: data.models.map((model) => ({
      model: model.model,
      subscription: model.provider,
      tokens: model.tokens,
      share:
        data.totals.tokens > 0
          ? Math.round((model.tokens / data.totals.tokens) * 1000) / 10
          : 0,
      cacheHitRate:
        model.input + model.cacheRead > 0
          ? Math.round(
              (model.cacheRead / (model.input + model.cacheRead)) * 1000,
            ) / 10
          : null,
    })),
    projects: data.projects.map((project) => ({
      path: project.project,
      tokens: project.tokens,
    })),
    sessionLengths: data.sessions,
    recentLimitHits: data.limits.slice(0, 12).map((limit) => ({
      subscription: limit.provider,
      kind: limit.kind,
      at: new Date(limit.timestamp).toISOString(),
      resetsAt: limit.resetsAt
        ? new Date(limit.resetsAt).toISOString()
        : null,
    })),
  };
  return JSON.stringify(compact);
}

function cleanOutput(raw: string): string {
  return raw
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function parseModelJson(raw: string): {
  headline: string;
  recommendations: string[];
} {
  const text = cleanOutput(raw);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("The advice model did not return JSON.");
  }
  const parsed = JSON.parse(text.slice(start, end + 1));
  if (!parsed?.headline || !Array.isArray(parsed?.recommendations)) {
    throw new Error("The advice JSON was missing headline or recommendations.");
  }
  return {
    headline: String(parsed.headline).slice(0, 600),
    recommendations: parsed.recommendations
      .slice(0, 3)
      .map((item: unknown) => String(item).slice(0, 600)),
  };
}

function runCli(
  config: Config,
  prompt: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const args = [
      "run",
      "--archived",
      "--title",
      "usage-dash advice",
      "--model",
      config.advice.model,
      prompt,
    ];
    const child = spawn(config.advice.cli, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Advice timed out after ${config.advice.timeoutSeconds}s`));
    }, config.advice.timeoutSeconds * 1000);
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve({ stdout, stderr });
      else {
        reject(
          new Error(
            stderr.trim().slice(0, 700) ||
              `Advice command exited with code ${code}`,
          ),
        );
      }
    });
  });
}

export async function refreshAdvice(db: Database, config: Config) {
  if (running) throw new Error("Advice is already being generated.");
  running = true;
  const previous = getAdvice(db);
  try {
    const prompt = `You are the advisor inside a personal AI-subscription dashboard. Use only the JSON usage summary below. Do not use tools, browse, read files, or ask questions. Give practical advice about model and subscription choice, not prompt content.

The person pays for Claude Code, Codex and OpenCode Go. Protect their limits and make all three subscriptions useful. Name concrete model or subscription switches and the kind of work to move. Be specific to the data. If a gauge is estimated, do not describe it as exact.

Return only one JSON object:
{"headline":"one clear best-next-move sentence","recommendations":["specific recommendation","specific recommendation","specific recommendation"]}

Rules:
- 1 headline and 2 recommendations.
- Prefer one clear plan B over a menu.
- Mention reset times when a limit is capped or near.
- Do not invent numbers not present below.
- Keep each line under 220 characters.

Usage summary:
${summary(db, config)}`;
    const { stdout } = await runCli(config, prompt);
    const parsed = parseModelJson(stdout);
    saveAdvice(db, {
      generatedAt: Date.now(),
      model: config.advice.model,
      payload: JSON.stringify(parsed),
      error: null,
    });
    return { ok: true, ...parsed };
  } catch (error: any) {
    const message = String(error?.message ?? error);
    saveAdvice(db, {
      generatedAt: previous?.generatedAt ?? Date.now(),
      model: config.advice.model,
      payload:
        previous?.payload ??
        JSON.stringify({
          headline: "Advice is not available yet",
          recommendations: [],
        }),
      error: message,
    });
    return { ok: false, error: message };
  } finally {
    running = false;
  }
}

export function adviceMeta(db: Database) {
  const record = getAdvice(db);
  if (!record) return null;
  return {
    generatedAt: record.generatedAt,
    model: record.model,
    error: record.error,
    generatedLabel: formatDateTime(record.generatedAt, "America/New_York"),
  };
}
