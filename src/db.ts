import { createHash } from "node:crypto";
import fs from "node:fs";
import { migrate, SCHEMA_VERSION } from "./migrations.js";
import { Collaboration } from "./collaboration.js";
import { ReadModel } from "./reads.js";
import { z } from "zod";
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


export class Room {
  private db: Database.Database;
  readonly reads: ReadModel;
  readonly collaboration: Collaboration;

  constructor(private cfg: Config) {
    this.db = new Database(cfg.dbPath);
    try {
      // Apply additive schema changes before enforcing the write cap so existing
      // rooms can still be opened and exported when a lowered cap is exceeded.
      migrate(this.db);
      const pageSize = this.db.pragma("page_size", { simple: true }) as number;
      this.db.pragma(`max_page_count = ${Math.max(1, Math.floor(cfg.maxDbBytes / pageSize))}`);
      this.db.pragma("journal_size_limit = 4194304");
      this.reads = new ReadModel(this.db, cfg);
      this.collaboration = new Collaboration(this.db, (bytes, action) => this.write(bytes, action), this.reads.budget);
    } catch (e) {
      this.db.close();
      throw e;
    }
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
    const disk = fs.statfsSync(this.cfg.dataDir);
    if (disk.bavail * disk.bsize < (this.cfg.minFreeDiskBytes ?? 0)) {
      throw new Error("oneroom: free disk reserve reached; free space or relocate the room before writing");
    }
    if (this.dbSizeBytes() + incomingBytes > this.cfg.maxDbBytes) {
      throw new Error(
        `oneroom: database size limit reached (${Math.round(this.cfg.maxDbBytes / 1024 / 1024)} MB). ` +
          `Writes are rejected to honor the storage bound. Raise ONEROOM_MAX_DB_MB or start a new room.`
      );
    }
  }

  private write<T>(incomingBytes: number, action: () => T): T {
    try {
      return this.db.transaction(() => {
        this.assertCapacity(incomingBytes);
        const result = action();
        this.assertCapacity(0);
        return result;
      }).immediate();
    } catch (e) {
      if (e instanceof Error && "code" in e && e.code === "SQLITE_FULL") {
        throw new Error("oneroom: database size limit reached; raise ONEROOM_MAX_DB_MB or start a new room (also check free disk space).");
      }
      throw e;
    }
  }

