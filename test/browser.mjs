// Isolated test-only TLS proxy; generate and delete its key with the temporary fixture.
import { chromium } from "playwright";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import https from "node:https";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { Room } from "../dist/db.js";

const dir = mkdtempSync(path.join(tmpdir(), "oneroom-browser-"));
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    path.join(dir, "key.pem"),
    "-out",
    path.join(dir, "cert.pem"),
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
  ],
  { stdio: "ignore" },
);
const adminToken = "admin-".repeat(10);
const humanToken = "human-".repeat(10);
writeFileSync(
  path.join(dir, "credentials.json"),
  JSON.stringify([
    { id: "admin", role: "admin", token: adminToken },
    { id: "reviewer", role: "human", token: humanToken },
  ]),
  { mode: 0o600 },
);
const seed = new Room({
  dataDir: dir,
  dbPath: path.join(dir, "oneroom.db"),
  maxDbBytes: 1024 * 1024,
  maxMessageBytes: 65536,
  maxDocBytes: 524288,
  retentionDays: 0,
});
seed.postMessage("agent", "Browser review target");
seed.storeDocument(
  "agent",
  "unsafe.html",
  "<script>window.executed=true</script>",
  "text/html",
);
seed.close();
let backendPort;
const proxy = https.createServer(
  {
    key: readFileSync(path.join(dir, "key.pem")),
    cert: readFileSync(path.join(dir, "cert.pem")),
  },
  (req, res) => {
    const forwarded = http.request(
      {
        host: "127.0.0.1",
        port: backendPort,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (response) => {
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
      },
    );
    forwarded.on("error", () => res.destroy());
    req.pipe(forwarded);
  },
);
proxy.listen(0, "127.0.0.1");
await once(proxy, "listening");
const base = `https://127.0.0.1:${proxy.address().port}`;
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("ONEROOM_")),
);
const server = spawn(process.execPath, ["dist/index.js"], {
  env: {
    ...cleanEnv,
    ONEROOM_DATA_DIR: dir,
    ONEROOM_PORT: "0",
    ONEROOM_PUBLIC_URL: base,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
const exited = once(server, "exit");
let output = "";
server.stdout.on("data", (data) => {
  output += data;
  const match = output.match(/listening on 127\.0\.0\.1:(\d+)/);
  if (match) backendPort = Number(match[1]);
});
server.stderr.on("data", (data) => {
  output += data;
});
let browser;
try {
  for (let i = 0; i < 100 && !backendPort && server.exitCode === null; i++)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(backendPort, output);
  browser = await chromium.launch({
    executablePath: process.env.ONEROOM_BROWSER_EXECUTABLE || undefined,
    headless: true,
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await page.goto(`${base}/login`);
  await page.getByLabel("Access token").fill(humanToken);
  const loginResponse = page.waitForResponse(
    (r) => r.url() === `${base}/login` && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  assert.equal(
    (await loginResponse).status(),
    303,
    "real form POST preserves Origin",
  );
  await page.waitForURL(`${base}/`);
  assert.match(await page.locator("body").innerText(), /Browser review target/);
  const session = (await context.cookies()).find(
    (cookie) => cookie.name === "__Host-oneroom",
  );
  assert.ok(
    session.httpOnly && session.secure && session.sameSite === "Strict",
  );
  assert.equal(await page.evaluate(() => document.cookie), "");
  assert.doesNotMatch(await page.content(), new RegExp(humanToken));
  assert.ok(
    (
      await page
        .locator("a")
        .evaluateAll((links) => links.map((link) => link.href))
    ).every((url) => !url.includes("key=")),
  );
  await page.getByLabel("Message ID", { exact: true }).fill("1");
  await page.getByLabel("Flag", { exact: true }).selectOption("note");
  await page
    .getByLabel("Note", { exact: true })
    .fill("Reviewed in a real browser");
  const annotationResponse = page.waitForResponse(
    (r) => r.url() === `${base}/annotate` && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Annotate as reviewer" }).click();
  assert.equal((await annotationResponse).status(), 303);
  await page.waitForURL(`${base}/`);
  await page.goto(base);
  await page
    .locator('form[action="/annotate"] input[name="csrf"]')
    .evaluate((input) => {
      input.value = "wrong";
    });
  await page.getByLabel("Message ID", { exact: true }).fill("1");
  const rejected = page.waitForResponse(
    (r) => r.url() === `${base}/annotate` && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Annotate as reviewer" }).click();
  assert.equal((await rejected).status(), 403);
  await page.goto(`${base}/doc/unsafe.html`);
  assert.match(await page.locator("pre").innerText(), /<script>/);
  assert.equal(await page.evaluate(() => window.executed), undefined);
  await page.goto(`${base}/boards?view=status`);
  await page
    .getByLabel("Two or three sentence update")
    .fill("Coordinating browser tests");
  await page
    .getByLabel("Detailed note (up to 40 KiB)")
    .fill("<script>window.executed=true</script>");
  await page.getByRole("button", { name: "Save as reviewer" }).click();
  await page.waitForURL(`${base}/boards?view=status`);
  assert.match(
    await page.locator("body").innerText(),
    /Coordinating browser tests/,
  );
  assert.equal(await page.evaluate(() => window.executed), undefined);
  await page
    .getByLabel("Two or three sentence update")
    .fill("Browser status updated");
  await page.getByRole("button", { name: "Save as reviewer" }).click();
  await page.waitForURL(`${base}/boards?view=status`);
  await page
    .getByLabel("Message (use @agent to mention)")
    .fill("Question for @admin");
  await page.getByLabel("Question", { exact: true }).selectOption("yes");
  await page.getByRole("button", { name: "Post", exact: true }).click();
  await page.waitForURL(/view=thread/);
  assert.match(await page.locator("body").innerText(), /Question for @admin/);
  await page.getByLabel("Message (use @agent to mention)").fill("More context");
  await page.getByRole("button", { name: "Post", exact: true }).click();
  await page.waitForURL(/message_id=3/);
  assert.match(await page.locator("body").innerText(), /More context/);
  await page.goto(`${base}/boards?view=work`);
  await page.getByLabel("Unique record key").fill("browser-work");
  await page.getByLabel("Task", { exact: true }).fill("Verify forms");
  await page.getByRole("button", { name: "Save as reviewer" }).click();
  await page.waitForURL(`${base}/boards?view=work`);
  assert.match(await page.locator("body").innerText(), /Verify forms/);
  await page.goto(`${base}/boards?view=test`);
  await page.getByLabel("Unique record key").fill("browser-test");
  await page.getByLabel("Repository (owner/name)").fill("org/repo");
  await page.getByLabel("Exact commit SHA").fill("a".repeat(40));
  await page.getByLabel("Suite", { exact: true }).fill("browser");
  await page
    .getByLabel("Command", { exact: true })
    .fill("npm run test:browser");
  await page.getByLabel("Result", { exact: true }).selectOption("passed");
  await page.getByRole("button", { name: "Save as reviewer" }).click();
  await page.waitForURL(`${base}/boards?view=test`);
  assert.match(await page.locator("body").innerText(), /passed/);
  await page.goto(base);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.waitForURL(`${base}/login`);
  assert.ok(
    !(await context.cookies()).some(
      (cookie) => cookie.name === "__Host-oneroom",
    ),
  );
  const exported = await fetch(`http://127.0.0.1:${backendPort}/export`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  }).then((r) => r.json());
  assert.equal(
    exported.room_records.filter((r) => r.kind === "status").length,
    2,
  );
  assert.equal(
    exported.attention.filter((a) => a.recipient === "admin").length,
    1,
  );
  assert.equal(exported.thread_links.filter((t) => t.root_id === 2).length, 2);
  assert.equal(exported.annotations.length, 1);
  assert.equal(exported.annotations[0].agent, "reviewer");
  assert.ok(!output.includes(adminToken) && !output.includes(humanToken));
  console.log(
    "BROWSER OK — actual HTTPS form login, Secure/HttpOnly cookies, CSRF, annotation, escaped documents, logout",
  );
} finally {
  if (browser) await browser.close();
  proxy.closeAllConnections();
  await new Promise((resolve) => proxy.close(resolve));
  server.kill("SIGTERM");
  await exited;
  rmSync(dir, { recursive: true, force: true });
}
