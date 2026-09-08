import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, statSync, readFileSync, readdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { Auth, allowed } from '../dist/auth.js';
import { RateLimiter } from '../dist/operations.js';
import { Room } from '../dist/db.js';
import { loadConfig } from '../dist/config.js';

function fixture(t, overrides = {}, sql) {
  const dir = mkdtempSync(path.join(tmpdir(), 'oneroom-regression-'));
  const cfg = { port: 0, host: '127.0.0.1', dataDir: dir, dbPath: path.join(dir, 'oneroom.db'), key: 'test', keyFile: '', keyGenerated: false,
    maxDbBytes: 1024 * 1024, maxMessageBytes: 64 * 1024, maxDocBytes: 512 * 1024, retentionDays: 0, ...overrides };
  if (sql) { const db = new Database(cfg.dbPath); db.exec(sql); db.close(); }
  const room = new Room(cfg);
  t.after(() => { room.close(); rmSync(dir, { recursive: true, force: true }); });
  return { room, cfg };
}

test('polling drains every unread message across multiple pages', t => {
  const { room } = fixture(t);
  for (let i = 1; i <= 12; i++) room.postMessage('agent', `message ${i}`);
  let cursor = 0;
  const seen = [];
  while (true) {
    const page = room.readMessages({ afterId: cursor, limit: 5 });
    if (!page.length) break;
    seen.push(...page.map(m => m.id));
    cursor = page.at(-1).id;
  }
  assert.deepEqual(seen, Array.from({ length: 12 }, (_, i) => i + 1));
  assert.deepEqual(room.readMessages({ limit: 3 }).map(m => m.id), [10, 11, 12]);
  assert.deepEqual(room.readMessages({ beforeId: 10, limit: 3 }).map(m => m.id), [7, 8, 9]);
});

test('document search matches latest content and reports UTF-8 bytes', t => {
  const { room } = fixture(t);
  room.storeDocument('agent', 'plan', 'obsoleteword');
  room.storeDocument('agent', 'plan', 'currentword 🎉 café');
  assert.equal(room.search({ query: 'obsoleteword', scope: 'documents' }).documents.length, 0);
  assert.equal(room.search({ query: 'currentword' }).documents[0].version, 2);
  assert.equal(room.getDocument('plan', 1).content, 'obsoleteword');
  assert.equal(room.listDocuments()[0].bytes, Buffer.byteLength('currentword 🎉 café'));
});

test('capacity includes FTS and page overhead, rejecting writes atomically', t => {
  const { room, cfg } = fixture(t, { maxDbBytes: 320 * 1024 });
  const body = Array.from({ length: 2500 }, (_, i) => `word${i}`).join(' ');
  let accepted = 0;
  for (let i = 0; i < 30; i++) {
    try { room.storeDocument('agent', 'big', body); accepted++; }
    catch (e) { assert.match(e.message, /database size limit reached/); break; }
  }
  assert.ok(accepted > 0 && accepted < 30);
  assert.ok(room.dbSizeBytes() <= cfg.maxDbBytes);
  assert.equal(room.status().documents, accepted);
  assert.equal(room.getDocument('big').meta.version, accepted);
  assert.equal(room.getDocument('big', accepted + 1), null);
  const db = new Database(cfg.dbPath);
  try { assert.equal(db.pragma('integrity_check', { simple: true }), 'ok'); }
  finally { db.close(); }
});

test('domain rejects invalid human annotations and oversized notes', t => {
  const { room } = fixture(t, { maxMessageBytes: 8 });
  const message = room.postMessage('agent', 'hello');
  room.storeDocument('agent', 'plan', 'content');
  const base = { agent: 'human', flag: 'note', messageId: message.id };
  for (const fields of [{ agent: [] }, { agent: 'x'.repeat(65) }, { flag: 'other' }, { note: '🎉'.repeat(3) }, { messageId: 1.5 }, { documentName: 'plan' }]) {
    assert.throws(() => room.annotate({ ...base, ...fields }));
  }
  assert.equal(room.status().annotations, 0);
});

test('append-only tables and exact annotation target survive existing schema', t => {
  const { room, cfg } = fixture(t);
  room.postMessage('agent', 'first');
  const db = new Database(cfg.dbPath);
  try {
    assert.throws(() => db.prepare("UPDATE messages SET content='changed' WHERE id=1").run(), /append-only/);
    assert.throws(() => db.prepare('DELETE FROM messages WHERE id=1').run(), /append-only/);
    assert.throws(() => db.prepare("INSERT INTO annotations(agent,message_id,document_name,flag) VALUES ('a',1,'plan','note')").run(), /exactly one target/);
  } finally { db.close(); }
});

