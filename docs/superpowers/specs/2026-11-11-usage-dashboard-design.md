# AI Usage Dashboard: Design

Date: 2026-11-11 · Status: implemented

## Intent

A personal, always-on local dashboard covering the owner's three AI coding subscriptions: **Claude** (used through Claude Code), **ChatGPT/Codex** (used through Codex), and **OpenCode Go** (used through OpenCode). Its three jobs, in priority order:

1. **Limits.** Show how close each subscription is to its cap and exactly when each one resets. The owner hits these limits often. Claude's 5-hour limit was hit on Nov 1 and three times on Nov 2, and Codex's weekly limit is at 100% as of writing.
2. **Coach.** Recommend the "best second workflow option": when a limit is near or hit, say what to switch to (which model or subscription, for what kind of work) and what to change in how they work.
3. **Explain.** Give a full breakdown of what they actually do: models, tokens, projects, timing, cost-equivalent.

**Why it exists:** the owner pays for three subscriptions and keeps running into caps without warning or a plan B. Success looks like seeing a cap coming, knowing what to switch to, and spreading work so all three subscriptions get used.

## Goals

- One page that answers "where am I on each limit, when does it come back, and what should I use right now?"
- Advice from an AI model that is specific to the owner's own usage, not generic tips.
- A deep breakdown of usage per model, subscription, project and time.
- Always running in the background, with an easy way to start, stop and open it.

## Non-goals

- No proxying or rerouting of any tool's traffic. CLIProxyAPI was tried and deliberately removed because of single-point-of-failure and account/terms-of-service risk.
- No writing to, or modifying, any tool's files or databases. Read-only access to all sources.
- Not multi-user, not hosted, not exposed beyond localhost.
- No analysis of prompt or response *content* for advice. Advice is about model and subscription choice and work patterns, based on usage metadata.

## Anti-goals (failure even if it "works")

- Showing an estimate as if it were exact. Every limit figure must say whether it is **exact**, **estimated**, or **confirmed capped**.
- The dashboard eating the limits it is meant to protect, for example advice silently running on Claude, or refreshing automatically in a loop.
- Its own advice calls polluting the OpenCode usage stats it reports.
- Sending usage data anywhere except the one advice call the owner clicks.

## Data sources (verified on this machine 2026-11-11)

All paths are on macOS under the owner's home directory. Sources must be read incrementally; Claude logs alone are about 600 MB.

