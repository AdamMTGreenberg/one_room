// End-to-end smoke test: boots the server against a temp data dir, connects a
// real MCP client over streamable HTTP, and exercises every tool.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PORT = 7901;
const KEY = "or_smoke_test_key";
const dataDir = mkdtempSync(path.join(tmpdir(), "oneroom-smoke-"));

const server = spawn("node", ["dist/index.js"], {
  env: { ...process.env, ONEROOM_PORT: String(PORT), ONEROOM_DATA_DIR: dataDir, ONEROOM_KEY: KEY },
  stdio: ["ignore", "pipe", "inherit"],
});
server.stdout.on("data", (d) => process.stdout.write(`[server] ${d}`));

const cleanup = (code) => {
  server.kill();
  rmSync(dataDir, { recursive: true, force: true });
  process.exit(code);
};

try {
  // Wait for the server to come up.
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    await new Promise((r) => setTimeout(r, 100));
    up = await fetch(`http://localhost:${PORT}/healthz`).then((r) => r.ok).catch(() => false);
  }
  assert.ok(up, "server did not start");

  // Auth is enforced.
  const unauthed = await fetch(`http://localhost:${PORT}/export`);
  assert.equal(unauthed.status, 401, "expected 401 without key");

  const call = async (client, name, args) => {
    const res = await client.callTool({ name, arguments: args });
    assert.ok(!res.isError, `${name} errored: ${res.content?.[0]?.text}`);
    return JSON.parse(res.content[0].text);
  };

  const connect = async () => {
    const client = new Client({ name: "smoke", version: "0.0.1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${KEY}` } },
      })
    );
    return client;
  };

  // Two "agents" share the room, as in real use.
  const alice = await connect();
  const bob = await connect();

  const tools = await alice.listTools();
  assert.equal(tools.tools.length, 9, "expected 9 tools");

  const m1 = await call(alice, "post_message", {
    agent: "alice",
    content: "Starting work on the auth module. Do not touch src/auth/.",
  });
  assert.equal(m1.id, 1);

  const m2 = await call(bob, "post_message", {
    agent: "bob",
    content: "Acknowledged. I tried the legacy session store and it FAILED with a deadlock.",
    reply_to: m1.id,
  });
  assert.equal(m2.reply_to, 1);

  await call(bob, "annotate", { agent: "bob", flag: "failed", message_id: m2.id, note: "deadlock in legacy store" });
  await call(bob, "annotate", { agent: "bob", flag: "read-first", message_id: m2.id, note: "avoid legacy session store" });

  const catchup = await call(alice, "catch_up", { agent: "alice" });
  assert.equal(catchup.read_first.length, 1, "expected one read-first message");
  assert.equal(catchup.read_first[0].id, m2.id);
  assert.equal(catchup.recent_messages.length, 2);

  // resolved clears the read-first pin
  await call(alice, "annotate", { agent: "alice", flag: "resolved", message_id: m2.id });
  const catchup2 = await call(alice, "catch_up", { agent: "alice" });
  assert.equal(catchup2.read_first.length, 0, "resolved should clear read-first");

  // documents: versioning
  await call(alice, "store_document", { agent: "alice", name: "plan.md", content: "# Plan v1\nUse JWT." });
  const v2 = await call(alice, "store_document", { agent: "alice", name: "plan.md", content: "# Plan v2\nUse PASETO." });
  assert.equal(v2.version, 2);
  const doc = await call(bob, "get_document", { name: "plan.md" });
  assert.match(doc.content, /PASETO/);
  const docV1 = await call(bob, "get_document", { name: "plan.md", version: 1 });
  assert.match(docV1.content, /JWT/);

  // search across messages and documents
  const found = await call(bob, "search", { query: "deadlock" });
  assert.equal(found.messages.length, 1);
  const foundDocs = await call(bob, "search", { query: "PASETO", scope: "documents" });
  assert.equal(foundDocs.documents.length, 1);

  // status and limits surface
  const status = await call(alice, "status", {});
  assert.equal(status.messages, 2);
  assert.equal(status.documents, 2);

  // message size limit enforced
  const big = await alice.callTool({
    name: "post_message",
    arguments: { agent: "alice", content: "x".repeat(70 * 1024) },
  });
  assert.ok(big.isError, "oversized message should be rejected");

  // human endpoints
  const html = await fetch(`http://localhost:${PORT}/?key=${KEY}`).then((r) => r.text());
  assert.match(html, /Starting work on the auth module/);
  const exported = await fetch(`http://localhost:${PORT}/export?key=${KEY}`).then((r) => r.json());
  assert.equal(exported.messages.length, 2);

  console.log("\nSMOKE OK — all assertions passed");
  cleanup(0);
} catch (e) {
  console.error("\nSMOKE FAILED:", e);
  cleanup(1);
}