test('retention hides old messages but keeps pins and exports', t => {
  const { room, cfg } = fixture(t, { retentionDays: 1 });
  const db = new Database(cfg.dbPath);
  db.prepare("INSERT INTO messages(ts,agent,content) VALUES ('2000-01-01T00:00:00.000Z','agent','ancientword')").run();
  db.close();
  room.annotate({ agent: 'agent', flag: 'read-first', messageId: 1 });
  assert.equal(room.readMessages({}).length, 0);
  assert.equal(room.search({ query: 'ancientword' }).messages.length, 0);
  assert.equal(room.readMessages({ includeArchived: true }).length, 1);
  assert.equal(room.readFirstMessages().length, 1);
  assert.equal(JSON.parse([...room.exportChunks()].join('')).messages.length, 1);
  room.annotate({ agent: 'agent', flag: 'resolved', messageId: 1 });
  assert.equal(room.readFirstMessages().length, 0);
  room.annotate({ agent: 'agent', flag: 'read-first', messageId: 1 });
  assert.equal(room.readFirstMessages().length, 1);
});

test('streamed exports use one snapshot and include every document version', t => {
  const { room } = fixture(t);
  room.postMessage('agent', 'before');
  room.storeDocument('agent', 'plan', 'v1');
  room.storeDocument('agent', 'plan', 'v2');
  const stream = room.exportChunks();
  const first = stream.next().value;
  room.postMessage('agent', 'after');
  room.storeDocument('agent', 'plan', 'v3');
  const result = JSON.parse(first + [...stream].join(''));
  assert.equal(result.messages.length, 1);
  assert.equal(result.documents.length, 2);
  assert.equal(result.status.documents, 2);
});

test('config rejects malformed limits and empty credentials, persists generated keys', t => {
  const oldEnv = { ...process.env };
  const dir = mkdtempSync(path.join(tmpdir(), 'oneroom-config-'));
  t.after(() => { process.env = oldEnv; rmSync(dir, { recursive: true, force: true }); });
  for (const name of Object.keys(process.env)) if (name.startsWith('ONEROOM_')) delete process.env[name];
  process.env.ONEROOM_DATA_DIR = dir;
  for (const value of ['0', '-1', '1oops', '1.5', '', '9007199254740992']) {
    process.env.ONEROOM_MAX_DB_MB = value;
    assert.throws(loadConfig, /ONEROOM_MAX_DB_MB/);
  }
  delete process.env.ONEROOM_MAX_DB_MB;
  process.env.ONEROOM_PORT = '65536';
  assert.throws(loadConfig, /ONEROOM_PORT/);
  process.env.ONEROOM_PORT = '0';
  process.env.ONEROOM_KEY = ' ';
  assert.throws(loadConfig, /ONEROOM_KEY/);
  delete process.env.ONEROOM_KEY;
  const cfg = loadConfig();
  assert.equal(cfg.host, '127.0.0.1');
  assert.equal(statSync(cfg.keyFile).mode & 0o777, 0o600);
  assert.equal(loadConfig().key, cfg.key);
  writeFileSync(cfg.keyFile, '\n');
  assert.throws(loadConfig, /Access key must be nonempty/);
});

test('lowering a cap keeps existing history readable and rejects new writes', t => {
  const { room, cfg } = fixture(t);
  room.postMessage('agent', 'preserved');
  const smaller = new Room({ ...cfg, maxDbBytes: 4096 });
  try {
    assert.equal(smaller.readMessages({})[0].content, 'preserved');
    assert.throws(() => smaller.postMessage('agent', 'new'), /database size limit reached/);
    assert.equal(JSON.parse([...smaller.exportChunks()].join('')).messages.length, 1);
  } finally { smaller.close(); }
});

test('SQLite online backup restores messages, annotations, versions and FTS', async t => {
  const { room, cfg } = fixture(t);
  room.postMessage('agent', 'recoverableword');
  room.annotate({ agent: 'agent', messageId: 1, flag: 'read-first' });
  room.storeDocument('agent', 'plan', 'old');
  room.storeDocument('agent', 'plan', 'new');
  const backupPath = path.join(cfg.dataDir, 'backup.db');
  const source = new Database(cfg.dbPath, { readonly: true });
  try { await source.backup(backupPath); } finally { source.close(); }
  const restored = new Room({ ...cfg, dbPath: backupPath });
  try {
    assert.equal(restored.readMessages({})[0].content, 'recoverableword');
    assert.equal(restored.readFirstMessages().length, 1);
    assert.equal(restored.getDocument('plan', 1).content, 'old');
    assert.equal(restored.getDocument('plan').meta.version, 2);
    assert.equal(restored.search({ query: 'recoverableword' }).messages.length, 1);
  } finally { restored.close(); }
});

