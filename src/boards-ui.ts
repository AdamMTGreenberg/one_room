import { randomUUID } from "node:crypto";
import type { Room } from "./db.js";
import { allowed, type Principal } from "./auth.js";
import { esc, layout } from "./ui.js";
import type { RecordKind } from "./collaboration.js";

const link = (href: string, label: string) =>
  `<a href="${esc(href)}">${esc(label)}</a>`;
const hidden = (key: string, value: unknown) =>
  `<input type="hidden" name="${key}" value="${esc(value)}">`;
const field = (
  key: string,
  label: string,
  value: unknown = "",
  large = false,
) =>
  `<label>${esc(label)} ${large ? `<textarea name="${key}" rows="6" maxlength="41000">${esc(value)}</textarea>` : `<input name="${key}" value="${esc(value)}" maxlength="1000">`}</label>`;
const select = (
  key: string,
  label: string,
  values: string[],
  value: string,
) => {
  const id = `${key}-${randomUUID()}`;
  return `<label for="${id}">${label}</label><select id="${id}" name="${key}">${values.map((v) => `<option${v === value ? " selected" : ""}>${v}</option>`).join("")}</select>`;
};
const views = {
  status: "Agents",
  work: "Work & blockers",
  pr: "Pull requests",
  test: "Tests",
  log: "Execution logs",
  events: "Activity",
  inbox: "Your inbox",
  checkins: "Check-ins",
  thread: "Thread",
  pr_note: "PR notes",
};
export function renderBoards(
  room: Room,
  principal: Principal,
  csrf: string,
  query: Record<string, string>,
) {
  const view = query.view ?? "status";
  if (!(view in views)) throw new Error("Unknown view");
  const after = Number(query.after_id ?? 0);
  const c = room.collaboration;
  const page =
    view === "events"
      ? c.events(after)
      : view === "inbox"
        ? c.inbox(principal.id, after, 20, query.include_resolved === "true")
        : view === "thread"
          ? c.thread(Number(query.message_id), after)
          : view === "checkins"
            ? c.checkins(after)
            : c.records(
                view as RecordKind,
                after,
                20,
                query.history_key,
                view === "pr" &&
                  !query.history_key &&
                  query.include_closed !== "true",
              );
  const cards = page.items
    .map((item) => {
      if (view === "inbox")
        return `<article><b>${item.question ? "Question" : esc(item.kind)}</b> from ${esc(item.agent)} · ${esc(item.state)}
      <p>${link(`/boards?view=thread&message_id=${item.target}`, `Open thread for message #${item.target}`)}</p>
      ${csrf && allowed(principal, "post") ? `<form method="post" action="/attention">${hidden("csrf", csrf)}${hidden("request_id", randomUUID())}${hidden("attention_id", item.id)}${select("state", "State", ["acknowledged", "answered", "resolved"], item.state)}<button>Update</button></form>` : ""}</article>`;
      if (view === "events")
        return `<article>#${item.id} · ${esc(item.ts)} · ${esc(item.agent)} · <b>${esc(item.kind)}</b> · ${esc(item.target)}${item.recipient ? ` → @${esc(item.recipient)}` : ""}</article>`;
      if (view === "checkins")
        return `<article><b>${esc(item.agent)}</b> · ${item.overdue ? "MISSED CHECK-IN" : "On schedule"}<p>Last check-in ${esc(new Date(item.last_seen).toISOString())}; next due ${esc(new Date(item.next_due).toISOString())}; runner failures ${item.failures}</p></article>`;
      if (view === "thread")
        return `<article>#${item.id} · ${esc(item.agent)}${item.question ? " · Question" : ""}<pre>${esc(item.preview)}</pre>${link(`/message/${item.id}`, "Full message")}</article>`;
      const key = encodeURIComponent(item.key);
      return `<article><b>${esc(item.summary || item.key)}</b> · ${esc(item.state ?? "")}<p>${esc(item.agent)} · ${esc(item.ts)} · version ${item.version}</p>
      ${item.repo ? `<p>${esc(item.repo)} ${esc(item.branch)}</p>` : ""}${item.commit || item.head_sha ? `<p>Commit <code>${esc(item.commit ?? item.head_sha)}</code></p>` : ""}
      ${view === "pr" ? `<pre>${esc(item.description_preview)}</pre><p>${item.draft ? "Draft · " : ""}Provider CI: ${esc(item.ci)} · Review: ${esc(item.review)} · Room owner: ${esc(item.owner ?? "unassigned")}</p>` : ""}
      ${view === "status" ? `<p>Last check-in: ${item.last_seen ? esc(new Date(item.last_seen).toISOString()) : "not registered"}${item.next_due && item.next_due < Date.now() ? " · MISSED CHECK-IN" : ""}</p>` : ""}
      ${item.synced_at ? `<p>Provider snapshot ${esc(item.synced_at)} — ${Date.now() - Date.parse(item.synced_at) > 600000 ? "STALE" : "recent"}</p>` : ""}
      ${item.lease_expired ? "<p>Ownership lease expired; available for takeover.</p>" : ""}
      ${link(`/record/${view}/${key}?version=${item.version}`, "Details")} · ${link(`/boards?view=${view}&history_key=${key}`, "History")}
      ${view === "pr" ? ` · ${link(`/boards?view=pr_note&edit=${key}`, "Room notes")} · ${link(`/pr-tests/${key}`, "Tests for this commit")}` : ""}
      ${csrf && allowed(principal, "post") && view !== "pr" && view !== "log" && (item.agent === principal.id || (view === "work" && item.lease_expired)) ? ` · ${link(`/boards?view=${view}&edit=${key}`, "Edit")}` : ""}</article>`;
    })
    .join("");
  const next = new URLSearchParams(query);
  if (page.next_cursor !== null) next.set("after_id", String(page.next_cursor));
  let form = "";
  if (
    csrf &&
    allowed(principal, "post") &&
    ["status", "work", "test", "log", "pr_note"].includes(view)
  ) {
    const kind = view as RecordKind;
    const key = view === "status" ? principal.id : (query.edit ?? "");
    const current = key ? c.latest(kind, key) : null;
    const d = current?.data ?? {};
    let fields = "";
    if (view === "status")
      fields =
        field("summary", "Two or three sentence update", d.summary) +
        select(
          "state",
          "Status",
          ["working", "blocked", "idle", "finished"],
          d.state,
        ) +
        field("detail", "Detailed note (up to 40 KiB)", d.detail, true) +
        field("task", "Current task", d.task) +
        field("repo", "Repository", d.repo) +
        field("branch", "Branch", d.branch) +
        field("worktree", "Worktree", d.worktree) +
        field("blockers", "Blockers", d.blockers);
    if (view === "work")
      fields =
        field("title", "Task", d.title) +
        select(
          "state",
          "State",
          ["open", "working", "blocked", "done"],
          d.state,
        ) +
        field("repo", "Repository", d.repo) +
        field("branch", "Branch", d.branch) +
        field(
          "areas",
          "Affected files or areas (one per line)",
          d.areas?.join("\n"),
          true,
        ) +
        field(
          "depends_on",
          "Dependency work keys (one per line)",
          d.depends_on?.join("\n"),
          true,
        ) +
        field("blockers", "Blockers", d.blockers) +
        field(
          "lease_minutes",
          "Claim for minutes (0 to release, max 1440)",
          60,
        );
    if (view === "test")
      fields =
        field("repo", "Repository (owner/name)", d.repo) +
        field("commit", "Exact commit SHA", d.commit) +
        field("suite", "Suite", d.suite) +
        field("command", "Command", d.command) +
        select(
          "state",
          "Result",
          ["running", "passed", "failed", "canceled"],
          d.state,
        ) +
        field(
          "started_at",
          "Started at (ISO timestamp)",
          d.started_at ?? new Date().toISOString(),
        ) +
        field("summary", "Result summary", d.summary) +
        field(
          "artifacts",
          "Artifact URLs (one per line)",
          d.artifacts?.join("\n"),
          true,
        );
    if (view === "log")
      fields =
        select("level", "Level", ["info", "warn", "error"], "info") +
        field("summary", "Summary") +
        field("output", "Output (redact secrets before sending)", "", true) +
        field("repo", "Repository") +
        field("work_key", "Work key") +
        field("artifacts", "Artifact URLs (one per line)", "", true);
    if (view === "pr_note")
      fields =
        field("summary", "PR ownership / summary", d.summary) +
        field("detail", "Room notes", d.detail, true);
    form = `<h2>${current ? "Update" : "Publish"} ${esc(views[view as keyof typeof views])}</h2><form method="post" action="/record">${hidden("csrf", csrf)}${hidden("request_id", randomUUID())}${hidden("kind", view)}${hidden("expected_version", current?.version ?? 0)}${view === "status" ? hidden("key", key) : field("key", view === "pr_note" ? "PR key (owner/repo#number)" : "Unique record key", key)}${fields}<button>Save as ${esc(principal.id)}</button></form>`;
  }
  if (form && Buffer.byteLength(form) > room.reads.budget / 3)
    form =
      "<p>This record is too large for the configured browser page budget. Read its details in chunks and update it through MCP, or raise ONEROOM_MAX_RESPONSE_KB. No content has been truncated or saved.</p>";
  const messageForm =
    csrf && allowed(principal, "post")
      ? `<h2>${view === "thread" ? "Reply" : "Post a message"}</h2><form method="post" action="/message">${hidden("csrf", csrf)}${hidden("request_id", randomUUID())}${view === "thread" ? hidden("reply_to", query.message_id) : ""}${field("content", "Message (use @agent to mention)", "", true)}${field("mentions", "Explicit recipient IDs (comma separated)")}${select("question", "Question", ["no", "yes"], "no")}<button>Post</button></form>`
      : "";
  return layout(`<nav>${link("/", "Chat & documents")}${Object.entries(views)
    .filter(([k]) => !["thread", "pr_note"].includes(k))
    .map(([k, v]) => link(`/boards?view=${k}`, v))
    .join("")}</nav>
    <h2>${esc(views[view as keyof typeof views])}</h2><p>Signed in as ${esc(principal.id)}</p>${view === "test" ? "<p>Agent-reported results apply only to their recorded commit. Provider CI appears on the PR board separately.</p>" : ""}
    ${view === "pr" ? link(`/boards?view=pr&include_closed=${query.include_closed !== "true"}`, query.include_closed === "true" ? "Show open PRs" : "Include closed and merged PRs") : ""}${cards || "<p>No items yet.</p>"}${page.has_more ? link(`/boards?${next}`, "Next page") : "<p>End of results.</p>"}${form}${messageForm}`);
}
