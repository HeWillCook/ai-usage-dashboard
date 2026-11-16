import { Database } from "bun:sqlite";
import { join } from "node:path";
import { loadConfig, paths } from "./config";
import { openDb } from "./db";
import { adviceRunning, refreshAdvice } from "./advice";
import { buildDashboard } from "./dashboard";
import { goStatus, startGoPolling, stopGoPolling } from "./go-usage";
import { ingestionStatus, startIngestion, stopIngestion } from "./ingest";

const WEB_ROOT = join(import.meta.dir, "web");
const config = await loadConfig();
const appPaths = paths();
const db: Database = openDb(appPaths.dbFile);

function withSecurity(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  return new Response(response.body, {
    status: response.status,
    headers,
  });
}

function json(body: unknown, status = 200): Response {
  return withSecurity(
    new Response(JSON.stringify(body), {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    }),
  );
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const host = request.headers.get("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

let server;
try {
  server = Bun.serve({
    hostname: config.host,
    port: config.port,
    idleTimeout: 180,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/")) {
        if (request.method === "POST" && !sameOrigin(request)) {
          return json({ error: "Cross-origin request refused" }, 403);
        }
        if (url.pathname === "/api/dashboard" && request.method === "GET") {
          const range = url.searchParams.get("range") ?? config.range;
          try {
            return json(
              buildDashboard(
                db,
                config,
                range,
                url.searchParams.get("resolution") ?? undefined,
              ),
            );
          } catch (error: any) {
            console.error("Dashboard query failed", error);
            return json({ error: String(error?.message ?? error) }, 500);
          }
        }
        if (url.pathname === "/api/advice" && request.method === "POST") {
          if (adviceRunning()) {
            return json({ error: "Advice is already being generated" }, 409);
          }
          const result = await refreshAdvice(db, config);
          return json(result, result.ok ? 200 : 502);
        }
        if (url.pathname === "/api/status" && request.method === "GET") {
          return json({
            now: Date.now(),
            ingestion: ingestionStatus(),
            go: goStatus(),
            adviceRunning: adviceRunning(),
          });
        }
        if (url.pathname === "/api/health" && request.method === "GET") {
          return json({
            ok: true,
            now: Date.now(),
            ingestion: ingestionStatus(),
          });
        }
        return json({ error: "Not found" }, 404);
      }

      const assets: Record<string, { file: string; type: string }> = {
        "/": { file: "index.html", type: "text/html; charset=utf-8" },
        "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
        "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
        "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
        "/favicon.svg": { file: "favicon.svg", type: "image/svg+xml" },
      };
      const asset = assets[url.pathname];
      if (!asset) return withSecurity(new Response("Not found", { status: 404 }));
      return withSecurity(
        new Response(Bun.file(join(WEB_ROOT, asset.file)), {
          headers: {
            "Content-Type": asset.type,
            "Cache-Control": "no-cache",
          },
        }),
      );
    },
  });
} catch (error: any) {
  console.error(
    `Could not listen on ${config.host}:${config.port}: ${error?.message ?? error}`,
  );
  process.exit(1);
}

startIngestion(db, config);
startGoPolling(db, config);

const shutdown = () => {
  stopIngestion();
  stopGoPolling();
  try {
    server!.stop(true);
    db.close();
  } catch {
    // Shutdown is best effort.
  }
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log(
  `usage-dash listening on http://${config.host}:${config.port} (data: ${appPaths.dataDir})`,
);