test('version-zero migration preserves history and legacy pins; new flags target exact versions', t => {
  const { room, cfg } = fixture(t, {}, readFileSync(new URL('./fixtures/v0.1.sql', import.meta.url), 'utf8'));
  assert.equal(room.operationalStatus().schema_version, 3);
  assert.equal(room.readMessages({})[0].content, 'legacy history');
  assert.equal(room.reads.pins().items[0].document_version, null);
  room.annotate({ agent: 'human', flag: 'resolved', documentName: 'plan', documentVersion: 0 });
  assert.equal(room.reads.pins().items.length, 0);
  room.annotate({ agent: 'human', flag: 'read-first', documentName: 'plan' });
  room.storeDocument('agent', 'plan', 'new plan');
  assert.equal(room.reads.documents().items[0].annotations.items.length, 2, 'only legacy name-wide annotations carry forward');
  assert.equal(room.reads.pins().items[0].document_version, 1, 'pin still points to original immutable content');
  room.annotate({ agent: 'human', flag: 'resolved', documentName: 'plan' });
  assert.equal(room.reads.pins().items.length, 1, 'resolving v2 cannot clear a v1 pin');
  room.annotate({ agent: 'human', flag: 'resolved', documentName: 'plan', documentVersion: 1 });
  assert.equal(room.reads.pins().items.length, 0);
  const again = new Room(cfg);
  try { assert.equal(again.getDocument('plan', 1).content, 'old plan'); } finally { again.close(); }
});

test('newer schemas are refused; failed upgrades roll back their version', t => {
  const { cfg } = fixture(t);
  const db = new Database(cfg.dbPath);
  try {
    db.pragma('user_version = 99');
    assert.throws(() => new Room(cfg), /newer/);
    assert.equal(db.pragma('user_version', { simple: true }), 99);
    db.pragma('user_version = 1');
    assert.throws(() => new Room(cfg), /duplicate column/);
    assert.equal(db.pragma('user_version', { simple: true }), 1);
  } finally { db.close(); }
});

test('durable idempotency handles replay, payload conflicts, different identities and rollback', t => {
  const { room, cfg } = fixture(t);
  const write = () => room.postMessage('a', 'one');
  const initial = room.idempotent('a', 'request-1', 'post', { content: 'one' }, write);
  const second = new Room(cfg);
  try {
    assert.deepEqual(second.idempotent('a', 'request-1', 'post', { content: 'one' }, () => assert.fail('replay executed')), initial);
    assert.throws(() => second.idempotent('a', 'request-1', 'post', { content: 'two' }, write), /different operation or payload/);
    second.idempotent('b', 'request-1', 'post', { content: 'one' }, () => second.postMessage('b', 'one'));
    assert.equal(second.status().messages, 2);
    assert.throws(() => second.idempotent('a', 'retry-failed', 'post', {}, () => { second.postMessage('a', 'rolled back'); throw new Error('simulate failure'); }), /simulate failure/);
    assert.equal(second.status().messages, 2);
    second.idempotent('a', 'retry-failed', 'post', {}, () => second.postMessage('a', 'retry worked'));
    assert.equal(second.status().messages, 3);
  } finally { second.close(); }
  const capped = new Room({ ...cfg, maxDbBytes: 4096 });
  try { assert.deepEqual(capped.idempotent('a', 'request-1', 'post', { content: 'one' }, write), initial); }
  finally { capped.close(); }
});

test('every paginated read drains completely within byte budgets, including full Unicode content', t => {
  const { room } = fixture(t, { maxDbBytes: 8 * 1024 * 1024, maxResponseBytes: 64 * 1024 });
  const text = '\u0000\u0001🎉 café'.repeat(1800);
  for (let i = 0; i < 45; i++) {
    const message = room.postMessage('agent', `searchable ${i} ` + '\u0001'.repeat(1500));
    room.annotate({ agent: 'agent', flag: 'read-first', messageId: message.id, note: '\u0001'.repeat(600) });
    room.storeDocument('agent', `doc-${String(i).padStart(3, '0')}`, 'searchable');
  }
  room.storeDocument('agent', 'unicode', text);
  const drain = (getPage) => {
    let cursor; const items = [];
    do {
      const page = getPage(cursor);
      assert.ok(Buffer.byteLength(JSON.stringify(page)) < 64 * 1024);
      items.push(...page.items);
      if (!page.has_more) return items;
      assert.notEqual(page.next_cursor, cursor);
      cursor = page.next_cursor;
    } while (items.length < 1000);
    assert.fail('cursor failed to advance');
  };
  assert.equal(drain(cursor => room.reads.messages({ after_id: cursor ?? 0 })).length, 45);
  assert.equal(drain(cursor => room.reads.pins({ after_id: cursor })).length, 45);
  assert.equal(drain(cursor => room.reads.documents({ after_name: cursor })).length, 46);
  assert.equal(drain(cursor => room.reads.annotations({ after_id: cursor })).length, 45);
  assert.equal(drain(cursor => room.reads.search({ query: 'searchable', after_id: cursor })).length, 45);
  assert.equal(drain(cursor => room.reads.search({ query: 'searchable', scope: 'documents', after_id: cursor })).length, 45);
  let offset = 0; let combined = '';
  do {
    const chunk = room.reads.content('documents', 'unicode', offset, 1);
    combined += chunk.content; offset = chunk.next_offset;
  } while (offset !== null);
  assert.equal(combined, text);
  assert.throws(() => room.reads.content('documents', 'unicode', 3, 1), /UTF-8/);
});

