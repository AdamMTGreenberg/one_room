import type Database from "better-sqlite3";
import type { Config } from "./config.js";

export interface Page<T> { items: T[]; next_cursor: number | string | null; has_more: boolean }
type Row = Record<string, any>;
const utf8 = (bytes: Buffer) => new TextDecoder("utf-8").decode(bytes, { stream: true });

export class ReadModel {
  readonly budget: number;
  constructor(private db: Database.Database, private cfg: Config) {
    this.budget = cfg.maxResponseBytes ?? 256 * 1024;
  }

  private page(rows: Iterable<Row>, map: (row: Row) => Row, cursor: (row: Row) => number | string,
    limit = 50, budget = this.budget / 8): Page<Row> {
    const items: Row[] = [];
    let bytes = 128;
    let last: number | string | null = null;
    for (const row of rows) {
      const item = map(row);
      const size = Buffer.byteLength(JSON.stringify(item));
      if (items.length >= Math.min(Math.max(limit, 1), 100) || bytes + size > budget) {
        if (!items.length) throw new Error("Response item exceeds budget; use individual content retrieval");
        return { items, next_cursor: last, has_more: true };
      }
      items.push(item); bytes += size + 1; last = cursor(row);
    }
    return { items, next_cursor: null, has_more: false };
  }

  annotations(opts: { message_id?: number; document_name?: string; document_version?: number; after_id?: number; limit?: number } = {}) {
    const where = ["id > ?"];
    const params: unknown[] = [opts.after_id ?? 0];
    if (opts.message_id !== undefined) { where.push("message_id = ?"); params.push(opts.message_id); }
    if (opts.document_name !== undefined) {
      const version = opts.document_version ?? this.db.prepare("SELECT MAX(version) AS v FROM documents WHERE name = ?").get(opts.document_name) as any;
      where.push("document_name = ? AND (document_version IS NULL OR document_version = ?)");
      params.push(opts.document_name, typeof version === "number" ? version : version?.v ?? null);
    }
    const limit = Math.min(opts.limit ?? 50, 100);
    const rows = this.db.prepare(`SELECT id, ts, substr(agent,1,64) AS agent, flag, message_id, document_name, document_version,
      substr(CAST(note AS BLOB),1,128) AS note, length(CAST(note AS BLOB)) AS note_bytes
      FROM annotations WHERE ${where.join(" AND ")} ORDER BY id LIMIT ?`).all(...params, limit + 1) as Row[];
    return this.page(rows, row => ({ ...row, note: row.note === null ? null : utf8(row.note),
      note_truncated: row.note_bytes > (row.note?.length ?? 0) }), row => row.id, limit);
  }

  private message(row: Row) {
    const content = utf8(row.content);
    return { ...row, content, content_truncated: row.bytes > Buffer.byteLength(content),
      annotations: this.annotations({ message_id: row.id, limit: 2 }) };
  }

  messages(opts: { after_id?: number; before_id?: number; limit?: number; include_archived?: boolean } = {}) {
    const where: string[] = []; const params: unknown[] = [];
    if (opts.after_id !== undefined) { where.push("id > ?"); params.push(opts.after_id); }
    if (opts.before_id !== undefined) { where.push("id < ?"); params.push(opts.before_id); }
    if (this.cfg.retentionDays && !opts.include_archived) {
      where.push("ts >= ?"); params.push(new Date(Date.now() - this.cfg.retentionDays * 86400000).toISOString());
    }
    const limit = Math.min(opts.limit ?? 50, 100);
    const forward = opts.after_id !== undefined;
    const rows = this.db.prepare(`SELECT id, ts, substr(agent,1,64) AS agent, reply_to,
      substr(CAST(content AS BLOB),1,512) AS content, length(CAST(content AS BLOB)) AS bytes FROM messages
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id ${forward ? "ASC" : "DESC"} LIMIT ?`)
      .all(...params, limit + 1) as Row[];
    const result = this.page(rows, row => this.message(row), row => row.id, limit);
    if (!forward) result.items.reverse();
    return { ...result, cursor_direction: forward ? "after_id" : "before_id" };
  }

  private document(row: Row) {
    return { ...row, annotations: this.annotations({ document_name: row.name, document_version: row.version, limit: 2 }) };
  }

  documents(opts: { after_name?: string; limit?: number } = {}) {
    const limit = Math.min(opts.limit ?? 50, 100);
    const rows = this.db.prepare(`SELECT name, version, ts, substr(agent,1,64) AS agent, substr(mime,1,255) AS mime,
      length(CAST(content AS BLOB)) AS bytes FROM documents d WHERE name > ?
      AND version = (SELECT MAX(version) FROM documents WHERE name = d.name) ORDER BY name LIMIT ?`)
      .all(opts.after_name ?? "", limit + 1) as Row[];
    return this.page(rows, row => this.document(row), row => row.name, limit);
  }

