
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

INSERT INTO messages(agent, content) VALUES ('legacy-agent','legacy history');
INSERT INTO documents(agent,name,version,content) VALUES ('legacy-agent','plan',1,'old plan');
INSERT INTO annotations(agent,document_name,flag,note) VALUES ('human','plan','read-first','legacy pin');
