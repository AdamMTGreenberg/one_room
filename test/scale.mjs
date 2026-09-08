// Bounded-memory workload covering long annotation histories and many pins/docs.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Room } from '../dist/db.js';
import { renderHome } from '../dist/ui.js';

const dir = mkdtempSync(path.join(tmpdir(), 'oneroom-scale-'));
const cfg = { dataDir: dir, dbPath: path.join(dir, 'oneroom.db'), maxDbBytes: 128 * 1024 * 1024,
  maxMessageBytes: 65536, maxDocBytes: 524288, maxResponseBytes: 65536, retentionDays: 0 };
const room = new Room(cfg);
const writer = new Database(cfg.dbPath);
try {
  writer.transaction(() => {
    const message = writer.prepare('INSERT INTO messages(agent,content) VALUES (?,?)');
    const annotation = writer.prepare('INSERT INTO annotations(agent,message_id,flag,note) VALUES (?,?,?,?)');
    const document = writer.prepare('INSERT INTO documents(agent,name,version,content) VALUES (?,?,1,?)');
    for (let i = 1; i <= 1000; i++) {
      message.run('scale-agent', `searchable ${i} ` + 'm'.repeat(4096));
      annotation.run('scale-agent', i, 'read-first', 'n'.repeat(2048));
      annotation.run('scale-agent', 1, 'note', 'long history '.repeat(300));
    }
    for (let i = 0; i < 500; i++) document.run('scale-agent', `doc-${String(i).padStart(4, '0')}`, 'document '.repeat(3600));
  })();
  writer.close();
  const start = performance.now();
  const rssBefore = process.memoryUsage().rss;
  function drain(get) {
    let cursor; let count = 0;
    do {
      const page = get(cursor);
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= cfg.maxResponseBytes);
      count += page.items.length;
      if (!page.has_more) return count;
      assert.notEqual(page.next_cursor, cursor); cursor = page.next_cursor;
    } while (count <= 10000);
    assert.fail('nonterminating pagination');
  }
  assert.equal(drain(after_id => room.reads.pins({ after_id })), 1000);
  assert.equal(drain(after_id => room.reads.messages({ after_id: after_id ?? 0 })), 1000);
  assert.equal(drain(after_name => room.reads.documents({ after_name })), 500);
  assert.equal(drain(after_id => room.reads.annotations({ after_id })), 2000);
  assert.equal(drain(after_id => room.reads.search({ query: 'searchable', after_id })), 1000);
  let exportBytes = 0;
  for (const chunk of room.exportChunks()) exportBytes += Buffer.byteLength(chunk);
  assert.ok(exportBytes > 20 * 1024 * 1024);
  for (const view of ['messages', 'pins', 'documents', 'annotations']) {
    const html = renderHome(room, { id: 'admin', role: 'admin' }, 'test-csrf', { view });
    assert.ok(Buffer.byteLength(html) < cfg.maxResponseBytes, view);
    assert.match(html, /Next page/);
  }
  assert.ok(process.memoryUsage().rss - rssBefore < 128 * 1024 * 1024, 'unbounded memory growth');
  console.log(JSON.stringify({ result: 'SCALE OK', messages: 1000, annotations: 2000, documents: 500,
    response_budget_bytes: cfg.maxResponseBytes, export_bytes: exportBytes, elapsed_ms: Math.round(performance.now() - start), rss_bytes: process.memoryUsage().rss }));
} finally {
  if (writer.open) writer.close(); room.close(); rmSync(dir, { recursive: true, force: true });
}
