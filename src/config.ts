import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

export type Config = {
  port: number;
  host: string;
  timezone: string;
  range: string;
  scanIntervalSeconds: number;
  go: {
    enabled: boolean;
    plan: "go" | "go-plus" | "go-teams";
    usageUrl: string;
    pollSeconds: number;
  };
  advice: {
    cli: string;
    model: string;
    timeoutSeconds: number;
  };
};

export type Paths = {
  home: string;
  configDir: string;
  configFile: string;
  dataDir: string;
  dbFile: string;
};

export const DEFAULT_CONFIG: Config = {
  port: 4317,
  host: "127.0.0.1",
  timezone: "America/New_York",
  range: "7d",
  scanIntervalSeconds: 45,
  go: {
    enabled: true,
    plan: "go",
    usageUrl: "https://opencode.ai/zen/go/v1/usage",
    pollSeconds: 60,
  },
  advice: {
    cli: "opencode",
    model: "opencode-go/deepseek-v4.1-flash",
    timeoutSeconds: 150,
  },
};

export function paths(): Paths {
  const home = homedir();
  const configDir = join(home, ".config", "usage-dash");
  const dataDir = join(home, "Library", "Application Support", "usage-dash");
  return {
    home,
    configDir,
    configFile: join(configDir, "config.json"),
    dataDir,
    dbFile: join(dataDir, "usage.db"),
  };
}

export async function ensurePaths(): Promise<Paths> {
  const p = paths();
  await mkdir(p.configDir, { recursive: true, mode: 0o700 });
  await mkdir(p.dataDir, { recursive: true, mode: 0o700 });
  return p;
}

export async function loadConfig(): Promise<Config> {
  const p = await ensurePaths();
  let stored: Partial<Config> = {};
  try {
    stored = JSON.parse(await readFile(p.configFile, "utf8"));
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      console.warn(`Could not read ${p.configFile}: ${error.message}`);
    }
    await writeFile(p.configFile, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", {
      mode: 0o600,
    });
  }
  return {
    ...DEFAULT_CONFIG,
    ...stored,
    go: { ...DEFAULT_CONFIG.go, ...(stored.go ?? {}) },
    advice: { ...DEFAULT_CONFIG.advice, ...(stored.advice ?? {}) },
  };
}

export function configSummary(config: Config, p: Paths) {
  return {
    host: config.host,
    port: config.port,
    timezone: config.timezone,
    dataDir: p.dataDir,
    configFile: p.configFile,
  };
}
