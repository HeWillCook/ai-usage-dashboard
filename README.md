<img src="assets/icon.svg" width="64" height="64" alt="">

# AI Usage Dashboard (`usage-dash`)

A local cockpit for Claude Code, Codex and OpenCode Go usage. It reads each
tool's own records, shows the three subscription limits, and can ask a cheap
model for one concrete next move.

No proxy. No rerouting. No usage data leaves the Mac except the one advice call
you click.

## Install

```bash
./bin/usage-dash install
```

That installs a macOS LaunchAgent, starts it at login, restarts it if it exits,
and links the command at `~/.local/bin/usage-dash`.

Open the dashboard:

```bash
usage-dash open
```

or visit <http://127.0.0.1:4317>.

## Commands

```text
usage-dash install    Install the login service and command link, then start
usage-dash start      Start the background service
usage-dash stop       Stop the background service
usage-dash status     Show service and HTTP status
usage-dash open       Open the dashboard, starting the service if needed
usage-dash uninstall  Remove the service and command link; keep usage data
```

## What it reads

- Claude Code: `~/.claude/projects/**/*.jsonl`
- Codex: `~/.codex/sessions/**/*.jsonl`
- OpenCode: `~/.local/share/opencode/opencode.db` (SQLite, read-only)
- OpenCode Go limits: `https://opencode.ai/zen/go/v1/usage`, using the key
  already stored by the local `opencode` CLI

The first scan is the slow one because it indexes existing history. After that,
the app reads only new lines and rows. The scan interval defaults to 45 seconds.

## Accuracy

- **Codex** uses the exact rate-limit percentage and reset time recorded by
  Codex itself.
- **OpenCode Go** uses the server-reported rolling 5-hour, weekly and monthly
  percentages. Go applies a separate dollar allowance per model, but its usage
  endpoint exposes only the combined percentages. Local token estimates are
  not presented as cap percentages.
- **Claude** has no live percentage in its logs. The dashboard learns the
  approximate size of a cap from limit messages you have actually hit, then
  labels the result **estimated**. When a reset time is still in the future, it
  shows **capped** and that exact reset.
- The dollar figure is an API-price estimate, not what your subscriptions
  charge.

## Files

- Config: `~/.config/usage-dash/config.json`
- Database: `~/Library/Application Support/usage-dash/usage.db`
- Service log: `~/Library/Logs/usage-dash.log`
- Service errors: `~/Library/Logs/usage-dash.error.log`
- LaunchAgent: `~/Library/LaunchAgents/com.<user>.usage-dash.plist`

The app binds to `127.0.0.1` only.

## Development

```bash
bun run start
bun test
```

The design note lives at
[docs/superpowers/specs/2026-11-11-usage-dashboard-design.md](docs/superpowers/specs/2026-11-11-usage-dashboard-design.md).