  idempotent<T>(principal: string, requestId: string, operation: string, args: unknown, action: () => T): T {
    z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.:-]+$/).parse(requestId);
    const canonical = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(canonical);
      if (value && typeof value === "object") return Object.fromEntries(
        Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
      return value;
    };
    const fingerprint = createHash("sha256").update(JSON.stringify([operation, canonical(args)])).digest("hex");
    // Check replay before capacity checks: retries of committed operations must
    // remain available even when the room fills up after the original write.
    return this.db.transaction(() => {
      const previous = this.db.prepare("SELECT fingerprint, response FROM requests WHERE principal = ? AND request_id = ?")
        .get(principal, requestId) as { fingerprint: string; response: string } | undefined;
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new Error("oneroom: request_id was already used for a different operation or payload");
        return JSON.parse(previous.response) as T;
      }
      return this.write(0, () => {
        const result = action();
        this.db.prepare("INSERT INTO requests(principal, request_id, fingerprint, response) VALUES (?, ?, ?, ?)")
          .run(principal, requestId, fingerprint, JSON.stringify(result));
        return result;
      });
    }).immediate();
  }

  operationalStatus() {
    const disk = fs.statfsSync(this.cfg.dataDir);
    const size = (suffix: string) => { try { return fs.statSync(this.cfg.dbPath + suffix).size; } catch { return 0; } };
    const dbBytes = this.dbSizeBytes();
    const freeBytes = disk.bavail * disk.bsize;
    return {
      schema_version: SCHEMA_VERSION, db_bytes: dbBytes, max_db_bytes: this.cfg.maxDbBytes,
      wal_bytes: size("-wal"), shm_bytes: size("-shm"), disk_free_bytes: freeBytes,
      disk_reserve_bytes: this.cfg.minFreeDiskBytes ?? 0,
      warnings: [
        ...(dbBytes >= this.cfg.maxDbBytes * 0.8 ? ["database_capacity"] : []),
        ...(freeBytes < Math.max((this.cfg.minFreeDiskBytes ?? 0) * 2, this.cfg.maxDbBytes) ? ["disk_capacity"] : []),
        ...(size("-wal") > this.cfg.maxDbBytes ? ["wal_growth"] : []),
      ],
    };
  }

  /** ISO cutoff before which messages are considered archived, or null if retention is unlimited. */
  retentionCutoff(): string | null {
    if (this.cfg.retentionDays <= 0) return null;
    return new Date(Date.now() - this.cfg.retentionDays * 86_400_000).toISOString();
  }

  // ---- messages -----------------------------------------------------------

  postMessage(agent: string, content: string, replyTo?: number, mentions: string[] = [], question = false): Message {
    z.string().min(1).max(64).refine(value => value.trim().length > 0).parse(agent);
    z.string().min(1).parse(content);
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > this.cfg.maxMessageBytes) {
      throw new Error(
        `oneroom: message is ${bytes} bytes; limit is ${this.cfg.maxMessageBytes}. ` +
          `Store large content as a document and post a summary instead.`
      );
    }
    z.number().int().positive().safe().optional().parse(replyTo);
    if (replyTo !== undefined) {
      const parent = this.db.prepare("SELECT id FROM messages WHERE id = ?").get(replyTo);
      if (!parent) throw new Error(`oneroom: reply_to message ${replyTo} does not exist`);
    }
    const info = this.write(bytes, () => {
      const info = this.db.prepare("INSERT INTO messages (agent, content, reply_to) VALUES (?, ?, ?)").run(agent, content, replyTo ?? null);
      this.collaboration.messagePosted(Number(info.lastInsertRowid), agent, content, replyTo, mentions, question);
      return info;
    });
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
    // Poll forward from the cursor without skipping the oldest unread messages.
    // With no afterId, select the newest window, still returned chronologically.
    const rows = this.db
      .prepare(
        `SELECT id, ts, agent, content, reply_to FROM (
           SELECT id, ts, agent, content, reply_to FROM messages ${whereSql}
           ORDER BY id ${opts.afterId !== undefined ? "ASC" : "DESC"} LIMIT ?
         ) ORDER BY id ASC`
      )
      .all(...params, limit) as Omit<Message, "annotations">[];
    return rows.map((r) => ({ ...r, annotations: this.annotationsForMessage(r.id) }));
  }

  // ---- annotations ----------------------------------------------------------

  private annotationsForMessage(messageId: number): Annotation[] {
    return this.db
      .prepare(
        "SELECT id, ts, agent, flag, note FROM annotations WHERE message_id = ? ORDER BY id ASC LIMIT 100"
      )
      .all(messageId) as Annotation[];
  }

  private annotationsForDocument(name: string, version?: number): Annotation[] {
    return this.db
      .prepare(
        "SELECT id, ts, agent, flag, note FROM annotations WHERE document_name = ? AND (document_version IS NULL OR document_version = ?) ORDER BY id ASC LIMIT 100"
      )
      .all(name, version ?? this.latestDocumentRow(name)?.version ?? null) as Annotation[];
  }

  annotate(opts: {
    agent: string;
    flag: Flag;
    note?: string;
    messageId?: number;
    documentName?: string;
    documentVersion?: number;
  }): Annotation {
    z.string().min(1).max(64).refine(value => value.trim().length > 0).parse(opts.agent);
    z.enum(FLAGS).parse(opts.flag);
    z.string().min(1).max(200).optional().parse(opts.documentName);
    z.number().int().positive().safe().optional().parse(opts.messageId);
    z.string().optional().parse(opts.note);
    z.number().int().nonnegative().safe().optional().parse(opts.documentVersion);
    if (opts.documentVersion === 0 && opts.flag !== "resolved") throw new Error("document_version 0 is only for resolving legacy name-wide pins");
    if (opts.messageId !== undefined && opts.documentVersion !== undefined) throw new Error("document_version requires a document target");
    const targetVersion = opts.documentName === undefined ? null : opts.documentVersion === 0 ? null : opts.documentVersion ?? this.latestDocumentRow(opts.documentName)?.version;
    if (opts.documentName !== undefined && !this.getDocument(opts.documentName, targetVersion ?? undefined)) throw new Error("document version does not exist");
    const noteBytes = Buffer.byteLength(opts.note ?? "", "utf8");
    if (noteBytes > this.cfg.maxMessageBytes) throw new Error("oneroom: annotation note exceeds message size limit");
    if ((opts.messageId === undefined) === (opts.documentName === undefined)) {
      throw new Error("oneroom: annotate exactly one target — message_id or document_name");
    }
    if (opts.messageId !== undefined && !this.getMessage(opts.messageId)) {
      throw new Error(`oneroom: message ${opts.messageId} does not exist`);
    }
    if (opts.documentName !== undefined && !this.latestDocumentRow(opts.documentName)) {
      throw new Error(`oneroom: document "${opts.documentName}" does not exist`);
    }
    const info = this.write(noteBytes, () => this.db
      .prepare(
        "INSERT INTO annotations (agent, message_id, document_name, flag, note, document_version) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(opts.agent, opts.messageId ?? null, opts.documentName ?? null, opts.flag, opts.note ?? null, targetVersion));
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
    z.string().min(1).max(64).refine(value => value.trim().length > 0).parse(agent);
    z.string().min(1).parse(content);
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > this.cfg.maxDocBytes) {
      throw new Error(
        `oneroom: document is ${bytes} bytes; limit is ${this.cfg.maxDocBytes} (ONEROOM_MAX_DOC_KB).`
      );
    }
    z.string().min(1).max(200).refine(value => value.trim().length > 0).parse(name);
    z.string().min(1).max(255).regex(/^[^\r\n]+$/).optional().parse(mime);
    return this.write(bytes, () => {
      const latest = this.latestDocumentRow(name);
      const version = (latest?.version ?? 0) + 1;
      this.db
        .prepare("INSERT INTO documents (agent, name, version, mime, content) VALUES (?, ?, ?, ?, ?)")
        .run(agent, name, version, mime ?? latest?.mime ?? "text/markdown", content);
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
    });
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
        annotations: this.annotationsForDocument(name, row.version),
      },
      content: row.content,
    };
  }

  listDocuments(): DocumentMeta[] {
    const rows = this.db
      .prepare(
        `SELECT d.ts, d.agent, d.name, d.version, d.mime, length(CAST(d.content AS BLOB)) AS bytes
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
           AND d.version = (SELECT MAX(latest.version) FROM documents latest WHERE latest.name = d.name)
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
    schema_version: number;
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
      schema_version: SCHEMA_VERSION,
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

  *exportChunks(): Generator<string> {
    const tables = ["messages", "annotations", "documents", "room_records", "room_events", "attention", "checkins", "thread_links", "source_checks"] as const;
    const maxima = tables.map((table) =>
      (this.db.prepare(`SELECT COALESCE(MAX(${table === "thread_links" ? "message_id" : "id"}), 0) AS id FROM ${table}`).get() as { id: number }).id);
    yield `{"exported_at":${JSON.stringify(new Date().toISOString())},"status":${JSON.stringify(this.status())}`;
    for (const [index, table] of tables.entries()) {
      yield `,"${table}":[`;
      let after = 0;
      let first = true;
      while (after < maxima[index]) {
        // One row at a time bounds memory even with large document versions.
        const row = this.db.prepare(`SELECT *, ${table === "thread_links" ? "message_id" : "id"} AS id FROM ${table} WHERE ${table === "thread_links" ? "message_id" : "id"} > ? AND ${table === "thread_links" ? "message_id" : "id"} <= ? ORDER BY ${table === "thread_links" ? "message_id" : "id"} LIMIT 1`)
          .get(after, maxima[index]) as { id: number } | undefined;
        if (!row) break;
        yield `${first ? "" : ","}${JSON.stringify(row)}`;
        first = false;
        after = row.id;
      }
      yield "]";
    }
    yield "}";
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