  pins(opts: { after_id?: number; limit?: number } = {}) {
    const limit = Math.min(opts.limit ?? 50, 100);
    // The newest pin/resolution for each target determines state. Legacy name-wide
    // flags remain visible and are explicitly labelled by a null document_version.
    const rows = this.db.prepare(`SELECT a.id, a.message_id, a.document_name, a.document_version,
      substr(CAST(a.note AS BLOB),1,128) AS note, length(CAST(a.note AS BLOB)) AS note_bytes
      FROM annotations a WHERE a.flag = 'read-first' AND a.id > ?
      AND NOT EXISTS (SELECT 1 FROM annotations r WHERE r.id > a.id
        AND r.message_id IS a.message_id AND r.document_name IS a.document_name
        AND r.document_version IS a.document_version
        AND r.flag IN ('read-first','resolved'))
      ORDER BY a.id LIMIT ?`).all(opts.after_id ?? 0, limit + 1) as Row[];
    return this.page(rows, row => ({ ...row, note: row.note === null ? null : utf8(row.note),
      note_truncated: row.note_bytes > (row.note?.length ?? 0),
      target: row.message_id !== null ? this.message(this.db.prepare(`SELECT id, ts, substr(agent,1,64) AS agent, reply_to,
        substr(CAST(content AS BLOB),1,512) AS content, length(CAST(content AS BLOB)) AS bytes FROM messages WHERE id=?`).get(row.message_id) as Row)
        : { name: row.document_name, version: row.document_version, legacy_name_wide: row.document_version === null },
    }), row => row.id, limit);
  }

  content(kind: "messages" | "documents" | "annotations", id: number | string, offset = 0, version?: number) {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset must be a nonnegative byte offset");
    const field = kind === "annotations" ? "note" : "content";
    const condition = kind === "documents" ? "name = ? AND version = COALESCE(?, (SELECT MAX(version) FROM documents WHERE name = ?))" : "id = ?";
    const params = kind === "documents" ? [id, version ?? null, id] : [id];
    const row = this.db.prepare(`SELECT id, ts, substr(agent,1,64) AS agent,
      ${kind === "documents" ? "name, version, substr(mime,1,255) AS mime," : ""}
      substr(CAST(COALESCE(${field},'') AS BLOB), ?, ?) AS chunk, length(CAST(COALESCE(${field},'') AS BLOB)) AS bytes
      FROM ${kind} WHERE ${condition}`).get(offset + 1, Math.floor(this.budget / 16), ...params) as Row | undefined;
    if (!row) return null;
    if (offset > row.bytes || (row.chunk.length && (row.chunk[0] & 0xc0) === 0x80)) throw new Error("offset is not a valid UTF-8 byte boundary");
    const content = utf8(row.chunk); delete row.chunk;
    const next = offset + Buffer.byteLength(content);
    return { meta: row, content, offset, next_offset: next < row.bytes ? next : null };
  }

  search(opts: { query: string; scope?: "messages" | "documents" | "all"; after_id?: number; limit?: number; include_archived?: boolean }) {
    // A single scope and ID cursor make every match reachable with bounded memory.
    const scope = opts.scope === "documents" ? "documents" : "messages";
    const limit = Math.min(opts.limit ?? 20, 100);
    const params: unknown[] = [opts.after_id ?? 0];
    let filter = "";
    if (scope === "messages" && this.cfg.retentionDays && !opts.include_archived) {
      filter = "AND d.ts >= ?"; params.push(new Date(Date.now() - this.cfg.retentionDays * 86400000).toISOString());
    }
    if (scope === "documents") filter = "AND d.version = (SELECT MAX(version) FROM documents WHERE name = d.name)";
    const sql = `SELECT d.id FROM ${scope}_fts f JOIN ${scope} d ON d.id=f.rowid
      WHERE ${scope}_fts MATCH ? AND d.id > ? ${filter} ORDER BY d.id LIMIT ?`;
    let rows: Row[];
    try { rows = this.db.prepare(sql).all(opts.query, ...params, limit + 1) as Row[]; }
    catch (e) {
      if (!(e instanceof Error) || !/fts5|syntax|unterminated|no such column/i.test(e.message)) throw e;
      rows = this.db.prepare(sql).all(`"${opts.query.replaceAll('"', '""')}"`, ...params, limit + 1) as Row[];
    }
    return this.page(rows, row => {
      if (scope === "messages") return this.message(this.db.prepare(`SELECT id,ts,substr(agent,1,64) AS agent,reply_to,
        substr(CAST(content AS BLOB),1,512) AS content,length(CAST(content AS BLOB)) AS bytes FROM messages WHERE id=?`).get(row.id) as Row);
      return this.document(this.db.prepare(`SELECT id,name,version,ts,substr(agent,1,64) AS agent,substr(mime,1,255) AS mime,
        length(CAST(content AS BLOB)) AS bytes FROM documents WHERE id=?`).get(row.id) as Row);
    }, row => row.id, limit);
  }
}
