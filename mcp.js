// SPDX-FileCopyrightText: 2026 WithVibe
// SPDX-License-Identifier: Apache-2.0

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  evaluateProposal,
  getBoard,
  getProposal,
  insertProposal,
  logEvent,
  markFailed,
  recordApplied,
  voteCounts,
} from "./db.js";

// The MCP bridge hard-caps every plugin tool call at 60s
// (apps/api/src/plugins/plugin-mcp-bridge.service.ts). So voter_await_decision
// cannot block for the full ~10-minute vote window in one call — it long-polls
// for at most POLL_BUDGET_MS, then asks the agent to call again. Keep this
// comfortably under the 60s cap to leave room for network + the agent's
// own round-trip.
const POLL_BUDGET_MS = 45_000;
const POLL_INTERVAL_MS = 1_500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function actorFromHeaders(req) {
  // The orchestrator AI reaches us through the platform bridge on behalf of a
  // user. We default to "ai"; the UI tags its own mutations as "user"/voter id.
  return req?.headers?.["x-withvibe-actor"] === "user" ? "user" : "ai";
}

function proposerFromHeaders(req) {
  return req?.headers?.["x-withvibe-user-id"] || "ai";
}

// Compact, model-friendly snapshot returned in the tail of tool calls so the
// agent always re-grounds on the real board state.
function renderBoardText(board) {
  const out = [];
  const s = board.settings;
  out.push(
    `# Voter — voting board   (window ${s.vote_window_seconds}s, ` +
      `need ${s.required_approvals} approval / ${s.required_rejections} reject)`
  );
  const voting = board.proposals.filter((p) => p.status === "voting");
  const recent = board.proposals.filter((p) => p.status !== "voting").slice(0, 6);
  out.push("");
  if (voting.length === 0) {
    out.push("(no proposals currently in voting)");
  } else {
    out.push("— In voting —");
    for (const p of voting) {
      out.push(
        `  #${p.id}  "${truncate(p.prompt, 70)}"   ` +
          `👍 ${p.counts.approvals} / 👎 ${p.counts.rejections}`
      );
    }
  }
  if (recent.length) {
    out.push("");
    out.push("— Recently resolved —");
    const TAGS = {
      applied: "✅ applied",
      approved: "✔ approved",
      rejected: "✗ rejected",
      expired: "⌛ expired",
      failed: "⚠ failed",
    };
    for (const p of recent) {
      out.push(`  #${p.id}  ${TAGS[p.status] || p.status}  "${truncate(p.prompt, 60)}"`);
    }
  }
  return out.join("\n");
}

