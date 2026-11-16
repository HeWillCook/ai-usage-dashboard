import type { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import type { Config } from "./config";
import { upsertLimitSnapshot } from "./db";

type GoWindow = {
  status?: string;
  percent?: number;
  resetsAt?: string;
};

type GoResponse = {
  usage?: {
    rolling?: GoWindow;
    weekly?: GoWindow;
    monthly?: GoWindow;
  };
};

export type GoStatus = {
  ok: boolean;
  checkedAt: number | null;
  error: string | null;
};

let cachedKey: { value: string; at: number } | null = null;
let status: GoStatus = { ok: false, checkedAt: null, error: null };
let timer: ReturnType<typeof setInterval> | null = null;

export function goStatus(): GoStatus {
  return { ...status };
}

function readExport(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("opencode", ["auth", "export"], {
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
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `opencode auth export exited ${code}`));
    });
  });
}

async function openCodeGoKey(): Promise<string | null> {
  if (process.env.OPENCODE_GO_API_KEY) return process.env.OPENCODE_GO_API_KEY;
  if (cachedKey && Date.now() - cachedKey.at < 10 * 60 * 1000) {
    return cachedKey.value;
  }
  const raw = await readExport();
  const items = JSON.parse(raw);
  if (!Array.isArray(items)) return null;
  const item = items.find(
    (entry) =>
      entry?.integrationID === "opencode-go" ||
      /opencode go/i.test(String(entry?.label ?? "")),
  );
  const value = item?.value;
  const key =
    typeof value === "string"
      ? value
      : value && typeof value === "object"
        ? value.key ?? value.apiKey ?? value.token
        : null;
  if (typeof key !== "string" || !key) return null;
  cachedKey = { value: key, at: Date.now() };
  return key;
}

export async function refreshGoUsage(
  db: Database,
  config: Config,
): Promise<GoStatus> {
  if (!config.go.enabled) {
    status = { ok: false, checkedAt: Date.now(), error: "Disabled in config" };
    return goStatus();
  }
  try {
    const key = await openCodeGoKey();
    if (!key) throw new Error("No OpenCode Go credential found");
    const response = await fetch(config.go.usageUrl, {
      headers: {
        Authorization: `Bearer ${key}`,
        "User-Agent": "usage-dash/0.1",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      throw new Error(`OpenCode Go usage returned HTTP ${response.status}`);
    }
    const body = (await response.json()) as GoResponse;
    const now = Date.now();
    let found = 0;
    for (const window of ["rolling", "weekly", "monthly"] as const) {
      const value = body.usage?.[window];
      if (!value || !Number.isFinite(Number(value.percent))) continue;
      found++;
      const resetAt = value.resetsAt ? Date.parse(value.resetsAt) : NaN;
      upsertLimitSnapshot(db, {
        provider: "opencode",
        window,
        usedPercent: Math.max(0, Math.min(100, Number(value.percent))),
        resetsAt: Number.isFinite(resetAt) ? resetAt : null,
        updatedAt: now,
        source: "opencode-api",
        status: "exact",
        resetLabel: null,
      });
    }
    if (!found) throw new Error("OpenCode Go usage response had no windows");
    status = { ok: true, checkedAt: now, error: null };
  } catch (error: any) {
    status = {
      ok: false,
      checkedAt: Date.now(),
      error: String(error?.message ?? error),
    };
  }
  return goStatus();
}

export function startGoPolling(db: Database, config: Config): void {
  if (timer) return;
  void refreshGoUsage(db, config);
  timer = setInterval(
    () => void refreshGoUsage(db, config),
    Math.max(30, config.go.pollSeconds) * 1000,
  );
}

export function stopGoPolling(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
