import type Database from "better-sqlite3";

const INITIAL_SCHEMA = `

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
  CHECK ((message_id IS NOT NULL) != (document_name IS NOT NULL))
);

-- Also enforces the corrected constraint on pre-existing databases.
CREATE TRIGGER IF NOT EXISTS annotations_one_target BEFORE INSERT ON annotations
WHEN (new.message_id IS NOT NULL) = (new.document_name IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'oneroom: annotate exactly one target'); END;
CREATE INDEX IF NOT EXISTS annotations_message ON annotations(message_id, id);
CREATE INDEX IF NOT EXISTS annotations_document ON annotations(document_name, id);

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

const MIGRATIONS = [INITIAL_SCHEMA, `
ALTER TABLE annotations ADD COLUMN document_version INTEGER;
CREATE INDEX annotations_version ON annotations(document_name, document_version, id);
CREATE TRIGGER annotations_document_target BEFORE INSERT ON annotations
WHEN new.message_id IS NULL AND new.document_name IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM documents WHERE name = new.document_name
    AND (new.document_version IS NULL OR version = new.document_version)
)
BEGIN SELECT RAISE(ABORT, 'oneroom: document version does not exist'); END;
CREATE TRIGGER annotations_message_version BEFORE INSERT ON annotations
WHEN new.message_id IS NOT NULL AND new.document_version IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'oneroom: document_version requires a document target'); END;
CREATE TABLE requests (
  principal TEXT NOT NULL,
  request_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  response TEXT NOT NULL,
  PRIMARY KEY(principal, request_id)
);
CREATE TRIGGER requests_no_update BEFORE UPDATE ON requests
BEGIN SELECT RAISE(ABORT, 'oneroom: requests are append-only'); END;
CREATE TRIGGER requests_no_delete BEFORE DELETE ON requests
BEGIN SELECT RAISE(ABORT, 'oneroom: requests are append-only'); END;
`, `
CREATE TABLE room_records (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 kind TEXT NOT NULL, key TEXT NOT NULL, agent TEXT NOT NULL,
 version INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(kind,key,version)
);
CREATE INDEX room_records_latest ON room_records(kind,key,id DESC);
CREATE TABLE thread_links (
 message_id INTEGER PRIMARY KEY REFERENCES messages(id),
 root_id INTEGER NOT NULL REFERENCES messages(id), question INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX thread_root ON thread_links(root_id,message_id);
WITH RECURSIVE roots(id,root) AS (
 SELECT id,id FROM messages WHERE reply_to IS NULL
 UNION ALL SELECT m.id,r.root FROM messages m JOIN roots r ON m.reply_to=r.id
) INSERT INTO thread_links(message_id,root_id) SELECT id,root FROM roots;
CREATE TABLE room_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 agent TEXT NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL,
 recipient TEXT, question INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX room_events_recipient ON room_events(recipient,id);
CREATE TABLE attention (
 id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER NOT NULL UNIQUE REFERENCES room_events(id),
 recipient TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'unread',
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX attention_recipient ON attention(recipient,id);
CREATE TABLE checkins (
 id INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT NOT NULL UNIQUE,
 interval_seconds INTEGER NOT NULL, last_seen INTEGER NOT NULL, next_due INTEGER NOT NULL,
 lease_event INTEGER NOT NULL DEFAULT 0, lease_token TEXT, lease_until INTEGER NOT NULL DEFAULT 0, retry_after INTEGER NOT NULL DEFAULT 0,
 delivered_event INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0
);
CREATE TRIGGER room_records_no_update BEFORE UPDATE ON room_records
BEGIN SELECT RAISE(ABORT,'oneroom: records are versioned'); END;
CREATE TRIGGER room_records_no_delete BEFORE DELETE ON room_records
BEGIN SELECT RAISE(ABORT,'oneroom: records are versioned'); END;
CREATE TRIGGER room_events_no_update BEFORE UPDATE ON room_events
BEGIN SELECT RAISE(ABORT,'oneroom: events are append-only'); END;
CREATE TRIGGER room_events_no_delete BEFORE DELETE ON room_events
BEGIN SELECT RAISE(ABORT,'oneroom: events are append-only'); END;
`];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function migrate(db: Database.Database): void {
  if ((db.pragma("user_version", { simple: true }) as number) > SCHEMA_VERSION) throw new Error("Database schema is newer than this server; use the newer server or a pre-upgrade backup");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("recursive_triggers = ON");
  db.transaction(() => {
    const version = db.pragma("user_version", { simple: true }) as number;
    if (version > SCHEMA_VERSION) throw new Error(`Database schema ${version} is newer than supported schema ${SCHEMA_VERSION}; use the newer server or restore a pre-upgrade backup`);
    for (let i = version; i < MIGRATIONS.length; i++) {
      db.exec(MIGRATIONS[i]);
      db.pragma(`user_version = ${i + 1}`);
    }
  }).immediate();
}
