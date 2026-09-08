import { randomUUID } from "node:crypto";
import type { Room } from "./db.js";
import { allowed, type Principal } from "./auth.js";

export const esc = (value: unknown) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const link = (url: string, label: string) => `<a href="${esc(url)}">${esc(label)}</a>`;
export function layout(body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OneRoom</title>
<style>body{font:16px/1.5 system-ui;max-width:64rem;margin:2rem auto;padding:0 1rem;background:#f8fafc;color:#1e293b}nav{display:flex;gap:1rem;flex-wrap:wrap}article,form{padding:1rem;background:white;border:1px solid #cbd5e1;margin:1rem 0;border-radius:6px}pre{white-space:pre-wrap;overflow-wrap:anywhere}label{display:block;margin:.5rem 0}input,select,button{font:inherit}a{color:#075985}small{color:#475569}</style></head><body><h1>OneRoom</h1>${body}</body></html>`;
}
export function renderLogin(csrf: string) {
  return layout(`<h2>Sign in</h2><form method="post" action="/login"><input type="hidden" name="csrf" value="${esc(csrf)}"><label>Access token <input name="token" type="password" autocomplete="current-password" required maxlength="4096"></label><button>Sign in</button></form>`);
}
export function renderHome(room: Room, principal: Principal, csrf: string, query: Record<string, string>): string {
  const view = query.view ?? "messages";
  const numeric = (name: string) => {
    if (query[name] === undefined) return undefined;
    const n = Number(query[name]);
    if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${name} must be a nonnegative integer`);
    return n;
  };
  const after = numeric("after_id");
  const before = numeric("before_id");
  const archive = query.include_archived === "true";
  let page;
  if (view === "pins") page = room.reads.pins({ after_id: after, limit: 20 });
  else if (view === "documents") page = room.reads.documents({ after_name: query.after_name, limit: 20 });
  else if (view === "annotations") page = room.reads.annotations({ message_id: numeric("message_id"), document_name: query.document_name,
    document_version: numeric("document_version"), after_id: after, limit: 20 });
  else if (view === "messages") page = room.reads.messages({ before_id: before, include_archived: archive, limit: 20 });
  else throw new Error("Unknown view");
  const cards = page.items.map(item => {
    if (view === "documents") return `<article>${link(`/doc/${encodeURIComponent(item.name)}?version=${item.version}`, `${item.name} · v${item.version}`)}
      <p>${link(`/?view=annotations&document_name=${encodeURIComponent(item.name)}&document_version=${item.version}`, "Annotations")}</p></article>`;
    if (view === "annotations") return `<article><b>${esc(item.flag)}</b> · ${esc(item.agent)} · #${item.id}
      <pre>${esc(item.note)}</pre>${item.note_truncated ? "<p>Note preview</p>" : ""}${link(`/annotation/${item.id}`, "Full note")}</article>`;
    if (view === "pins") return `<article><b>Read first</b> · annotation #${item.id}
      <pre>${esc(item.note)}</pre>${link(`/annotation/${item.id}`, "Full pin note")}
      <p>${item.message_id !== null ? link(`/message/${item.message_id}`, `Message #${item.message_id}`)
        : link(`/doc/${encodeURIComponent(item.document_name)}${item.document_version ? `?version=${item.document_version}` : ""}`, `${item.document_name} · ${item.document_version ?? "legacy name-wide pin"}`)}</p>
      ${item.target.content ? `<pre>${esc(item.target.content)}</pre>` : ""}</article>`;
    return `<article><small>#${item.id} · ${esc(item.agent)} · ${esc(item.ts)}</small><pre>${esc(item.content)}</pre>
      ${item.content_truncated ? "<p>Content preview</p>" : ""}${link(`/message/${item.id}`, "Full message")} ·
      ${link(`/?view=annotations&message_id=${item.id}`, `Annotations${item.annotations.has_more ? " (more available)" : ""}`)}</article>`;
  }).join("");
  const nextQuery = new URLSearchParams(query);
  const cursorKey = view === "documents" ? "after_name" : view === "messages" ? "before_id" : "after_id";
  if (page.next_cursor !== null) nextQuery.set(cursorKey, String(page.next_cursor));
  const annotate = csrf && allowed(principal, "annotate") ? `<h2>Add an annotation</h2><form method="post" action="/annotate">
    <input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="request_id" value="${randomUUID()}">
    <label>Message ID <input name="message_id" type="number" min="1"></label>
    <label>Or document name <input name="document_name" maxlength="200"></label>
    <label>Document version (blank = latest; 0 only resolves legacy pins) <input name="document_version" type="number" min="0"></label>
    <label for="flag">Flag</label><select id="flag" name="flag"><option>read-first</option><option>resolved</option><option>stale</option><option>outdated</option><option>failed</option><option>note</option></select>
    <label>Note <input name="note" maxlength="10000"></label><button>Annotate as ${esc(principal.id)}</button></form>` : "";
  return layout(`<nav>${link("/", "Chat")}${link("/?view=pins", "Read first pins")}${link("/?view=documents", "Documents")}${link("/?view=annotations", "Annotation history")}${allowed(principal, "export") ? link("/export", "Export JSON") : ""}</nav>
    <p>Signed in as ${esc(principal.id)} (${esc(principal.role)})</p><h2>${esc(view)}</h2>
    ${view === "messages" ? link(`/?include_archived=${!archive}`, archive ? "Hide archived" : "Include archived") : ""}
    ${cards || "<p>No items.</p>"}${page.has_more ? link(`/?${nextQuery}`, "Next page — more items remain") : "<p>End of results.</p>"}
    ${annotate}${csrf ? `<form method="post" action="/logout"><input type="hidden" name="csrf" value="${esc(csrf)}"><button>Sign out</button></form>` : ""}`);
}
export function renderContent(content: string, nextUrl: string | null) {
  return layout(`${link("/", "Back to room")}<pre>${esc(content)}</pre>${nextUrl ? link(nextUrl, "Continue reading") : "<p>End of content.</p>"}`);
}
