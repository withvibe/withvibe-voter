// SPDX-FileCopyrightText: 2026 WithVibe
// SPDX-License-Identifier: Apache-2.0

export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STATUS_PILL = {
  voting: { label: "voting", cls: "pill pill-primary" },
  approved: { label: "approved", cls: "pill pill-success" },
  applied: { label: "applied", cls: "pill pill-success" },
  rejected: { label: "rejected", cls: "pill pill-danger" },
  expired: { label: "expired", cls: "pill pill-muted" },
  failed: { label: "failed", cls: "pill pill-warning" },
};

function shortVoter(v) {
  const s = String(v ?? "");
  if (s.startsWith("guest-")) return s;
  return s.length > 8 ? s.slice(0, 8) : s;
}

function remaining(endsAt) {
  const ms = new Date(endsAt).getTime() - Date.now();
  if (ms <= 0) return "closing…";
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return m > 0 ? `${m}m ${s}s left` : `${s}s left`;
}

function renderTally(counts) {
  const total = counts.approvals + counts.rejections;
  const apct = total === 0 ? 0 : Math.round((counts.approvals / total) * 100);
  return `<div class="tally">
    <div class="tally-bar">
      <div class="tally-approve" style="width:${apct}%"></div>
    </div>
    <div class="tally-nums">
      <span class="t-approve">👍 ${counts.approvals}</span>
      <span class="t-reject">👎 ${counts.rejections}</span>
    </div>
  </div>`;
}

function renderVotingCard(p, voter) {
  const mine = p.votes.find((v) => v.voter === voter)?.vote || null;
  const voters = p.votes.length
    ? `<div class="voters">${p.votes
        .map(
          (v) =>
            `<span class="voter voter-${v.vote}" title="${escapeHtml(v.voter)}">${
              v.vote === "approve" ? "👍" : "👎"
            } ${escapeHtml(shortVoter(v.voter))}</span>`
        )
        .join("")}</div>`
    : `<div class="voters voters-empty">No votes yet — be the first.</div>`;

  const btn = (vote, label, emoji) =>
    `<button class="btn vote-btn vote-${vote} ${mine === vote ? "voted" : ""}"
        hx-post="ui/proposal/${p.id}/vote" name="vote" value="${vote}"
        hx-target="#app" hx-swap="innerHTML">${emoji} ${label}${
          mine === vote ? " ✓" : ""
        }</button>`;

  return `<article class="card card-voting">
    <header class="card-head">
      <span class="${STATUS_PILL.voting.cls}">voting</span>
      <span class="card-id">#${p.id}</span>
      <span class="card-clock">${remaining(p.voting_ends_at)}</span>
    </header>
    <p class="card-prompt">${escapeHtml(p.prompt)}</p>
    ${renderTally(p.counts)}
    <div class="vote-actions">
      ${btn("approve", "Approve", "👍")}
      ${btn("reject", "Reject", "👎")}
    </div>
    ${voters}
  </article>`;
}

function renderResolvedRow(p) {
  const pill = STATUS_PILL[p.status] || STATUS_PILL.expired;
  const summary = p.applied_summary
    ? `<div class="row-summary">→ ${escapeHtml(p.applied_summary)}</div>`
    : p.decision_reason
      ? `<div class="row-reason">${escapeHtml(p.decision_reason)}</div>`
      : "";
  const preview = p.preview_url
    ? `<a class="row-link" href="${escapeHtml(p.preview_url)}" target="_blank" rel="noopener">preview ↗</a>`
    : "";
  return `<li class="row row-${p.status}">
    <div class="row-head">
      <span class="${pill.cls}">${pill.label}</span>
      <span class="row-id">#${p.id}</span>
      <span class="row-prompt">${escapeHtml(p.prompt)}</span>
      <span class="row-counts">👍 ${p.counts.approvals} / 👎 ${p.counts.rejections}</span>
      ${preview}
    </div>
    ${summary}
  </li>`;
}