### Claude Code: `~/.claude/projects/**/*.jsonl`
- Data runs from 2026-10-31. Of about 13.3k assistant responses: `claude-sonnet-5-5` about 10.4k, `claude-opus-5-5` about 2.8k, `claude-haiku-5-5` 175.
- Lines with `type: "assistant"` have `message.model`, `message.usage` (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`, `output_tokens_details.thinking_tokens`), plus `timestamp`, `cwd`, `gitBranch`, `sessionId`, `requestId`, `isSidechain`, `entrypoint`, `effort`.
- Responses can appear more than once (streaming / multiple content blocks). Deduplicate by `message.id` + `requestId`.
- **Limit hits:** synthetic assistant lines (`message.model: "<synthetic>"`, `isApiErrorMessage: true`, `error: "rate_limit"`, `apiErrorStatus: 429`) whose text is like `You've hit your 5-hour limit · resets 5:10pm (America/New_York)`. Other 429 texts exist, for example "Fable 5.1 requires usage credits…". Parse the limit type and the reset time; treat unknown texts as generic limit events.
- No live limit percentage is logged.

### Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`
- 59 sessions since 2026-11-01. Models: `gpt-6.1-sol` (most), `gpt-6-astra`, `gpt-6-luna`, `gpt-5.6-luna`.
- The `session_meta` payload has `cwd`, `originator`, `model_provider`. The `turn_context` payload has `model`, `effort`.
- The `event_msg` with `payload.type: "token_count"` has `info.last_token_usage` (`input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens`, `total_tokens`) and `info.model_context_window`.
- **Exact limits:** the same events carry `rate_limits`: `primary` / `secondary` each `{used_percent, window_minutes, resets_at (unix s)}`, plus `plan_type` (currently `plus`) and `credits`. The owner currently sees only a `primary` 10080-minute (weekly) window. Many events have nulls; use the latest non-null snapshot.

### OpenCode: `~/.local/share/opencode/opencode.db` (SQLite, WAL)
- Open read-only. Data runs from 2026-11-11 (fresh install). 49 sessions, about 4k assistant messages.
- `session_message` (`type='assistant'`): `data` JSON has `model {id, providerID, variant}`, `tokens {input, output, reasoning, cache {read, write}}`, `cost` (always 0 on Go), `time {created, completed}`, `agent`. `session_v2` has `directory`, `title`, per-session token totals.
- Providers seen: `opencode-go` (subscription; mainly `deepseek-v4.1-flash`) and `opencode` (free models such as `big-pickle` and `*-free`). Only `opencode-go` counts toward the Go limit.
- Local history does not contain Go's server-side limit accounting: `cost` is 0, and the stored assistant records currently omit `opencode.allowance`.
- Model pricing is cached in the `kv` table under key `models-dev:v2:catalog` (models.dev catalog JSON). Use it for analysis and cost-equivalent estimates, not for limit gauges.

### OpenCode Go usage API (authoritative limits)
- `GET https://opencode.ai/zen/go/v1/usage` with `Authorization: Bearer <Go API key>`. It returns current **rolling**, **weekly**, and **monthly** windows: each has `status`, `percent`, and `resetsAt` (ISO timestamp).
- These are server-reported values for the account, so the main Go gauges and reset countdowns are **exact at fetch time**, not estimates. If the call fails, keep the last snapshot and mark it stale instead of falling back to a local guess.
- Go limits are per model, as dollar allowances: 5-hour = 20% of that model's monthly allowance, weekly = 50%, monthly = 100%. Monthly allowance varies by model (for example, DeepSeek V4.1 Flash $100 on Go, Kimi K3.1 Pro $15). The usage endpoint does not return a per-model breakdown, so do not present a locally computed per-model figure as a cap percentage.
- Use local usage for the model mix and token breakdown. If OpenCode later stores `opencode.allowance`, ingest it for a labelled per-model contribution view; do not invent it otherwise.
- The API does not return the plan name. The plan is display-only and can be configured (default: **Go**, the $10 plan); it must never override the server-reported percentages.
- Read the key locally from OpenCode's documented `opencode auth export` output (or an explicit config/env override). Keep it in memory only; never send it to the browser, include it in advice summaries, or write it to logs/store.

## Limits model

Each subscription card shows: a gauge (% used), a reset countdown, a pace line ("at this rate you'll be capped around 3:40pm" or "comfortably within limit"), and a confidence badge.

- **Codex: exact.** Use the latest `rate_limits` snapshot. If that snapshot's `resets_at` has passed, show "reset, waiting for fresh data" rather than a stale 100%. Show every window present (primary/secondary).
- **Claude: estimated, plus confirmed capped.**
  - When the latest limit-hit message's reset time is still in the future, show **confirmed capped** with an exact countdown.
  - Otherwise, estimate usage in the current 5-hour window by measuring recent weighted usage against how much usage preceded each past 5-hour limit hit. That gives a learned "cap size", which sharpens as more hits are logged.
  - Model weighting (for example, Opus counting more than Sonnet) is left to the builder, but must be documented on the page.
  - With no history, show "estimating: not enough limit history yet".
  - Weekly Claude limits: show them only if such limit messages are found in the logs.
- **OpenCode Go: server-reported, exact at fetch time.** Show all three windows: **rolling 5-hour**, **weekly**, and **monthly**: each with its percentage, reset countdown, and a pace line. Refresh about every 60 seconds. Mark the snapshot with its fetch time; after a failed refresh, say "last updated N min ago" and do not extrapolate the gauge. Local dollar estimates may explain which models drive usage, but must be labelled "API-price estimate, not Go's cap accounting" and never replace the server percentages.

## Advice

- Shown in a right-hand sidebar: **one main "best second workflow" recommendation**, then 2–3 secondary ones, and "generated N min ago by `<model>`".
- **On demand only:** a Refresh button. No automatic generation. The last advice is cached on disk and shown on load.
- **How:** the server builds a compact JSON summary and sends it with a fixed instruction prompt to a cheap model through a local CLI. The summary includes:
  - current limit states and resets
  - model mix
  - token makeup and cache-hit rates
  - session length distribution per model
  - limit-hit history with what led up to each hit
  - usage by project and hour
  - Go's three server-reported windows (5-hour, weekly, monthly) and reset times
- **Default model:** OpenCode Go `deepseek-v4.1-flash` via `opencode run` (not Claude, which is the scarcest subscription). The model and CLI are configurable, for example Claude Haiku via `claude -p --model haiku`.
- **Its own calls must be excluded from stats.** Use `opencode run --archived --title "usage-dash advice"`, or an equivalent marker, and filter those sessions out.
- The advice must name concrete switches: model, subscription, and which kind of work moves where. The prompt should push for one clear plan B rather than a menu.
- If the CLI fails or times out, show the error in the sidebar and keep the previous advice.

## Page (layout chosen: "limits cockpit")

- **Top:** three large subscription cards (Claude, Codex, OpenCode Go) as described above.
- **Right sidebar:** advice.
- **Below the cards:** the deep dive.
  - tokens over time by model and by subscription (day / hour granularity, selectable range)
  - model mix (share of work per model)
  - token makeup per model: input, output, cache read/write, reasoning/thinking, plus cache-hit rate
  - usage by project (folder)
  - usage by hour of day / day of week
  - limit-hit timeline
  - session length distribution
  - estimated API-equivalent cost (models.dev pricing) per subscription and per model, labelled as an estimate
- The page auto-refreshes data about every 60s without a full reload.
- Works in light and dark mode, and is readable on a laptop screen.

## Running it

- A local web app in this repo, written in **TypeScript on Bun** (already installed). The server serves the page and a JSON API on `127.0.0.1` only, on a fixed configurable port.
- **Always on:** a macOS LaunchAgent (`~/Library/LaunchAgents/…plist`) starts it at login and restarts it if it crashes.
- **Control command** (e.g. `usage-dash`): `start`, `stop`, `status`, `open` (opens the browser), plus `install` / `uninstall` for the LaunchAgent.
- **Ingestion:** incremental. Remember file offsets / last-seen rows, and store normalized events in a local SQLite file in an app data directory, so restarts are fast and history survives even if a tool prunes its own logs. A file watcher or interval poll (about 30–60s) picks up new data.
- **Config:** a small file for port, advice model/CLI, Go plan label (display only; default Go), timezone (default America/New_York), and per-model weights. Limit gauges come from the tools' logs and the Go usage API, not from config.

## Decided by the owner

- Track Claude, Codex and OpenCode Go by reading local logs; no proxy.
- AI-generated advice from a cheap model, sent a usage summary on demand.
- The "limits cockpit" layout.
- Always running in the background, with easy start/stop.

## My calls (owner may override)

- Bun + TypeScript, localhost-only server, SQLite store.
- OpenCode Go `deepseek-v4.1-flash` as the default advice model.
- Advice is manual-refresh only.
- America/New_York timezone default.

## Left to the builder

- Frontend approach and charting library (keep it light; no heavy build pipeline required).
- Exact estimator math for Claude's window, as long as it is documented on the page and labelled as an estimate.
- Store schema, file layout, port number, CLI name.
- Test strategy (parsers should be tested against real log line shapes, using fixture copies with content stripped).
