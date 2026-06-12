import Database from "better-sqlite3";
import type { Config } from "./config.js";

export const FLAGS = ["read-first", "stale", "outdated", "failed", "resolved", "note"] as const;
export type Flag = (typeof FLAGS)[number];

export interface Annotation {
  id: number;
  ts: string;
  agent: string;
  flag: Flag;
  note: string | null;
}

export interface Message {
  id: number;
  ts: string;
  agent: string;
  content: string;
  reply_to: number | null;
  annotations: Annotation[];
}

export interface DocumentMeta {
  name: string;
  version: number;
  mime: string;
  agent: string;
  ts: string;
  bytes: number;
  annotations: Annotation[];
}

const SCHEMA = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  agent TEXT NOT NULL,
  content TEXT NOT NULL,
  reply_to INTEGER REFERENCES messages(id)
);

CREATE TRIGGER IF NOT EXISTS messages_no_update BEFORE UPDATE ON messages
BEGIN SELECT RAISE(ABORT, 'oneroom: messages are append-only'); END;
CREATE TRIGGER IF NOT EXISTS messages_no_delete BEFORE DELETE ON messages
BEGIN SELECT RAISE(ABORT, 'oneroom: messages are append-only'); END;

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content, agent, content='messages', content_rowid='id'
);
CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages
BEGIN INSERT INTO messages_fts(rowid, content, agent) VALUES (new.id, new.content, new.agent); END;

CREATE TABLE IF NOT EXISTS annotations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  agent TEXT NOT NULL,
  message_id INTEGER REFERENCES messages(id),
  document_name TEXT,
  flag TEXT NOT NULL CHECK (flag IN ('read-first','stale','outdated','failed','resolved','note')),
  note TEXT,
  CHECK (message_id IS NOT NULL OR document_name IS NOT NULL)
);

CREATE TRIGGER IF NOT EXISTS annotations_no_update BEFORE UPDATE ON annotations
BEGIN SELECT RAISE(ABORT, 'oneroom: annotations are append-only'); END;
CREATE TRIGGER IF NOT EXISTS annotations_no_delete BEFORE DELETE ON annotations
BEGIN SELECT RAISE(ABORT, 'oneroom: annotations are append-only'); END;

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  agent TEXT NOT NULL,
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  mime TEXT NOT NULL DEFAULT 'text/markdown',
  content TEXT NOT NULL,
  UNIQUE (name, version)
);

CREATE TRIGGER IF NOT EXISTS documents_no_update BEFORE UPDATE ON documents
BEGIN SELECT RAISE(ABORT, 'oneroom: documents are append-only; store a new version instead'); END;
CREATE TRIGGER IF NOT EXISTS documents_no_delete BEFORE DELETE ON documents
BEGIN SELECT RAISE(ABORT, 'oneroom: documents are append-only'); END;

CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
  name, content, content='documents', content_rowid='id'
);
CREATE TRIGGER IF NOT EXISTS documents_fts_ai AFTER INSERT ON documents
BEGIN INSERT INTO documents_fts(rowid, name, content) VALUES (new.id, new.name, new.content); END;
`;

export class Room {
  private db: Database.Database;

  constructor(private cfg: Config) {
    this.db = new Database(cfg.dbPath);
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ---- limits -------------------------------------------------------------

  dbSizeBytes(): number {
    const { page_count } = this.db.prepare("PRAGMA page_count").get() as { page_count: number };
    const { page_size } = this.db.prepare("PRAGMA page_size").get() as { page_size: number };
    return page_count * page_size;
  }

  private assertCapacity(incomingBytes: number): void {
    if (this.dbSizeBytes() + incomingBytes > this.cfg.maxDbBytes) {
      throw new Error(
        `oneroom: database size limit reached (${Math.round(this.cfg.maxDbBytes / 1024 / 1024)} MB). ` +
          `Writes are rejected to honor the storage bound. Raise ONEROOM_MAX_DB_MB or start a new room.`
      );
    }
  }

  /** ISO cutoff before which messages are considered archived, or null if retention is unlimited. */
  retentionCutoff(): string | null {
    if (this.cfg.retentionDays <= 0) return null;
    return new Date(Date.now() - this.cfg.retentionDays * 86_400_000).toISOString();
  }

  // ---- messages -----------------------------------------------------------

  postMessage(agent: string, content: string, replyTo?: number): Message {
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > this.cfg.maxMessageBytes) {
      throw new Error(
        `oneroom: message is ${bytes} bytes; limit is ${this.cfg.maxMessageBytes}. ` +
          `Store large content as a document and post a summary instead.`
      );
    }
    this.assertCapacity(bytes);
    if (replyTo !== undefined) {
      const parent = this.db.prepare("SELECT id FROM messages WHERE id = ?").get(replyTo);
      if (!parent) throw new Error(`oneroom: reply_to message ${replyTo} does not exist`);
    }
    const info = this.db
      .prepare("INSERT INTO messages (agent, content, reply_to) VALUES (?, ?, ?)")
      .run(agent, content, replyTo ?? null);
    return this.getMessage(Number(info.lastInsertRowid))!;
  }

  getMessage(id: number): Message | null {
    const row = this.db
      .prepare("SELECT id, ts, agent, content, reply_to FROM messages WHERE id = ?")
      .get(id) as Omit<Message, "annotations"> | undefined;
    if (!row) return null;
    return { ...row, annotations: this.annotationsForMessage(row.id) };
  }

  readMessages(opts: {
    limit?: number;
    beforeId?: number;
    afterId?: number;
    includeArchived?: boolean;
  }): Message[] {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.beforeId !== undefined) {
      where.push("id < ?");
      params.push(opts.beforeId);
    }
    if (opts.afterId !== undefined) {
      where.push("id > ?");
      params.push(opts.afterId);
    }
    const cutoff = this.retentionCutoff();
    if (cutoff && !opts.includeArchived) {
      where.push("ts >= ?");
      params.push(cutoff);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    // Newest window, returned in chronological order.
    const rows = this.db
      .prepare(
        `SELECT id, ts, agent, content, reply_to FROM (
           SELECT id, ts, agent, content, reply_to FROM messages ${whereSql}
           ORDER BY id DESC LIMIT ?
         ) ORDER BY id ASC`
      )
      .all(...params, limit) as Omit<Message, "annotations">[];
    return rows.map((r) => ({ ...r, annotations: this.annotationsForMessage(r.id) }));
  }

  // ---- annotations ----------------------------------------------------------

  private annotationsForMessage(messageId: number): Annotation[] {
    return this.db
      .prepare(
        "SELECT id, ts, agent, flag, note FROM annotations WHERE message_id = ? ORDER BY id ASC"
      )
      .all(messageId) as Annotation[];
  }

  private annotationsForDocument(name: string): Annotation[] {
    return this.db
      .prepare(
        "SELECT id, ts, agent, flag, note FROM annotations WHERE document_name = ? ORDER BY id ASC"
      )
      .all(name) as Annotation[];
  }

  annotate(opts: {
    agent: string;
    flag: Flag;
    note?: string;
    messageId?: number;
    documentName?: string;
  }): Annotation {
    if ((opts.messageId === undefined) === (opts.documentName === undefined)) {
      throw new Error("oneroom: annotate exactly one target — message_id or document_name");
    }
    if (opts.messageId !== undefined && !this.getMessage(opts.messageId)) {
      throw new Error(`oneroom: message ${opts.messageId} does not exist`);
    }
    if (opts.documentName !== undefined && !this.latestDocumentRow(opts.documentName)) {
      throw new Error(`oneroom: document "${opts.documentName}" does not exist`);
    }
    this.assertCapacity(Buffer.byteLength(opts.note ?? "", "utf8"));
    const info = this.db
      .prepare(
        "INSERT INTO annotations (agent, message_id, document_name, flag, note) VALUES (?, ?, ?, ?, ?)"
      )
      .run(opts.agent, opts.messageId ?? null, opts.documentName ?? null, opts.flag, opts.note ?? null);
    return this.db
      .prepare("SELECT id, ts, agent, flag, note FROM annotations WHERE id = ?")
      .get(Number(info.lastInsertRowid)) as Annotation;
  }

  /** Messages flagged read-first and not later flagged resolved. */
  readFirstMessages(): Message[] {
    const ids = this.db
      .prepare(
        `SELECT DISTINCT a.message_id AS id FROM annotations a
         WHERE a.flag = 'read-first' AND a.message_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM annotations r
             WHERE r.message_id = a.message_id AND r.flag = 'resolved' AND r.id > a.id
           )
         ORDER BY a.message_id ASC`
      )
      .all() as { id: number }[];
    return ids.map((r) => this.getMessage(r.id)!).filter(Boolean);
  }

  // ---- documents ------------------------------------------------------------

  private latestDocumentRow(name: string):
    | { id: number; ts: string; agent: string; name: string; version: number; mime: string; content: string }
    | undefined {
    return this.db
      .prepare(
        "SELECT id, ts, agent, name, version, mime, content FROM documents WHERE name = ? ORDER BY version DESC LIMIT 1"
      )
      .get(name) as
      | { id: number; ts: string; agent: string; name: string; version: number; mime: string; content: string }
      | undefined;
  }

  storeDocument(agent: string, name: string, content: string, mime?: string): DocumentMeta {
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > this.cfg.maxDocBytes) {
      throw new Error(
        `oneroom: document is ${bytes} bytes; limit is ${this.cfg.maxDocBytes} (ONEROOM_MAX_DOC_KB).`
      );
    }
    this.assertCapacity(bytes);
    const insert = this.db.transaction(() => {
      const latest = this.latestDocumentRow(name);
      const version = (latest?.version ?? 0) + 1;
      this.db
        .prepare("INSERT INTO documents (agent, name, version, mime, content) VALUES (?, ?, ?, ?, ?)")
        .run(agent, name, version, mime ?? latest?.mime ?? "text/markdown", content);
      return version;
    });
    const version = insert();
    const row = this.latestDocumentRow(name)!;
    return {
      name: row.name,
      version,
      mime: row.mime,
      agent: row.agent,
      ts: row.ts,
      bytes,
      annotations: this.annotationsForDocument(name),
    };
  }

  getDocument(name: string, version?: number): { meta: DocumentMeta; content: string } | null {
    const row =
      version !== undefined
        ? (this.db
            .prepare(
              "SELECT id, ts, agent, name, version, mime, content FROM documents WHERE name = ? AND version = ?"
            )
            .get(name, version) as ReturnType<Room["latestDocumentRow"]>)
        : this.latestDocumentRow(name);
    if (!row) return null;
    return {
      meta: {
        name: row.name,
        version: row.version,
        mime: row.mime,
        agent: row.agent,
        ts: row.ts,
        bytes: Buffer.byteLength(row.content, "utf8"),
        annotations: this.annotationsForDocument(name),
      },
      content: row.content,
    };
  }

  listDocuments(): DocumentMeta[] {
    const rows = this.db
      .prepare(
        `SELECT d.ts, d.agent, d.name, d.version, d.mime, length(d.content) AS bytes
         FROM documents d
         JOIN (SELECT name, MAX(version) AS v FROM documents GROUP BY name) m
           ON d.name = m.name AND d.version = m.v
         ORDER BY d.name ASC`
      )
      .all() as Omit<DocumentMeta, "annotations">[];
    return rows.map((r) => ({ ...r, annotations: this.annotationsForDocument(r.name) }));
  }

  // ---- search ---------------------------------------------------------------

  search(opts: {
    query: string;
    scope?: "messages" | "documents" | "all";
    limit?: number;
    includeArchived?: boolean;
  }): { messages: Message[]; documents: DocumentMeta[] } {
    const scope = opts.scope ?? "all";
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const out: { messages: Message[]; documents: DocumentMeta[] } = { messages: [], documents: [] };

    const ftsQuery = (q: string, sql: string, params: unknown[]): unknown[] => {
      try {
        return this.db.prepare(sql).all(q, ...params);
      } catch {
        // FTS5 syntax error (unbalanced quotes, operators) — retry as a literal phrase.
        return this.db.prepare(sql).all(`"${q.replaceAll('"', '""')}"`, ...params);
      }
    };

    if (scope !== "documents") {
      const cutoff = this.retentionCutoff();
      const archiveFilter = cutoff && !opts.includeArchived ? "AND m.ts >= ?" : "";
      const params: unknown[] = cutoff && !opts.includeArchived ? [cutoff, limit] : [limit];
      const rows = ftsQuery(
        opts.query,
        `SELECT m.id FROM messages_fts f JOIN messages m ON m.id = f.rowid
         WHERE messages_fts MATCH ? ${archiveFilter}
         ORDER BY rank LIMIT ?`,
        params
      ) as { id: number }[];
      out.messages = rows.map((r) => this.getMessage(r.id)!).filter(Boolean);
    }

    if (scope !== "messages") {
      const rows = ftsQuery(
        opts.query,
        `SELECT d.name, MAX(d.version) AS version FROM documents_fts f
         JOIN documents d ON d.id = f.rowid
         WHERE documents_fts MATCH ?
         GROUP BY d.name ORDER BY MIN(rank) LIMIT ?`,
        [limit]
      ) as { name: string }[];
      out.documents = rows
        .map((r) => this.getDocument(r.name)?.meta)
        .filter((m): m is DocumentMeta => Boolean(m));
    }

    return out;
  }

  // ---- status ---------------------------------------------------------------

  status(): {
    messages: number;
    documents: number;
    annotations: number;
    db_bytes: number;
    max_db_bytes: number;
    max_message_bytes: number;
    max_doc_bytes: number;
    retention_days: number;
    archived_before: string | null;
  } {
    const count = (table: string): number =>
      (this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    return {
      messages: count("messages"),
      documents: count("documents"),
      annotations: count("annotations"),
      db_bytes: this.dbSizeBytes(),
      max_db_bytes: this.cfg.maxDbBytes,
      max_message_bytes: this.cfg.maxMessageBytes,
      max_doc_bytes: this.cfg.maxDocBytes,
      retention_days: this.cfg.retentionDays,
      archived_before: this.retentionCutoff(),
    };
  }

  exportAll(): unknown {
    return {
      exported_at: new Date().toISOString(),
      status: this.status(),
      messages: this.db
        .prepare("SELECT id, ts, agent, content, reply_to FROM messages ORDER BY id ASC")
        .all(),
      annotations: this.db
        .prepare("SELECT id, ts, agent, message_id, document_name, flag, note FROM annotations ORDER BY id ASC")
        .all(),
      documents: this.db
        .prepare("SELECT id, ts, agent, name, version, mime, content FROM documents ORDER BY name, version")
        .all(),
    };
  }
}
