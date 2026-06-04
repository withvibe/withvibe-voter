# Aquascape — a WithVibe plugin

> Turn a [WithVibe](https://withvibe.dev) env into a **team-voted vibecoding game**. When this plugin is enabled, the AI doesn't apply a prompt straight away — it opens a **proposal** the team votes on, and only an **approved** proposal gets built. (Aquascaping is the craft of designing an underwater scene; here the team designs it together, by vote.)

```
You (in chat):  "give the clownfish a neon trail"
        │
        ▼
   aquascape_propose_change ──────►  Proposal #7 opens (10-min vote)
        │                               👍 👎  team votes in the panel
   aquascape_await_decision  ◄───────  APPROVED ✅  /  REJECTED ✗
        │
        ▼  (only if approved)
   agent edits the scene  ──►  aquascape_record_change  ──►  shows up in History
```

It ships as the default game for the WithVibe public demo (an aquarium), but
it's content-agnostic: enable it on **any** env and that env becomes a
vote-gated sandbox. Multiple envs = multiple independent scenes.

## How the gate works (and why it's just a plugin)

WithVibe auto-injects an enabled plugin's MCP tools into the agent's turn.
Aquascape uses that to gate prompts **without any change to WithVibe core**:

1. `aquascape_propose_change(prompt)` — opens a proposal and tells the agent to
   **not** touch anything yet.
2. `aquascape_await_decision(proposal_id)` — long-polls the vote. The platform's
   MCP bridge caps a single tool call at 60s, so this returns after ~45s with
   `STILL_VOTING` and the agent simply calls it again until it's terminal.
3. On `APPROVED`, the agent makes the change and calls `aquascape_record_change`.
   On `REJECTED` / `EXPIRED` it makes no change.

Meanwhile every teammate votes in the plugin's own UI panel — independent of the
agent. The gate is **agent-cooperative** (enforced via tool instructions), which
is the right trade-off for a friendly game; hardening it to be unbypassable is a
later option that would need a small core hook.

## MCP tools

| Tool | Purpose |
|---|---|
| `aquascape_propose_change` | Open a proposal for the requested change. Agent must call this instead of editing. |
| `aquascape_await_decision` | Long-poll the team's verdict (`APPROVED` / `REJECTED` / `EXPIRED` / `STILL_VOTING`). |
| `aquascape_record_change` | Record what shipped after applying an approved change. |
| `aquascape_report_failure` | Mark an approved change as failed (e.g. build broke). |
| `aquascape_status` | Show the current board: proposals in voting + recently resolved. |

## State

Four tables in the plugin's isolated Postgres schema (`shared-postgres` storage):
`settings` (vote window + thresholds), `proposal`, `vote`, `feed_event`.

Resolution rule: a proposal passes when approvals reach the threshold, fails when
rejections reach the threshold, and at the deadline the majority wins (ties
expire). Defaults: 600s window, 1 approval / 1 rejection — tune them in the panel.

## Architecture

```
manifest.yaml ──► WithVibe spawns one container per env (scope: env)
       │
   server.js (express)
   ├── /health      platform health probe
   ├── /mcp         agent's MCP endpoint            ─► mcp.js  (the gate)
   ├── /ui          htmx voting panel               ─► ui.js
   └── /ui/version  cheap freshness check (live updates)
                │
              db.js (pg) ─► shared-postgres, per-env schema
```

## Build

```bash
docker build -t local/aquascape:0.1 .
```

For the marketplace this is published multi-arch as `ghcr.io/withvibe/aquascape:<version>`.

## Install in WithVibe

1. Workspace admin → **Plugins** → **Install plugin** (or **Marketplace** once listed).
2. Paste [manifest.yaml](manifest.yaml) (or 1-click install from the catalog).
3. Open any env → enable **Aquascape** → that env is now a voted scene.

## Local development

```bash
docker build -t local/aquascape:0.1 .
docker run --rm -p 8080:8080 \
  -e DATABASE_URL="postgres://user:pass@host.docker.internal:5432/withvibe_plugins" \
  -e PGSCHEMA="aquascape_dev" \
  local/aquascape:0.1
# open http://localhost:8080/ui  — two browsers = two voters
```

## Repository layout

```
manifest.yaml   WithVibe plugin manifest (install input)
Dockerfile      runtime image
package.json    deps (express, pg, @modelcontextprotocol/sdk, zod)
server.js       express entry — HTTP + MCP routes + vote handling
db.js           pg pool, schema, proposal/vote/resolution helpers
mcp.js          the gate: propose / await / record MCP tools
ui.js           htmx voting panel + dark aquatic theme
```

## License

[Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for attribution.
