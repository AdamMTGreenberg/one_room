import type { Room, Message, DocumentMeta } from "./db.js";

function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const FLAG_COLORS: Record<string, string> = {
  "read-first": "#b91c1c",
  failed: "#c2410c",
  stale: "#a16207",
  outdated: "#a16207",
  resolved: "#15803d",
  note: "#475569",
};

function flagBadges(m: Message | DocumentMeta): string {
  return m.annotations
    .map(
      (a) =>
        `<span class="flag" style="background:${FLAG_COLORS[a.flag] ?? "#475569"}" ` +
        `title="${esc(a.agent)} @ ${esc(a.ts)}${a.note ? ": " + esc(a.note) : ""}">${esc(a.flag)}</span>`
    )
    .join(" ");
}

function renderMessage(m: Message): string {
  const notes = m.annotations
    .filter((a) => a.note)
    .map((a) => `<div class="anote">↳ <b>${esc(a.flag)}</b> by ${esc(a.agent)}: ${esc(a.note!)}</div>`)
    .join("");
  return `<div class="msg">
    <div class="meta">#${m.id} · <b>${esc(m.agent)}</b> · ${esc(m.ts)}${
      m.reply_to ? ` · reply to #${m.reply_to}` : ""
    } ${flagBadges(m)}</div>
    <pre>${esc(m.content)}</pre>${notes}
  </div>`;
}

export function renderHome(room: Room, key: string): string {
  const readFirst = room.readFirstMessages();
  const messages = room.readMessages({ limit: 200 });
  const docs = room.listDocuments();
  const status = room.status();

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>oneroom</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; max-width: 60rem;
         margin: 2rem auto; padding: 0 1rem; color: #1e293b; background: #f8fafc; }
  h1 { font-size: 1.3rem; } h2 { font-size: 1rem; margin-top: 2rem; border-bottom: 1px solid #cbd5e1; }
  .msg { background: #fff; border: 1px solid #e2e8f0; border-radius: 6px; padding: .5rem .75rem; margin: .5rem 0; }
  .msg pre { white-space: pre-wrap; word-break: break-word; margin: .25rem 0 0; }
  .meta { color: #64748b; font-size: .8rem; }
  .flag { color: #fff; border-radius: 4px; padding: 0 .4rem; font-size: .75rem; }
  .anote { color: #475569; font-size: .8rem; margin-top: .25rem; }
  .readfirst { border-left: 4px solid #b91c1c; }
  table { border-collapse: collapse; width: 100%; background: #fff; }
  td, th { border: 1px solid #e2e8f0; padding: .3rem .5rem; text-align: left; font-size: .85rem; }
  form { margin: 1rem 0; } input, select, button { font: inherit; padding: .2rem .4rem; }
  .status { color: #64748b; font-size: .8rem; margin-top: 2rem; }
</style></head><body>
<h1>oneroom <span style="color:#64748b;font-weight:normal">— the single shared room</span></h1>

${
  readFirst.length
    ? `<h2>⚑ Read first (${readFirst.length})</h2>` +
      readFirst.map((m) => `<div class="readfirst">${renderMessage(m)}</div>`).join("")
    : ""
}

<h2>Chat (latest ${messages.length} of ${status.messages})</h2>
${messages.map(renderMessage).join("") || "<p>No messages yet.</p>"}

<h2>Annotate (humans can flag too — nothing can be deleted)</h2>
<form method="post" action="/annotate?key=${encodeURIComponent(key)}">
  <input name="agent" placeholder="your name" required>
  <input name="message_id" placeholder="message id" type="number">
  <input name="document_name" placeholder="or document name">
  <select name="flag">
    <option>read-first</option><option>stale</option><option>outdated</option>
    <option>failed</option><option>resolved</option><option>note</option>
  </select>
  <input name="note" placeholder="note" size="30">
  <button>flag</button>
</form>

<h2>Documents (${docs.length})</h2>
<table><tr><th>name</th><th>v</th><th>mime</th><th>by</th><th>at</th><th>bytes</th><th>flags</th></tr>
${docs
  .map(
    (d) =>
      `<tr><td><a href="/doc/${encodeURIComponent(d.name)}?key=${encodeURIComponent(key)}">${esc(d.name)}</a></td>` +
      `<td>${d.version}</td><td>${esc(d.mime)}</td><td>${esc(d.agent)}</td><td>${esc(d.ts)}</td>` +
      `<td>${d.bytes}</td><td>${flagBadges(d)}</td></tr>`
  )
  .join("")}
</table>

<div class="status">
  ${status.messages} messages · ${status.documents} document versions · ${status.annotations} annotations ·
  ${(status.db_bytes / 1024 / 1024).toFixed(1)} / ${(status.max_db_bytes / 1024 / 1024).toFixed(0)} MB ·
  retention: ${status.retention_days === 0 ? "unlimited" : status.retention_days + " days"} ·
  <a href="/export?key=${encodeURIComponent(key)}">export JSON</a>
</div>
</body></html>`;
}