function truncate(s, n) {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

async function tail() {
  return renderBoardText(await getBoard());
}

export function registerTools(server, req) {
  const actor = actorFromHeaders(req);
  const proposer = proposerFromHeaders(req);

  server.registerTool(
    "voter_propose_change",
    {
      description:
        "Submit a requested change to this env for the team to vote on. " +
        "IMPORTANT: this env runs in Voter mode — you must NOT edit any files " +
        "or apply the change yet. Call this first with the user's request, then " +
        "call voter_await_decision and wait for the team's verdict. Only make " +
        "the change if it is APPROVED.",
      inputSchema: {
        prompt: z
          .string()
          .min(1)
          .describe("The change the user asked for, in one clear sentence."),
      },
    },
    async ({ prompt }) => {
      const p = await insertProposal({ prompt, proposer });
      await logEvent({
        kind: "proposal_opened",
        proposalId: p.id,
        actor,
        detail: { prompt },
      });
      return {
        content: [
          {
            type: "text",
            text:
              `Proposal #${p.id} opened for team voting (closes ${new Date(
                p.voting_ends_at
              ).toISOString()}).\n` +
              `Do NOT make any changes yet. Now call voter_await_decision with ` +
              `proposal_id=${p.id} and keep calling it until it returns a final ` +
              `decision.\n\n${await tail()}`,
          },
        ],
      };
    }
  );

  server.registerTool(
    "voter_await_decision",
    {
      description:
        "Wait for the team's verdict on a proposal. Long-polls for up to ~45s and " +
        "returns one of: APPROVED (now make exactly the proposed change, then call " +
        "voter_record_change), REJECTED/EXPIRED (do NOT make any change — tell " +
        "the user the team declined), or STILL_VOTING (call this tool again with " +
        "the same proposal_id). Never edit files until this returns APPROVED.",
      inputSchema: {
        proposal_id: z
          .number()
          .int()
          .positive()
          .describe("The id returned by voter_propose_change."),
      },
    },
    async ({ proposal_id }) => {
      const start = Date.now();
      let p = await getProposal(proposal_id);
      if (!p) {
        return {
          content: [
            { type: "text", text: `No proposal #${proposal_id} exists.` },
          ],
          isError: true,
        };
      }

      // Long-poll until terminal or budget exhausted.
      while (true) {
        p = await evaluateProposal(proposal_id);
        if (!p || p.status !== "voting") break;
        if (Date.now() - start >= POLL_BUDGET_MS) break;
        await sleep(POLL_INTERVAL_MS);
      }

      const counts = await voteCounts(proposal_id);
      const votes = `(👍 ${counts.approvals} / 👎 ${counts.rejections})`;

      if (p.status === "voting") {
        return {
          content: [
            {
              type: "text",
              text:
                `STILL_VOTING on proposal #${proposal_id} ${votes}. ` +
                `The team hasn't decided yet. Call voter_await_decision again ` +
                `with proposal_id=${proposal_id} to keep waiting. Do not make any changes.`,
            },
          ],
        };
      }

      if (p.status === "approved") {
        return {
          content: [
            {
              type: "text",
              text:
                `APPROVED ✅ — proposal #${proposal_id} ${votes}: "${p.prompt}".\n` +
                `Now make exactly this change, then call ` +
                `voter_record_change with proposal_id=${proposal_id} and a 1-line ` +
                `summary (and commit_sha / preview_url if you have them).`,
            },
          ],
        };
      }

      // rejected | expired | (already applied/failed)
      const verb =
        p.status === "rejected"
          ? "REJECTED ✗"
          : p.status === "expired"
            ? "EXPIRED ⌛"
            : p.status.toUpperCase();
      return {
        content: [
          {
            type: "text",
            text:
              `${verb} — proposal #${proposal_id} ${votes}: "${p.prompt}". ` +
              `${p.decision_reason || ""}\n` +
              `Do NOT make this change. Let the user know the team declined it.`,
          },
        ],
      };
    }
  );

  server.registerTool(
    "voter_record_change",
    {
      description:
        "Call this AFTER you have applied an APPROVED change, to record what " +
        "shipped so the team sees it in the board. Only valid for approved proposals.",
      inputSchema: {
        proposal_id: z.number().int().positive(),
        summary: z
          .string()
          .min(1)
          .describe("1-line summary of what you actually changed."),
        commit_sha: z.string().optional(),
        preview_url: z.string().optional(),
      },
    },
    async ({ proposal_id, summary, commit_sha, preview_url }) => {
      const p = await getProposal(proposal_id);
      if (!p) {
        return {
          content: [{ type: "text", text: `No proposal #${proposal_id}.` }],
          isError: true,
        };
      }
      if (p.status !== "approved" && p.status !== "applied") {
        return {
          content: [
            {
              type: "text",
              text:
                `Proposal #${proposal_id} is "${p.status}", not approved — ` +
                `nothing to record. Do not apply changes for it.`,
            },
          ],
          isError: true,
        };
      }
      const updated = await recordApplied(proposal_id, {
        summary,
        commitSha: commit_sha,
        previewUrl: preview_url,
      });
      await logEvent({
        kind: "change_applied",
        proposalId: proposal_id,
        actor,
        detail: { summary, commit_sha, preview_url },
      });
      return {
        content: [
          {
            type: "text",
            text: `Recorded change for proposal #${proposal_id}: ${updated.applied_summary}\n\n${await tail()}`,
          },
        ],
      };
    }
  );

  server.registerTool(
    "voter_status",
    {
      description:
        "Show the current Voter board: proposals in voting, vote " +
        "tallies, and recently resolved changes. Call this to re-orient.",
      inputSchema: {},
    },
    async () => ({ content: [{ type: "text", text: await tail() }] })
  );

  // Surfaced for completeness — lets the agent mark its own apply attempt as
  // failed (e.g. build broke) so the board doesn't show a phantom "approved".
  server.registerTool(
    "voter_report_failure",
    {
      description:
        "Report that you could not apply an approved change (e.g. the build " +
        "failed). Marks the proposal failed so the board stays honest.",
      inputSchema: {
        proposal_id: z.number().int().positive(),
        reason: z.string().min(1),
      },
    },
    async ({ proposal_id, reason }) => {
      const p = await markFailed(proposal_id, reason);
      if (!p) {
        return {
          content: [{ type: "text", text: `No proposal #${proposal_id}.` }],
          isError: true,
        };
      }
      await logEvent({
        kind: "change_failed",
        proposalId: proposal_id,
        actor,
        detail: { reason },
      });
      return {
        content: [
          { type: "text", text: `Marked proposal #${proposal_id} failed: ${reason}` },
        ],
      };
    }
  );
}

export function newMcpServer() {
  return new McpServer(
    { name: "voter", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );
}
