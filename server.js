// SPDX-FileCopyrightText: 2026 WithVibe
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  VOTE_VALUES,
  castVote,
  evaluateProposal,
  getBoard,
  getVersion,
  initSchema,
  logEvent,
  updateSettings,
} from "./db.js";
import { newMcpServer, registerTools } from "./mcp.js";
import { renderApp, renderShell } from "./ui.js";

await initSchema();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ── health ────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ ok: true }));

// ── MCP ───────────────────────────────────────────────────────────────────
// One transport per request — stateless. The platform forwards the runner's
// JSON-RPC body verbatim and sets x-withvibe-* headers we use to attribute the
// actor / proposer (passed into registerTools).
app.all("/mcp", async (req, res) => {
  const server = newMcpServer();
  registerTools(server, req);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: err instanceof Error ? err.message : "Internal error",
        },
        id: null,
      });
    }
  }
});

// ── voter identity ──────────────────────────────────────────────────────────
// Each team member needs a stable id so "one vote per voter" works and the UI
// can show "you voted". Prefer the platform-injected user id (when the UI proxy
// forwards it); otherwise fall back to a per-browser cookie so distinct tabs /
// browsers act as distinct voters even in standalone/dev runs.
const VOTER_COOKIE = "reef_voter";

function parseCookies(req) {
  const raw = req.headers.cookie;
  const out = {};
  if (!raw) return out;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Resolves the voter id and, when it had to mint a cookie one, sets it on the
// response so the next request is stable.
function resolveVoter(req, res) {
  const headerId = req.headers["x-withvibe-user-id"];
  if (typeof headerId === "string" && headerId.trim()) return headerId.trim();
  const cookies = parseCookies(req);
  if (cookies[VOTER_COOKIE]) return cookies[VOTER_COOKIE];
  const id = `guest-${randomUUID().slice(0, 8)}`;
  res.setHeader(
    "Set-Cookie",
    `${VOTER_COOKIE}=${id}; Path=/; Max-Age=31536000; SameSite=None; Secure`
  );
  return id;
}

// ── UI ────────────────────────────────────────────────────────────────────
// The shell polls /ui/version every few seconds and only swaps #app when the
// version actually moved (avoids scroll-jump). All mutations re-render #app.
//
// URL-relative paths in hx-post values matter: the WithVibe proxy mounts this
// plugin behind /api/plugins/view/<id>/env/<envId>/, and absolute paths would
// escape the mount.

app.get("/ui", async (req, res) => {
  const voter = resolveVoter(req, res);
  res.send(renderShell(await renderApp(await getBoard(), voter)));
});

app.get("/ui/app", async (req, res) => {
  const voter = resolveVoter(req, res);
  res.send(await renderApp(await getBoard(), voter));
});

app.get("/ui/version", async (_req, res) => {
  const version = await getVersion();
  res.json({ version });
});

app.post("/ui/proposal/:id/vote", async (req, res) => {
  const voter = resolveVoter(req, res);
  const id = Number(req.params.id);
  const vote = String(req.body?.vote || "").trim();
  if (Number.isFinite(id) && VOTE_VALUES.includes(vote)) {
    await castVote({ proposalId: id, voter, vote });
    await logEvent({
      kind: "vote_cast",
      proposalId: id,
      actor: voter,
      detail: { vote },
    });
    // Resolve immediately if this vote crossed a threshold, so the agent's
    // long-poll returns promptly.
    await evaluateProposal(id);
  }
  res.send(await renderApp(await getBoard(), voter));
});

app.post("/ui/settings", async (req, res) => {
  const voter = resolveVoter(req, res);
  await updateSettings({
    vote_window_seconds: req.body?.vote_window_seconds,
    required_approvals: req.body?.required_approvals,
    required_rejections: req.body?.required_rejections,
  });
  await logEvent({ kind: "settings_changed", actor: voter });
  res.send(await renderApp(await getBoard(), voter));
});

// Bare-root convenience — a stray GET / inside the container lands somewhere
// useful instead of 404ing.
app.get("/", (_req, res) => res.redirect("/ui"));

const PORT = Number(process.env.PORT) || 8080;
app.listen(PORT, () => {
  console.log(`reef plugin listening on :${PORT}`);
  console.log(`  MCP endpoint: POST /mcp`);
  console.log(`  UI:           GET  /ui`);
  console.log(`  schema:       ${process.env.PGSCHEMA || "(none)"}`);
});
