import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Principal } from "./auth.js";

const short = z.string().max(1000);
const text = z.string().refine(s => Buffer.byteLength(s) <= 40 * 1024, "Maximum 40 KiB of UTF-8 text");
const sha = z.string().regex(/^[a-f0-9]{40}([a-f0-9]{24})?$/);
const repo = z.string().regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/);
const links = z.array(z.string().url().max(2000).refine(s => /^https?:\/\//.test(s))).max(10).default([]);
export const recordSchemas = {
  status: z.object({ summary: short.min(1), detail: text.default(""), state: z.enum(["working", "blocked", "idle", "finished"]),
    task: short.default(""), repo: short.default(""), branch: short.default(""), worktree: short.default(""), blockers: short.default("") }).strict(),
  work: z.object({ title: short.min(1), state: z.enum(["open", "working", "blocked", "done"]), repo: short.default(""), branch: short.default(""),
    areas: z.array(z.string().max(300)).max(100).default([]), depends_on: z.array(z.string().max(200)).max(30).default([]),
    blockers: short.default(""), lease_until: z.number().int().nonnegative().safe() }).strict(),
  pr: z.object({ repo, number: z.number().int().positive(), url: z.string().url().max(2000).refine(s => s.startsWith("https://")), title: short,
    description: z.string().refine(s=>Buffer.byteLength(s)<=256*1024,"PR description exceeds 256 KiB"), state: z.enum(["open", "closed", "merged"]), draft: z.boolean(), head_sha: sha,
    review: short, ci: short, synced_at: z.string().datetime(), source: z.literal("github") }).strict(),
  pr_note: z.object({ summary: short, detail: text.default("") }).strict(),
  test: z.object({ repo, commit: sha, suite: short.min(1), command: short, state: z.enum(["running", "passed", "failed", "canceled"]),
    started_at: z.string().datetime(), finished_at: z.string().datetime().optional(), summary: short, artifacts: links }).strict(),
  log: z.object({ level: z.enum(["info", "warn", "error"]), summary: short.min(1), output: text.default(""),
    repo: short.default(""), commit: sha.optional(), work_key: short.default(""), artifacts: links }).strict(),
};
export type RecordKind = keyof typeof recordSchemas;
type Row = Record<string, any>;
function fail(message: string): never { throw new Error(`oneroom: ${message}`); }
const number = (value: number, min = 0, max = Number.MAX_SAFE_INTEGER) => z.number().int().min(min).max(max).parse(value);

/** Persistent room state. Every mutation is bounded and runs inside Room's capacity transaction. */
export class Collaboration {
  private members: Principal[] = [{ id: "admin", role: "admin" }];
  constructor(private db: Database.Database, private write: <T>(bytes: number, action: () => T) => T, private budget: number) {}
  setMembers(members: Principal[]) { this.members = members.map(m => ({ ...m })); }
  directory(after = "", limit = 20) {
    const items = this.members.filter(m => m.id > after).sort((a,b) => a.id < b.id ? -1 : 1).slice(0, number(limit,1,100) + 1);
    const more = items.length > limit; if (more) items.pop();
    return { items, has_more: more, next_cursor: more ? items.at(-1)!.id : null };
  }
  private page(rows: Row[], limit: number) {
    const items: Row[] = []; let size = 0;
    for (const row of rows) {
      const bytes = Buffer.byteLength(JSON.stringify(row));
      if (items.length >= limit || size + bytes > this.budget / 8) break;
      items.push(row); size += bytes;
    }
    const has_more = items.length < rows.length;
    return { items, has_more, next_cursor: has_more ? items.at(-1)?.id ?? null : null };
  }
  private event(agent: string, kind: string, target: string, recipient: string | null = null, question = false) {
    const id = Number(this.db.prepare("INSERT INTO room_events(agent,kind,target,recipient,question) VALUES (?,?,?,?,?)")
      .run(agent,kind,target,recipient,Number(question)).lastInsertRowid);
    if (recipient) this.db.prepare("INSERT INTO attention(event_id,recipient) VALUES (?,?)").run(id,recipient);
    return id;
  }
  messagePosted(id: number, agent: string, content: string, replyTo?: number, mentions: string[] = [], question = false) {
    z.array(z.string()).max(100).parse(mentions); z.boolean().parse(question);
    const explicit = new Set(mentions);
    // @ handles are exact directory IDs. Unknown textual handles remain ordinary text;
    // explicit mention IDs reject typos instead of silently losing a notification.
    for (const recipient of explicit) if (!this.members.some(m => m.id === recipient)) fail(`unknown recipient ${recipient}`);
    for (const match of content.matchAll(/(?:^|\s)@([a-zA-Z0-9_.-]+)/g)) {
      const handle = match[1].replace(/[.,]+$/, "");
      if (this.members.some(m => m.id === handle)) explicit.add(handle);
    }
    const parent = replyTo ? this.db.prepare("SELECT t.root_id,m.agent FROM thread_links t JOIN messages m ON m.id=t.message_id WHERE m.id=?").get(replyTo) as Row : undefined;
    const root = parent?.root_id ?? id;
    this.db.prepare("INSERT INTO thread_links(message_id,root_id,question) VALUES (?,?,?)").run(id,root,Number(question));
    this.event(agent,"message",String(id));
    if (parent) {
      explicit.add(parent.agent);
      const author = this.db.prepare("SELECT agent FROM messages WHERE id=?").get(root) as Row;
      explicit.add(author.agent);
    }
    explicit.delete(agent);
    for (const recipient of explicit) this.event(agent, mentions.includes(recipient) || content.includes(`@${recipient}`) ? "mention" : "reply",String(id),recipient,question);
  }
  thread(root: number, after = 0, limit = 20) {
    number(root,1); number(after); number(limit,1,100);
    const link = this.db.prepare("SELECT root_id FROM thread_links WHERE message_id=?").get(root) as Row | undefined;
    if (!link) fail("thread does not exist");
    return { root_id: link.root_id, ...this.page(this.db.prepare(`SELECT m.id,m.agent,m.ts,m.reply_to,t.question,substr(m.content,1,512) AS preview
      FROM thread_links t JOIN messages m ON m.id=t.message_id WHERE t.root_id=? AND m.id>? ORDER BY m.id LIMIT ?`).all(link.root_id,after,limit+1) as Row[],limit) };
  }
  events(after = 0, limit = 20, recipient?: string) {
    number(after); number(limit,1,100);
    return this.page(this.db.prepare(`SELECT * FROM room_events WHERE id>? ${recipient ? "AND recipient=?" : ""} ORDER BY id LIMIT ?`)
      .all(...(recipient ? [after,recipient,limit+1] : [after,limit+1])) as Row[],limit);
  }
  inbox(agent: string, after = 0, limit = 20, includeResolved = false) {
    number(after); number(limit,1,100);
    return this.page(this.db.prepare(`SELECT a.id,a.event_id,a.state,a.updated_at,e.agent,e.kind,e.target,e.question,e.ts FROM attention a
      JOIN room_events e ON e.id=a.event_id WHERE a.recipient=? AND a.id>? ${includeResolved ? "" : "AND a.state!='resolved'"} ORDER BY a.id LIMIT ?`)
      .all(agent,after,limit+1) as Row[],limit);
  }
  attention(agent: string, id: number, state: "acknowledged" | "answered" | "resolved") {
    number(id,1); z.enum(["acknowledged","answered","resolved"]).parse(state);
    return this.write(0, () => {
      const item = this.db.prepare("SELECT * FROM attention WHERE id=? AND recipient=?").get(id,agent) as Row | undefined;
      if (!item) fail("attention item does not belong to you");
      this.db.prepare("UPDATE attention SET state=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(state,id);
      this.event(agent,"attention",`${id}:${state}`);
      return { id,state };
    });
  }
  latest(kind: RecordKind, key: string, version?: number): Row | null {
    z.enum(Object.keys(recordSchemas) as [RecordKind,...RecordKind[]]).parse(kind); z.string().min(1).max(200).parse(key);
    if (version !== undefined) number(version,1);
    const row = this.db.prepare(`SELECT * FROM room_records WHERE kind=? AND key=? ${version ? "AND version=?" : ""} ORDER BY version DESC LIMIT 1`)
      .get(...(version ? [kind,key,version] : [kind,key])) as Row | undefined;
    return row ? { ...row,data:JSON.parse(row.data) } : null;
  }
  put(agent: string, kind: RecordKind, key: string, data: unknown, expectedVersion: number, source = false) {
    z.string().min(1).max(64).parse(agent); z.string().min(1).max(200).parse(key); number(expectedVersion);
    const parsed = recordSchemas[kind].parse(data) as Row;
    if (kind === "status" && key !== agent) fail("status key must be your identity");
    if (kind === "pr" && !source) fail("PR source fields are updated only by the GitHub synchronizer");
    if (kind === "pr_note" && !this.latest("pr",key)) fail("PR does not exist");
    if (kind === "log") parsed.output = redact(parsed.output);
    if (kind === "work") {
      if (parsed.lease_until > Date.now() + 24*3600000) fail("work lease cannot exceed 24 hours");
      if (parsed.depends_on.includes(key)) fail("work cannot depend on itself");
      for (const dependency of parsed.depends_on) {
        if (!this.latest("work",dependency)) fail(`missing work dependency ${dependency}`);
        const cycle=this.db.prepare(`WITH RECURSIVE dependencies(key) AS (
          SELECT ? UNION SELECT j.value FROM dependencies d JOIN room_records r ON r.kind='work' AND r.key=d.key
          AND r.version=(SELECT MAX(n.version) FROM room_records n WHERE n.kind='work' AND n.key=r.key),json_each(r.data,'$.depends_on') j
        ) SELECT 1 FROM dependencies WHERE key=? LIMIT 1`).get(dependency,key);
        if(cycle)fail("work dependency would create a cycle");
      }
    }
    const encoded = JSON.stringify(parsed);
    if (Buffer.byteLength(encoded) > (kind==="pr" ? 320 : 56) * 1024) fail("record exceeds byte limit");
    return this.write(Buffer.byteLength(encoded), () => {
      const previous = this.latest(kind,key);
      if ((previous?.version ?? 0) !== expectedVersion) fail("version conflict; read latest and retry with a new request_id");
      if (previous && previous.agent !== agent && kind !== "pr" && !(kind === "work" && previous.data.lease_until <= Date.now())) fail("record belongs to another agent");
      if (kind === "log" && previous) fail("log entries are immutable; use a new key");
      if (kind === "test" && previous && (previous.data.repo !== parsed.repo || previous.data.commit !== parsed.commit || previous.data.suite !== parsed.suite)) fail("test run identity cannot change");
      const version = expectedVersion + 1;
      const id = Number(this.db.prepare("INSERT INTO room_records(kind,key,agent,version,data) VALUES (?,?,?,?,?)").run(kind,key,agent,version,encoded).lastInsertRowid);
      this.event(agent,kind,key);
      return { id,kind,key,version };
    });
  }
  syncPr(data: z.infer<typeof recordSchemas.pr>) {
    const parsed=recordSchemas.pr.parse(data);const key=`${parsed.repo}#${parsed.number}`;
    return this.write(0,()=>{
      const old=this.latest("pr",key);
      const {synced_at:_newTime,...newData}=parsed;
      const {synced_at:_oldTime,...oldData}=old?.data ?? {};
      const same=JSON.stringify(newData)===JSON.stringify(oldData);
      const result=same ? {key,version:old!.version,changed:false} : {...this.put("github","pr",key,parsed,old?.version??0,true),changed:true};
      this.db.prepare("INSERT INTO source_checks(key,checked_at) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET checked_at=excluded.checked_at").run(key,parsed.synced_at);
      return result;
    });
  }
  records(kind: RecordKind, after = 0, limit = 20, historyKey?: string) {
    z.enum(Object.keys(recordSchemas) as [RecordKind,...RecordKind[]]).parse(kind); number(after); number(limit,1,100);
    if (historyKey !== undefined) z.string().max(200).parse(historyKey);
    // Project small summaries in SQL; never load every 40 KiB note to render a board.
    const rows = this.db.prepare(`SELECT r.id,r.ts,r.kind,r.key,r.agent,r.version,
      substr(COALESCE(json_extract(r.data,'$.summary'),json_extract(r.data,'$.title'),json_extract(r.data,'$.suite'),''),1,300) AS summary,
      json_extract(r.data,'$.state') AS state,json_extract(r.data,'$.repo') AS repo,json_extract(r.data,'$.branch') AS branch,
      json_extract(r.data,'$.commit') AS "commit",json_extract(r.data,'$.head_sha') AS head_sha,
      COALESCE((SELECT checked_at FROM source_checks WHERE key=r.key AND r.kind='pr'),json_extract(r.data,'$.synced_at')) AS synced_at,json_extract(r.data,'$.lease_until') AS lease_until
      FROM room_records r WHERE r.kind=? AND r.id>? ${historyKey !== undefined ? "AND r.key=?" : "AND NOT EXISTS (SELECT 1 FROM room_records n WHERE n.kind=r.kind AND n.key=r.key AND n.id>r.id)"}
      ORDER BY r.id LIMIT ?`).all(...(historyKey !== undefined ? [kind,after,historyKey,limit+1] : [kind,after,limit+1])) as Row[];
    return this.page(rows.map(r => ({...r,...(r.lease_until !== null ? {lease_expired:r.lease_until <= Date.now()} : {})})),limit);
  }
  prTests(key:string,after=0,limit=20) {
    number(after);number(limit,1,100);
    const pr=this.latest("pr",key);if(!pr)fail("PR does not exist");
    const checked=this.db.prepare("SELECT checked_at FROM source_checks WHERE key=?").get(key) as Row | undefined;
    const rows=this.db.prepare(`SELECT r.id,r.key,r.agent,r.version,r.ts,json_extract(r.data,'$.state') AS state,
      substr(json_extract(r.data,'$.suite'),1,300) AS suite,substr(json_extract(r.data,'$.summary'),1,300) AS summary
      FROM room_records r WHERE r.kind='test' AND r.id>? AND json_extract(r.data,'$.repo')=? AND json_extract(r.data,'$.commit')=?
      AND NOT EXISTS(SELECT 1 FROM room_records n WHERE n.kind=r.kind AND n.key=r.key AND n.id>r.id) ORDER BY r.id LIMIT ?`)
      .all(after,pr.data.repo,pr.data.head_sha,limit+1) as Row[];
    return {repo:pr.data.repo,head_sha:pr.data.head_sha,provider_ci:pr.data.ci,provider_review:pr.data.review,synced_at:checked?.checked_at ?? pr.data.synced_at,...this.page(rows,limit)};
  }
  content(kind: RecordKind, key: string, offset = 0, version?: number) {
    number(offset); const row = this.latest(kind,key,version); if (!row) return null;
    const bytes = Buffer.from(JSON.stringify(row.data,null,2));
    if (offset > bytes.length || (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80)) fail("invalid UTF-8 offset");
    let end = Math.min(bytes.length,offset+Math.floor(this.budget/16));
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    return { kind,key,version:row.version,agent:row.agent,ts:row.ts,content:bytes.subarray(offset,end).toString(),next_offset:end < bytes.length ? end : null };
  }
  registerRunner(agent: string, seconds: number) {
    number(seconds,30,86400);
    return this.write(0,()=>{
      const now=Date.now();
      this.db.prepare(`INSERT INTO checkins(agent,interval_seconds,last_seen,next_due) VALUES (?,?,0,?)
        ON CONFLICT(agent) DO UPDATE SET interval_seconds=excluded.interval_seconds,
        next_due=MIN(checkins.next_due,?+excluded.interval_seconds*1000)`).run(agent,seconds,now,now);
      return { agent,interval_seconds:seconds };
    });
  }
  checkin(agent: string, seconds: number) {
    number(seconds,30,86400);
    return this.write(0, () => {
      const now = Date.now();
      this.db.prepare(`INSERT INTO checkins(agent,interval_seconds,last_seen,next_due) VALUES (?,?,?,?) ON CONFLICT(agent)
        DO UPDATE SET interval_seconds=excluded.interval_seconds,last_seen=excluded.last_seen,next_due=excluded.next_due`).run(agent,seconds,now,now+seconds*1000);
      return { agent,last_seen:now,next_due:now+seconds*1000,interval_seconds:seconds };
    });
  }
  checkins(after = 0, limit = 20) {
    number(after); number(limit,1,100);
    return this.page((this.db.prepare("SELECT id,agent,interval_seconds,last_seen,next_due,lease_until,failures FROM checkins WHERE id>? ORDER BY id LIMIT ?").all(after,limit+1) as Row[])
      .map(r => ({...r,overdue: r.next_due < Date.now()})),limit);
  }
  claimWake(agent: string, leaseSeconds = 300, now = Date.now()) {
    number(leaseSeconds,30,3600);
    return this.write(0, () => {
      const row = this.db.prepare("SELECT * FROM checkins WHERE agent=?").get(agent) as Row | undefined;
      if (!row) fail("register a check-in interval first");
      if (row.lease_until > now || row.retry_after > now) return null;
      const event = (this.db.prepare("SELECT COALESCE(MAX(id),0) AS id FROM room_events WHERE recipient=?").get(agent) as Row).id;
      if (event <= row.delivered_event && row.next_due > now) return null;
      const token = randomUUID();
      this.db.prepare("UPDATE checkins SET lease_token=?,lease_until=?,lease_event=? WHERE agent=?").run(token,now+leaseSeconds*1000,event,agent);
      return { token,through_event:event,reason:event > row.delivered_event ? "notification" : "check_in_due",lease_until:now+leaseSeconds*1000 };
    });
  }
  finishWake(agent: string, token: string, through: number, success: boolean, now = Date.now()) {
    number(through); z.string().uuid().parse(token); z.boolean().parse(success);
    return this.write(0, () => {
      const row = this.db.prepare("SELECT * FROM checkins WHERE agent=? AND lease_token=? AND lease_until>?").get(agent,token,now) as Row | undefined;
      if (!row) fail("wake lease expired or does not belong to you");
      // A caller may acknowledge only the watermark captured by its claim.
      const max = (this.db.prepare("SELECT COALESCE(MAX(id),0) AS id FROM room_events WHERE recipient=?").get(agent) as Row).id;
      if (through !== row.lease_event || through > max) fail("invalid event watermark");
      this.db.prepare(`UPDATE checkins SET lease_token=NULL,lease_until=0,delivered_event=?,next_due=?,last_seen=?,failures=?,retry_after=? WHERE agent=?`)
        .run(success ? Math.max(row.delivered_event,through) : row.delivered_event,success ? now+row.interval_seconds*1000 : row.next_due,
          success ? now : row.last_seen,success ? 0 : row.failures+1,success ? 0 : now+Math.min(300000,1000*2**Math.min(row.failures+1,8)),agent);
      return { success };
    });
  }
}
export function redact(value: string): string {
  return value.replace(/(bearer\s+)[^\s"']+/gi,"$1[REDACTED]")
    .replace(/((?:token|password|secret|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi,"$1[REDACTED]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|or_[A-Za-z0-9_-]{20,})\b/g,"[REDACTED]");
}
