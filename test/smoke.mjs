// End-to-end smoke test: boots the server against a temp data dir, connects a
// real MCP client over streamable HTTP, and exercises every tool.
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

let PORT;
const clients = [];
const called = new Set();
const KEY = "or_" + "admin".repeat(10);
const AGENT_KEY = "or_" + "agent".repeat(10);
const READER_KEY = "or_" + "read".repeat(10);
const HUMAN_KEY = "or_" + "human".repeat(10);
const dataDir = mkdtempSync(path.join(tmpdir(), "oneroom-smoke-"));

const credentialsFile = path.join(dataDir, "credentials.json");
writeFileSync(credentialsFile, JSON.stringify([
  { id: "admin", role: "admin", token: KEY }, { id: "alice", role: "agent", token: AGENT_KEY },
  { id: "reader", role: "reader", token: READER_KEY }, { id: "reviewer", role: "human", token: HUMAN_KEY },
]), { mode: 0o600 });
const fetchAuth = (url, init = {}, token = KEY) => fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } });
const server = spawn(process.execPath, ["dist/index.js"], {
  env: { ...process.env, ONEROOM_HOST: "127.0.0.1", ONEROOM_PORT: "0", ONEROOM_MAX_DB_MB: "16", ONEROOM_MAX_MESSAGE_KB: "64", ONEROOM_MAX_DOC_KB: "512", ONEROOM_RETENTION_DAYS: "0", ONEROOM_DATA_DIR: dataDir, ONEROOM_KEY: KEY, ONEROOM_CREDENTIALS_FILE: credentialsFile, ONEROOM_RATE_PER_MINUTE: "1000", ONEROOM_PUBLIC_URL: "" },
  stdio: ["ignore", "pipe", "inherit"],
});
server.stdout.on("data", (d) => {
  process.stdout.write(`[server] ${d}`);
  const match = String(d).match(/listening on 127\.0\.0\.1:(\d+)/);
  if (match) PORT = Number(match[1]);
});
const exited = once(server, "exit");

const cleanup = async (code) => {
  await Promise.all(clients.map(client => client.close()));
  server.kill("SIGTERM");
  const [exitCode] = await exited;
  rmSync(dataDir, { recursive: true, force: true });
  process.exitCode = code || (exitCode !== 0 ? 1 : 0);
};