export async function renderApp(board, voter) {
  const s = board.settings;
  const voting = board.proposals.filter((p) => p.status === "voting");
  const resolved = board.proposals.filter((p) => p.status !== "voting");

  const votingHtml = voting.length
    ? voting.map((p) => renderVotingCard(p, voter)).join("")
    : `<div class="empty-state">
        <h3>🗳️ Nothing to vote on</h3>
        <p>Ask the AI in chat to make a change. Its proposal will appear here for the team to approve before anything is applied.</p>
      </div>`;

  const resolvedHtml = resolved.length
    ? `<ul class="row-list">${resolved.map(renderResolvedRow).join("")}</ul>`
    : `<li class="row-empty">Nothing resolved yet.</li>`;

  return `<div class="layout">
    <header class="topbar">
      <div class="topbar-left">
        <h1 class="title">🗳️ Voter</h1>
        <p class="subtitle">Prompts are applied only after the team approves them.</p>
      </div>
      <form class="settings" hx-post="ui/settings" hx-target="#app" hx-swap="innerHTML" hx-trigger="change">
        <label>window
          <input type="number" name="vote_window_seconds" min="10" value="${s.vote_window_seconds}" title="Voting window (seconds)">s
        </label>
        <label>need
          <input type="number" name="required_approvals" min="1" value="${s.required_approvals}" title="Approvals to pass">👍
        </label>
        <label>
          <input type="number" name="required_rejections" min="1" value="${s.required_rejections}" title="Rejections to kill">👎
        </label>
      </form>
    </header>

    <section class="voting-area">
      ${votingHtml}
    </section>

    <section class="history">
      <h3>History</h3>
      ${resolvedHtml}
    </section>

    <footer class="you">you are voting as <code>${escapeHtml(shortVoter(voter))}</code></footer>
  </div>`;
}

