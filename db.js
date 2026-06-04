// SPDX-FileCopyrightText: 2026 WithVibe
// SPDX-License-Identifier: Apache-2.0

import pg from "pg";

const { Pool } = pg;

// Proposal lifecycle. A prompt enters as `voting`; the team resolves it to
// `approved` or `rejected` (or it `expired` at the deadline). Once the agent
// actually applies an approved change it moves to `applied` (or `failed`).
export const PROPOSAL_STATUSES = [
  "voting",
  "approved",
  "rejected",
  "expired",
  "applied",
  "failed",
];
export const TERMINAL_STATUSES = ["rejected", "expired", "applied", "failed"];
export const VOTE_VALUES = ["approve", "reject"];

const SCHEMA = process.env.PGSCHEMA || "public";

// The platform-provided role's search_path is already locked to PGSCHEMA, but
// we set it explicitly so unqualified table names resolve correctly even if a
// driver default leaks through.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.on("connect", (client) => {
  client.query(`SET search_path TO "${SCHEMA}"`).catch(() => {});
});

// One-shot DDL. Re-runs on every boot are cheap — IF NOT EXISTS makes them
// no-ops once the schema is in place. A singleton `settings` row holds the
// per-aquarium voting rules.
const DDL = `
CREATE TABLE IF NOT EXISTS settings (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  vote_window_seconds INT NOT NULL DEFAULT 600,
  required_approvals INT NOT NULL DEFAULT 1,
  required_rejections INT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS proposal (
  id BIGSERIAL PRIMARY KEY,
  prompt TEXT NOT NULL,
  proposer TEXT,
  status TEXT NOT NULL DEFAULT 'voting',
  voting_ends_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ,
  decision_reason TEXT,
  applied_summary TEXT,
  commit_sha TEXT,
  preview_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vote (
  id BIGSERIAL PRIMARY KEY,
  proposal_id BIGINT NOT NULL REFERENCES proposal(id) ON DELETE CASCADE,
  voter TEXT NOT NULL,
  vote TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (proposal_id, voter)
);

CREATE TABLE IF NOT EXISTS feed_event (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL,
  proposal_id BIGINT,
  actor TEXT NOT NULL DEFAULT 'system',
  detail JSONB,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_proposal_status ON proposal(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vote_proposal ON vote(proposal_id);
CREATE INDEX IF NOT EXISTS idx_feed_at ON feed_event(at DESC);

INSERT INTO settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
`;

export async function initSchema() {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL not set — reef needs shared-postgres storage"
    );
  }
  // In production the platform pre-provisions this schema + a role scoped to
  // it, so this is a harmless no-op (and is swallowed if the scoped role lacks
  // CREATE privilege). In standalone/dev against a superuser it makes the
  // plugin boot without a manual `CREATE SCHEMA` step.
  if (SCHEMA !== "public") {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`).catch(() => {});
  }
  await pool.query(DDL);
}

// ── settings ────────────────────────────────────────────────────────────────

export async function getSettings() {
  const { rows } = await pool.query(
    "SELECT vote_window_seconds, required_approvals, required_rejections FROM settings WHERE id = 1"
  );
  return (
    rows[0] || {
      vote_window_seconds: 600,
      required_approvals: 1,
      required_rejections: 1,
    }
  );
}

export async function updateSettings(patch) {
  const fields = [];
  const vals = [];
  let i = 1;
  for (const k of [
    "vote_window_seconds",
    "required_approvals",
    "required_rejections",
  ]) {
    if (patch[k] !== undefined && Number.isFinite(Number(patch[k]))) {
      fields.push(`${k} = $${i++}`);
      vals.push(Math.max(1, Math.floor(Number(patch[k]))));
    }
  }
  if (fields.length === 0) return getSettings();
  fields.push("updated_at = now()");
  await pool.query(`UPDATE settings SET ${fields.join(", ")} WHERE id = 1`, vals);
  return getSettings();
}

// ── proposals ───────────────────────────────────────────────────────────────

export async function insertProposal({ prompt, proposer }) {
  const settings = await getSettings();
  const { rows } = await pool.query(
    `INSERT INTO proposal (prompt, proposer, status, voting_ends_at)
     VALUES ($1, $2, 'voting', now() + ($3 || ' seconds')::interval)
     RETURNING *`,
    [prompt, proposer || null, String(settings.vote_window_seconds)]
  );
  return rows[0];
}

export async function getProposal(id) {
  const { rows } = await pool.query("SELECT * FROM proposal WHERE id = $1", [id]);
  return rows[0] || null;
}

export async function listProposals(limit = 50) {
  const { rows } = await pool.query(
    "SELECT * FROM proposal ORDER BY created_at DESC, id DESC LIMIT $1",
    [limit]
  );
  return rows;
}

export async function recordApplied(id, { summary, commitSha, previewUrl }) {
  const { rows } = await pool.query(
    `UPDATE proposal
       SET status = 'applied', applied_summary = $2, commit_sha = $3,
           preview_url = $4, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id, summary || null, commitSha || null, previewUrl || null]
  );
  return rows[0] || null;
}