try {
  // Wait for the server to come up.
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (server.exitCode !== null) break;
    if (!PORT) continue;
    up = await fetch(`http://127.0.0.1:${PORT}/healthz`).then((r) => r.ok).catch(() => false);
  }
  assert.ok(up, "server did not start");

  // Auth is enforced.
  const unauthed = await fetch(`http://127.0.0.1:${PORT}/export`);
  assert.equal(unauthed.status, 401, "expected 401 without key");

  const call = async (client, name, args) => {
    called.add(name);
    const res = await client.callTool({ name, arguments: (["post_message", "annotate", "store_document", "check_in"].includes(name) || name.startsWith("update_")) ? { request_id: randomUUID(), ...args } : args });
    assert.ok(!res.isError, `${name} errored: ${res.content?.[0]?.text}`);
    return JSON.parse(res.content[0].text);
  };

  const connect = async (token = KEY) => {
    const client = new Client({ name: "smoke", version: "0.0.1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      })
    );
    clients.push(client);
    return client;
  };

  // Two "agents" share the room, as in real use.
  const alice = await connect(AGENT_KEY);
  const bob = await connect();

  const tools = await alice.listTools();
  assert.equal(tools.tools.length, 27, "expected 27 tools");

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
  assert.equal(catchup.read_first.items.length, 1, "expected one read-first message");
  assert.equal(catchup.read_first.items[0].message_id, m2.id);
  assert.equal(catchup.recent_messages.items.length, 2);
  assert.equal((await call(alice, "read_messages", { after_id: 0 })).items.length, 2);
  assert.equal((await call(alice, "list_pins", {})).items.length, 1);
  assert.match((await call(alice, "get_message", { message_id: 1 })).content, /Starting work/);
  assert.match((await call(alice, "get_annotation", { annotation_id: catchup.read_first.items[0].id })).content, /avoid legacy/);

  // resolved clears the read-first pin
  await call(alice, "annotate", { agent: "alice", flag: "resolved", message_id: m2.id });
  const catchup2 = await call(alice, "catch_up", { agent: "alice" });
  assert.equal(catchup2.read_first.items.length, 0, "resolved should clear read-first");

  // documents: versioning
  await call(alice, "store_document", { agent: "alice", name: "plan.md", content: "# Plan v1\nUse JWT." });
  const v2 = await call(alice, "store_document", { agent: "alice", name: "plan.md", content: "# Plan v2\nUse PASETO." });
  assert.equal(v2.version, 2);
  assert.equal((await call(alice, "list_documents", {})).items.length, 1);
  const doc = await call(bob, "get_document", { name: "plan.md" });
  assert.match(doc.content, /PASETO/);
  const docV1 = await call(bob, "get_document", { name: "plan.md", version: 1 });
  assert.match(docV1.content, /JWT/);

  // search across messages and documents
  const found = await call(bob, "search", { query: "deadlock" });
  assert.equal(found.items.length, 1);
  const foundDocs = await call(bob, "search", { query: "PASETO", scope: "documents" });
  assert.equal(foundDocs.items.length, 1);

  // status and limits surface
  const status = await call(alice, "status", {});
  assert.equal(status.messages, 2);
  assert.equal(status.documents, 2);

  // message size limit enforced
  const big = await alice.callTool({
    name: "post_message",
    arguments: { request_id: randomUUID(), agent: "alice", content: "x".repeat(70 * 1024) },
  });
  assert.ok(big.isError, "oversized message should be rejected");

  // Idempotency is bound to the authenticated identity, across independent clients.
  const requestId = randomUUID();
  const original = await call(alice, "post_message", { request_id: requestId, agent: "impersonated", content: "safe retry" });
  const retryClient = await connect(AGENT_KEY);
  const replay = await call(retryClient, "post_message", { request_id: requestId, content: "safe retry" });
  assert.deepEqual(replay, original);
  assert.equal(original.agent, "alice");
  const conflict = await retryClient.callTool({ name: "post_message", arguments: { request_id: requestId, content: "different" } });
  assert.ok(conflict.isError);
  const reader = await connect(READER_KEY);
  const denied = await reader.callTool({ name: "post_message", arguments: { request_id: randomUUID(), content: "denied" } });
  assert.ok(denied.isError);
  const human = await connect(HUMAN_KEY);
  assert.ok((await human.callTool({ name: "store_document", arguments: { request_id: randomUUID(), name: "denied", content: "denied" } })).isError);
  assert.equal((await fetchAuth(`http://127.0.0.1:${PORT}/export`, {}, AGENT_KEY)).status, 403);
  assert.equal((await fetchAuth(`http://127.0.0.1:${PORT}/metrics`, {}, READER_KEY)).status, 403);
  const metrics = await fetchAuth(`http://127.0.0.1:${PORT}/metrics`).then(r => r.json());
  assert.ok(metrics.requests > 0);
  assert.ok(metrics.tool_errors > 0);
  assert.equal(metrics.schema_version, 3);

  const base = `http://127.0.0.1:${PORT}`;
  const legacy = await fetch(`${base}/?key=${KEY}`, { redirect: "manual" });
  assert.equal(legacy.status, 303);
  assert.equal(legacy.headers.get("location"), "/login");
  const loginPage = await fetch(`${base}/login`);
  const loginHtml = await loginPage.text();
  const loginCsrf = loginHtml.match(/name="csrf" value="([^"]+)"/)[1];
  const preCookie = loginPage.headers.get("set-cookie").split(";")[0];
  const login = await fetch(`${base}/login`, { method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: base, Cookie: preCookie },
    body: new URLSearchParams({ token: HUMAN_KEY, csrf: loginCsrf }),
  });
  assert.equal(login.status, 303);
  const sessionHeader = login.headers.getSetCookie().find(v => v.startsWith("oneroom="));
  assert.match(sessionHeader, /HttpOnly/i); assert.match(sessionHeader, /SameSite=Strict/i);
  const sessionCookie = sessionHeader.split(";")[0];
  const browser = (url, init = {}) => fetch(url, { ...init, headers: { Cookie: sessionCookie, ...init.headers } });
  const html = await browser(`${base}/`).then(r => r.text());
  assert.match(html, /Starting work on the auth module/);
  assert.doesNotMatch(html, new RegExp(KEY));
  assert.doesNotMatch(html, /\?key=/);
  const csrf = html.match(/name="csrf" value="([^"]+)"/)[1];
  const form = { csrf, request_id: randomUUID(), flag: "note", message_id: "1", note: "reviewed" };
  const sendForm = (fields, origin = base) => browser(`${base}/annotate`, { method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: origin }, body: new URLSearchParams(fields) });
  assert.equal((await sendForm({ ...form, csrf: "wrong" })).status, 403);
  assert.equal((await sendForm(form, "https://attacker.example")).status, 403);
  assert.equal((await sendForm(form)).status, 303);
  assert.equal((await sendForm(form)).status, 303);
  assert.equal((await browser(`${base}/mcp`, { method: "POST" })).status, 401, "MCP rejects cookie authentication");
  const annotations = await call(bob, "list_annotations", { message_id: 1 });
  assert.equal(annotations.items.filter(a => a.agent === "reviewer").length, 1);
  const exported = await browser(`${base}/export`).then(r => r.json());
  assert.equal(exported.messages.length, 3);

  await call(alice, "store_document", { name: "unsafe.html", content: "<script>alert(1)</script>", mime: "text/html" });
  const unsafe = await browser(`${base}/doc/unsafe.html`);
  assert.equal(unsafe.headers.get("referrer-policy"), "same-origin");
  assert.equal(unsafe.headers.get("cache-control"), "no-store");
  assert.equal(unsafe.headers.get("x-content-type-options"), "nosniff");
  assert.match(unsafe.headers.get("content-security-policy"), /default-src 'none'/);
  const unsafeHtml = await unsafe.text();
  assert.match(unsafeHtml, /&lt;script&gt;/);
  assert.doesNotMatch(unsafeHtml, /<script>/);
  const textDoc = await browser(`${base}/doc/unsafe.html?format=text`);
  assert.match(textDoc.headers.get("content-type"), /^text\/plain/);
  assert.equal(await textDoc.text(), "<script>alert(1)</script>");
  const oldDoc = await browser(`${base}/doc/plan.md?version=1&format=text`).then(r => r.text());
  assert.match(oldDoc, /JWT/);
  const malformed = await fetchAuth(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: "invalid request" });
  const noKeyMalformed = await fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" });
  assert.equal(noKeyMalformed.status, 401);
  const older = await browser(`${base}/?before_id=2`).then(r => r.text());
  assert.match(older, /Starting work on the auth module/); assert.doesNotMatch(older, /Acknowledged/);
  assert.equal((await browser(`${base}/?before_id=wat`)).status, 400);
  const logout = await browser(`${base}/logout`, { method: "POST", redirect: "manual", headers: { Origin: base, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf }) });
  assert.equal(logout.status, 303);
  assert.equal((await browser(`${base}/export`)).status, 401);

  const agents=await call(alice,"list_agents",{});assert.ok(agents.items.some(a=>a.id==="reviewer"));
  assert.equal((await call(alice,"read_thread",{message_id:m2.id})).root_id,m1.id);
  const inbox=await call(alice,"read_inbox",{});assert.equal(inbox.items.length,1);
  await call(alice,"update_attention",{attention_id:inbox.items[0].id,state:"answered"});
  await call(alice,"update_status",{key:"alice",expected_version:0,data:{summary:"Building boards",state:"working",detail:"Progress"}});
  const statusRecord=await call(alice,"get_record",{kind:"status",key:"alice"});assert.equal(JSON.parse(statusRecord.content).summary,"Building boards");
  assert.equal((await call(alice,"list_records",{kind:"status"})).items.length,1);
  await call(alice,"update_work",{key:"boards",expected_version:0,data:{title:"Build boards",state:"working",lease_until:Date.now()+60000}});
  await call(alice,"update_test",{key:"smoke",expected_version:0,data:{repo:"org/repo",commit:"a".repeat(40),suite:"smoke",command:"npm test",state:"passed",started_at:new Date().toISOString(),summary:"Passed"}});
  await call(alice,"update_log",{key:"smoke-output",expected_version:0,data:{level:"info",summary:"Test output",output:"All passed"}});
  called.add("update_pr_note");
  assert.ok((await alice.callTool({name:"update_pr_note",arguments:{request_id:randomUUID(),key:"org/repo#1",expected_version:0,data:{summary:"No provider PR yet"}}})).isError);
  await call(alice,"check_in",{interval_seconds:300});
  assert.equal((await call(alice,"list_checkins",{})).items[0].agent,"alice");
  assert.ok((await call(alice,"read_events",{})).items.length>0);
  for(const view of ["status","work","pr","test","log","inbox","events","checkins","thread"]) {
    const response=await fetchAuth(`${base}/boards?view=${view}&message_id=1`);
    assert.equal(response.status,200,view);assert.ok((await response.text()).length<262144);
  }
  assert.equal((await fetchAuth(`${base}/record/status/alice`)).status,200);
  assert.deepEqual([...called].sort(), tools.tools.map(t => t.name).sort(), "every tool was exercised");
  console.log("\nSMOKE OK — all assertions passed");
  await cleanup(0);
} catch (e) {
  console.error("\nSMOKE FAILED:", e);
  await cleanup(1);
}