// Full HTML shell. Polls /ui/version every 4s; only swaps #app when the version
// moved. Scroll is preserved across the (rare) full swap.
export function renderShell(inner) {
  return /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Voter</title>
<script src="https://unpkg.com/htmx.org@2.0.3"></script>
<style>${CSS}</style>
</head>
<body>
<main id="app" hx-get="ui/app" hx-trigger="data-change from:body" hx-swap="innerHTML focus-scroll:false show:none">
${inner}
</main>
<script>
(() => {
  let lastVersion = null;
  let savedScroll = 0;
  async function check() {
    try {
      const r = await fetch('ui/version', { cache: 'no-store' });
      if (!r.ok) return;
      const { version } = await r.json();
      if (lastVersion !== null && version !== lastVersion) {
        document.body.dispatchEvent(new CustomEvent('data-change'));
      }
      lastVersion = version;
    } catch (_) { /* network blip — retry next tick */ }
  }
  document.body.addEventListener('htmx:beforeSwap', () => {
    savedScroll = window.scrollY || document.documentElement.scrollTop || 0;
  });
  document.body.addEventListener('htmx:afterSwap', () => {
    window.scrollTo(0, savedScroll);
  });
  // Re-render once a second so the countdown ticks even with no server change.
  setInterval(() => document.body.dispatchEvent(new CustomEvent('data-change')), 1000);
  setInterval(check, 4000);
  void check();
})();
</script>
</body>
</html>`;
}

// Dark palette — aligned with the WithVibe web theme.
const CSS = `
:root {
  --bg: hsl(205 40% 9%);
  --card: hsl(205 33% 13%);
  --card-2: hsl(205 30% 17%);
  --border: hsl(205 28% 22%);
  --fg: hsl(190 25% 90%);
  --muted: hsl(195 15% 60%);
  --primary: hsl(190 85% 50%);
  --primary-soft: hsl(190 85% 50% / 0.12);
  --success: hsl(160 70% 45%);
  --success-soft: hsl(160 70% 45% / 0.14);
  --danger: hsl(352 80% 60%);
  --danger-soft: hsl(352 80% 60% / 0.14);
  --warning: hsl(40 95% 60%);
  --warning-soft: hsl(40 95% 60% / 0.14);
  --radius: 10px;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
* { box-sizing: border-box; }
html, body { background: var(--bg); color: var(--fg); margin: 0; }
body { font: 13px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
h1, h2, h3 { font-family: var(--mono); letter-spacing: -0.02em; font-weight: 600; }

.layout { display: flex; flex-direction: column; min-height: 100vh; padding: 16px; gap: 14px; }

.topbar { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; padding-bottom: 10px; border-bottom: 1px solid var(--border); }
.title { font-size: 18px; margin: 0; }
.subtitle { margin: 4px 0 0; color: var(--muted); font-size: 12px; }
.settings { display: flex; gap: 10px; align-items: center; color: var(--muted); font-size: 11px; font-family: var(--mono); }
.settings label { display: inline-flex; align-items: center; gap: 4px; }
.settings input { width: 56px; background: var(--card-2); border: 1px solid var(--border); color: var(--fg); border-radius: 5px; padding: 3px 6px; font: inherit; }
.settings input:focus { outline: 0; border-color: var(--primary); }

.voting-area { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; }

.card { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px; }
.card-voting { border-color: hsl(190 85% 50% / 0.4); box-shadow: 0 0 0 1px hsl(190 85% 50% / 0.08); }
.card-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.card-id { font-family: var(--mono); font-size: 11px; color: var(--muted); }
.card-clock { margin-left: auto; font-family: var(--mono); font-size: 11px; color: var(--primary); }
.card-prompt { margin: 0 0 12px; font-size: 14px; line-height: 1.45; }

.tally { margin-bottom: 12px; }
.tally-bar { height: 7px; background: var(--danger-soft); border-radius: 4px; overflow: hidden; }
.tally-approve { height: 100%; background: var(--success); transition: width 250ms ease; }
.tally-nums { display: flex; justify-content: space-between; margin-top: 4px; font-family: var(--mono); font-size: 11px; }
.t-approve { color: var(--success); }
.t-reject { color: var(--danger); }

.vote-actions { display: flex; gap: 8px; margin-bottom: 10px; }
.vote-btn { flex: 1; }
.vote-approve { background: var(--success-soft); color: var(--success); border: 1px solid hsl(160 70% 45% / 0.4); }
.vote-approve:hover { background: hsl(160 70% 45% / 0.22); }
.vote-approve.voted { background: var(--success); color: #04201a; }
.vote-reject { background: var(--danger-soft); color: var(--danger); border: 1px solid hsl(352 80% 60% / 0.4); }
.vote-reject:hover { background: hsl(352 80% 60% / 0.22); }
.vote-reject.voted { background: var(--danger); color: #2a0710; }

.voters { display: flex; flex-wrap: wrap; gap: 6px; }
.voters-empty { color: var(--muted); font-style: italic; }
.voter { font-family: var(--mono); font-size: 10px; padding: 2px 6px; border-radius: 999px; background: var(--card-2); color: var(--muted); }
.voter-approve { color: var(--success); }
.voter-reject { color: var(--danger); }

.pill { display: inline-block; font-family: var(--mono); font-size: 10px; padding: 2px 7px; border-radius: 999px; text-transform: lowercase; white-space: nowrap; }
.pill-primary { background: var(--primary-soft); color: var(--primary); }
.pill-success { background: var(--success-soft); color: var(--success); }
.pill-danger { background: var(--danger-soft); color: var(--danger); }
.pill-warning { background: var(--warning-soft); color: var(--warning); }
.pill-muted { background: var(--card-2); color: var(--muted); }

.btn { background: var(--primary); color: #042027; border: 0; border-radius: 6px; padding: 7px 12px; font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; transition: background 120ms, transform 80ms; }
.btn:hover { transform: translateY(-1px); }
.btn:active { transform: translateY(0); }

.history { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px; }
.history h3 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin: 0 0 10px; }
.row-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; }
.row { padding: 8px 10px; border-radius: 7px; background: var(--card-2); }
.row-head { display: flex; align-items: center; gap: 8px; }
.row-id { font-family: var(--mono); font-size: 10px; color: var(--muted); }
.row-prompt { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row-counts { font-family: var(--mono); font-size: 10px; color: var(--muted); }
.row-link { font-family: var(--mono); font-size: 10px; color: var(--primary); text-decoration: none; }
.row-summary { color: var(--success); font-size: 12px; font-family: var(--mono); padding-left: 4px; margin-top: 4px; }
.row-reason { color: var(--muted); font-size: 11px; padding-left: 4px; margin-top: 3px; }
.row-empty, .row.row-empty { color: var(--muted); font-style: italic; list-style: none; }

.empty-state { grid-column: 1 / -1; text-align: center; padding: 36px 16px; background: var(--card); border: 1px dashed var(--border); border-radius: var(--radius); }
.empty-state h3 { font-size: 15px; margin: 0 0 6px; }
.empty-state p { color: var(--muted); margin: 0 auto; max-width: 460px; }

.you { color: var(--muted); font-size: 11px; text-align: right; }
.you code { font-family: var(--mono); background: var(--card-2); padding: 1px 5px; border-radius: 4px; color: var(--primary); }
`;