test('named credentials enforce roles, expiry, revocation on restart and secure file permissions', t => {
  const { cfg } = fixture(t);
  cfg.credentialsFile = path.join(cfg.dataDir, 'credentials.json');
  const token = 'a'.repeat(40); const agentToken = 'b'.repeat(40);
  writeFileSync(cfg.credentialsFile, JSON.stringify([{ id: 'owner', role: 'admin', token }, { id: 'agent', role: 'agent', token: agentToken }]), { mode: 0o600 });
  const auth = new Auth(cfg);
  const owner = auth.authenticate(token);
  assert.equal(owner.id, 'owner');
  assert.equal(auth.authenticate(cfg.key), null, 'bootstrap key disabled in named mode');
  assert.ok(!allowed(auth.authenticate(agentToken), 'export'));
  assert.throws(() => auth.login(auth.authenticate(agentToken)), /Agent credentials/);
  const login = auth.login(owner);
  assert.equal(auth.session(login.token).principal.id, 'owner');
  auth.logout(login.token); assert.equal(auth.session(login.token), null);
  const expired = auth.login(owner); expired.session.expires = Date.now() - 1;
  assert.equal(auth.session(expired.token), null);
  const active = auth.login(owner);
  assert.equal(new Auth(cfg).session(active.token), null);
  chmodSync(cfg.credentialsFile, 0o644);
  assert.throws(() => new Auth(cfg), /0600/);
});

test('rate limits stay bounded and cannot be bypassed by evicting identities', () => {
  const limiter = new RateLimiter(2, 2);
  assert.ok(limiter.take('a', 1)); assert.ok(limiter.take('a', 1)); assert.ok(!limiter.take('a', 1));
  assert.ok(limiter.take('b', 1)); assert.ok(!limiter.take('c', 1)); assert.ok(!limiter.take('a', 2));
  assert.ok(limiter.take('c', 60002)); assert.ok(limiter.take('a', 60002));
});

test('credential CLI and backup/restore CLI operate on isolated data and reject overwrites', t => {
  const { room, cfg } = fixture(t);
  room.idempotent('admin', 'saved-request', 'post', {}, () => room.postMessage('admin', 'backup content'));
  const env = { ...process.env, ONEROOM_DATA_DIR: cfg.dataDir, ONEROOM_KEY: 'x'.repeat(40), ONEROOM_CREDENTIALS_FILE: '' };
  const run = (script, ...args) => execFileSync(process.execPath, [`dist/${script}.js`, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  run('credentials', 'add', 'alice', 'agent');
  assert.match(run('credentials', 'list'), /alice/);
  assert.doesNotMatch(run('credentials', 'list'), /token/);
  run('credentials', 'rotate', 'alice');
  run('credentials', 'remove', 'alice');
  assert.throws(() => run('credentials', 'remove', 'admin'));
  const backups = path.join(cfg.dataDir, 'backups');
  run('backup', 'create', backups);
  const file = path.join(backups, readdirSync(backups).find(n => n.endsWith('.db')));
  assert.match(run('backup', 'verify', file), /verified/);
  const target = path.join(cfg.dataDir, 'restored');
  run('backup', 'restore', file, target);
  assert.throws(() => run('backup', 'restore', file, target));
  const restored = new Room({ ...cfg, dbPath: path.join(target, 'oneroom.db') });
  try { assert.equal(restored.idempotent('admin', 'saved-request', 'post', {}, () => assert.fail('replayed write')).content, 'backup content'); }
  finally { restored.close(); }
  writeFileSync(file + '.json', JSON.stringify({ sha256: 'wrong' }));
  assert.throws(() => run('backup', 'verify', file));
});

test('an oversized idempotency record rolls back both the write and ledger entry', t => {
  const { room } = fixture(t, { maxDbBytes: 192 * 1024 });
  assert.throws(() => room.idempotent('a', 'full-ledger', 'post', {}, () => {
    room.postMessage('a', 'must roll back');
    return { huge: 'x'.repeat(300 * 1024) };
  }), /database size limit reached/);
  assert.equal(room.status().messages, 0);
  room.idempotent('a', 'full-ledger', 'post', {}, () => room.postMessage('a', 'retry after rollback'));
  assert.equal(room.status().messages, 1);
});