export async function markFailed(id, reason) {
  const { rows } = await pool.query(
    `UPDATE proposal
       SET status = 'failed', decision_reason = $2, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id, reason || null]
  );
  return rows[0] || null;
}

// ── votes ───────────────────────────────────────────────────────────────────

// One vote per (proposal, voter). Re-voting flips an existing vote.
export async function castVote({ proposalId, voter, vote }) {
  await pool.query(
    `INSERT INTO vote (proposal_id, voter, vote)
     VALUES ($1, $2, $3)
     ON CONFLICT (proposal_id, voter)
     DO UPDATE SET vote = EXCLUDED.vote, at = now()`,
    [proposalId, voter, vote]
  );
  // Touch the proposal so getVersion() (UI freshness) advances.
  await pool.query(
    "UPDATE proposal SET updated_at = now() WHERE id = $1",
    [proposalId]
  );
}

export async function listVotes(proposalId) {
  const { rows } = await pool.query(
    "SELECT voter, vote, at FROM vote WHERE proposal_id = $1 ORDER BY at ASC",
    [proposalId]
  );
  return rows;
}

export async function voteCounts(proposalId) {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE vote = 'approve')::int AS approvals,
       COUNT(*) FILTER (WHERE vote = 'reject')::int AS rejections
     FROM vote WHERE proposal_id = $1`,
    [proposalId]
  );
  return rows[0] || { approvals: 0, rejections: 0 };
}

// ── resolution ──────────────────────────────────────────────────────────────

// The single source of truth for "has this proposal been decided yet?". Pure
// in spirit but side-effecting: when the vote tally or the deadline crosses a
// threshold it flips the proposal to a terminal status and logs the event.
// Safe to call repeatedly (idempotent once terminal). Returns the proposal.
export async function evaluateProposal(id) {
  const p = await getProposal(id);
  if (!p) return null;
  if (p.status !== "voting") return p;

  const settings = await getSettings();
  const { approvals, rejections } = await voteCounts(id);

  let decision = null;
  let reason = null;
  if (approvals >= settings.required_approvals) {
    decision = "approved";
    reason = `reached ${approvals}/${settings.required_approvals} approval(s)`;
  } else if (rejections >= settings.required_rejections) {
    decision = "rejected";
    reason = `reached ${rejections}/${settings.required_rejections} rejection(s)`;
  } else if (new Date(p.voting_ends_at).getTime() <= Date.now()) {
    // Deadline passed without hitting a threshold — majority wins, ties expire.
    if (approvals > rejections) {
      decision = "approved";
      reason = `majority at deadline (${approvals}–${rejections})`;
    } else if (rejections > approvals) {
      decision = "rejected";
      reason = `majority at deadline (${approvals}–${rejections})`;
    } else {
      decision = "expired";
      reason = `no majority at deadline (${approvals}–${rejections})`;
    }
  }

  if (!decision) return p;

  const { rows } = await pool.query(
    `UPDATE proposal
       SET status = $2, decision_reason = $3, resolved_at = now(), updated_at = now()
     WHERE id = $1 AND status = 'voting'
     RETURNING *`,
    [id, decision, reason]
  );
  const updated = rows[0];
  // If another concurrent caller resolved it first, just return current state.
  if (!updated) return getProposal(id);

  await logEvent({
    kind: `proposal_${decision}`,
    proposalId: id,
    actor: "team",
    detail: { approvals, rejections, reason },
  });
  return updated;
}

// ── feed / events ───────────────────────────────────────────────────────────

export async function logEvent({
  kind,
  proposalId = null,
  actor = "system",
  detail = null,
}) {
  await pool.query(
    "INSERT INTO feed_event (kind, proposal_id, actor, detail) VALUES ($1, $2, $3, $4)",
    [kind, proposalId, actor, detail ? JSON.stringify(detail) : null]
  );
}

export async function listEvents(limit = 50) {
  const { rows } = await pool.query(
    "SELECT id, kind, proposal_id, actor, detail, at FROM feed_event ORDER BY at DESC, id DESC LIMIT $1",
    [limit]
  );
  return rows;
}

// Single-number freshness stamp used by the UI to decide whether to refetch.
// The greatest updated_at across every mutable row, in ms since epoch.
export async function getVersion() {
  const { rows } = await pool.query(`
    SELECT GREATEST(
      COALESCE((SELECT MAX(updated_at) FROM proposal), 'epoch'::timestamptz),
      COALESCE((SELECT MAX(at) FROM vote), 'epoch'::timestamptz),
      COALESCE((SELECT MAX(at) FROM feed_event), 'epoch'::timestamptz),
      COALESCE((SELECT MAX(updated_at) FROM settings), 'epoch'::timestamptz)
    ) AS v
  `);
  const v = rows[0]?.v;
  return v ? new Date(v).getTime() : 0;
}

// Shape shared by the UI and the agent's reef_status tool.
export async function getBoard({ limit = 30 } = {}) {
  const [settings, proposals, events] = await Promise.all([
    getSettings(),
    listProposals(limit),
    listEvents(40),
  ]);
  const withVotes = await Promise.all(
    proposals.map(async (p) => ({
      ...p,
      counts: await voteCounts(p.id),
      votes: p.status === "voting" ? await listVotes(p.id) : [],
    }))
  );
  return { settings, proposals: withVotes, events };
}
