#!/usr/bin/env node
import { GitHubSync, githubConfig } from "./github.js";
import { mountDelivery } from "./delivery.js";
import { renderBoards } from "./boards-ui.js";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import express from "express";
import { z } from "zod";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "./config.js";
import { FLAGS, Room } from "./db.js";
import { buildMcpServer } from "./mcp.js";
import { renderHome, renderLogin, renderContent } from "./ui.js";
import { Auth, equal, allowed, type Principal } from "./auth.js";
import { Operations, RateLimiter } from "./operations.js";

const cfg = loadConfig();
const auth = new Auth(cfg);
const room = new Room(cfg);
room.collaboration.setMembers(auth.principals());
const githubCfg = githubConfig();
const github = new GitHubSync(room, githubCfg);
const githubTimer = githubCfg.repos.length
  ? setInterval(() => {
      void github.sync();
    }, githubCfg.intervalSeconds * 1000)
  : undefined;
if (githubTimer) {
  githubTimer.unref();
  void github.sync();
}
const ops = new Operations();
const ingress = new RateLimiter((cfg.ratePerMinute ?? 120) * 10);
const requests = new RateLimiter(cfg.ratePerMinute ?? 120);
const logins = new RateLimiter(20);
const app = express();
app.disable("x-powered-by");
app.use(ops.middleware);
app.use((_req, res, next) => {
  res.set({
    "Cache-Control": "no-store",
    "Referrer-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  });
  next();
});
app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.use((req, res, next) => {
  if (!ingress.take(req.socket.remoteAddress ?? "unknown")) {
    res
      .set("Retry-After", "60")
      .status(429)
      .json({ error: "rate limit exceeded" });
    return;
  }
  if (ops.active > (cfg.maxConcurrentRequests ?? 16)) {
    res
      .set("Retry-After", "1")
      .status(503)
      .json({ error: "request capacity reached" });
    return;
  }
  // Never authenticate from query strings; remove legacy credentials from navigation.
  if (req.query.key !== undefined) {
    res.redirect(303, "/login");
    return;
  }
  next();
});
const secure = cfg.publicUrl?.startsWith("https:") ?? false;
const cookieName = secure ? "__Host-oneroom" : "oneroom";
const loginCookie = secure ? "__Host-oneroom-login" : "oneroom-login";
const cookieOptions = {
  httpOnly: true,
  secure,
  sameSite: "strict" as const,
  path: "/",
};
const cookie = (req: express.Request, name: string) =>
  req.headers.cookie
    ?.split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith(`${name}=`))
    ?.slice(name.length + 1);
const sameOrigin = (req: express.Request) =>
  req.headers.origin === (cfg.publicUrl ?? `http://${req.headers.host}`);
const formParser = express.urlencoded({
  extended: false,
  limit: "256kb",
  parameterLimit: 32,
});
app.get("/login", (_req, res) => {
  const csrf = randomBytes(32).toString("base64url");
  res.cookie(loginCookie, csrf, { ...cookieOptions, maxAge: 600000 });
  res.type("html").send(renderLogin(csrf));
});
app.post(
  "/login",
  express.urlencoded({ extended: false, limit: "16kb", parameterLimit: 3 }),
  (req, res) => {
    if (!logins.take(req.socket.remoteAddress ?? "unknown")) {
      res
        .set("Retry-After", "60")
        .status(429)
        .json({ error: "login rate limit exceeded" });
      return;
    }
    if (
      !sameOrigin(req) ||
      typeof req.body.csrf !== "string" ||
      !cookie(req, loginCookie) ||
      !equal(req.body.csrf, cookie(req, loginCookie)!)
    ) {
      res
        .status(403)
        .send("Invalid login origin or token; reload the login page");
      return;
    }
    const principal = auth.authenticate(req.body.token);
    if (!principal || principal.role === "agent") {
      res.status(401).send("Invalid browser credential");
      return;
    }
    const { token } = auth.login(principal);
    res.clearCookie(loginCookie, cookieOptions);
    res.cookie(cookieName, token, {
      ...cookieOptions,
      maxAge: (cfg.sessionHours ?? 8) * 3600000,
    });
    res.redirect(303, "/");
  },
);
app.use((req, res, next) => {
  const header = req.headers.authorization;
  const bearer = header?.startsWith("Bearer ")
    ? auth.authenticate(header.slice(7))
    : null;
  // MCP accepts only explicit bearer credentials, never ambient browser cookies.
  const session =
    !header && req.path !== "/mcp"
      ? auth.session(cookie(req, cookieName))
      : null;
  const principal = bearer ?? session?.principal;
  if (!principal) {
    if (req.path === "/" && req.method === "GET") res.redirect(303, "/login");
    else res.status(401).json({ error: "missing or invalid credential" });
    return;
  }
  if (!requests.take(principal.id)) {
    res
      .set("Retry-After", "60")
      .status(429)
      .json({ error: "rate limit exceeded" });
    return;
  }
  res.locals.principal = principal;
  res.locals.session = session;
  next();
});
const bodyLimit = 6 * Math.max(cfg.maxMessageBytes, cfg.maxDocBytes) + 65536;
app.use(express.json({ limit: bodyLimit }));
app.use(formParser);
app.use((req, res, next) => {
  if (res.locals.session && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    const csrf = req.headers["x-csrf-token"] ?? req.body?.csrf;
    if (
      !sameOrigin(req) ||
      typeof csrf !== "string" ||
      !equal(csrf, res.locals.session.csrf)
    ) {
      res.status(403).send("Invalid request origin or CSRF token");
      return;
    }
  }
  next();
});
const closeDelivery = mountDelivery(app, room);
app.post("/logout", (req, res) => {
  auth.logout(cookie(req, cookieName));
  res.clearCookie(cookieName, cookieOptions);
  res.redirect(303, "/login");
});
app.post("/mcp", async (req, res) => {
  const server = buildMcpServer(
    room,
    res.locals.principal,
    ops.recordTool,
    github,
  );
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  res.on("close", () => {
    void server.close().catch(() => {});
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch {
    await transport.close().catch(() => {});
    if (!res.headersSent)
      res
        .status(500)
        .json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "internal error" },
          id: null,
        });
    else res.destroy();
  }
});
app.all("/mcp", (_req, res) =>
  res.set("Allow", "POST").status(405).json({ error: "Method not allowed" }),
);
function permit(
  permission: "annotate" | "export" | "metrics" | "post",
): express.RequestHandler {
  return (_req, res, next) => {
    if (!allowed(res.locals.principal as Principal, permission)) {
      res.status(403).json({ error: "permission denied" });
      return;
    }
    next();
  };
}
app.get("/", (req, res) => {
  const query = z.record(z.string().max(1000)).parse(req.query);
  const html = renderHome(
    room,
    res.locals.principal,
    res.locals.session?.csrf ?? "",
    query,
  );
  if (Buffer.byteLength(html) > room.reads.budget)
    throw new Error("UI response exceeds configured budget");
  res.type("html").send(html);
});
app.get("/pr-tests/:key", (req, res) => {
  const page = room.collaboration.prTests(
    req.params.key,
    Number(req.query.after_id ?? 0),
  );
  res
    .type("html")
    .send(
      renderContent(
        JSON.stringify(page, null, 2),
        page.has_more ? `${req.path}?after_id=${page.next_cursor}` : null,
      ),
    );
});
app.get("/integrations", (_req, res) => res.json(github.status()));
app.get("/boards", (req, res) => {
  const html = renderBoards(
    room,
    res.locals.principal,
    res.locals.session?.csrf ?? "",
    z.record(z.string().max(1000)).parse(req.query),
  );
  if (Buffer.byteLength(html) > room.reads.budget)
    throw new Error("oneroom: page exceeds response budget");
  res.type("html").send(html);
});
app.post("/message", permit("post"), (req, res) => {
  const a = z
    .object({
      request_id: z.string(),
      content: z.string().min(1),
      reply_to: z.string().optional(),
      mentions: z.string().default(""),
      question: z.enum(["yes", "no"]).default("no"),
      csrf: z.string().optional(),
    })
    .strict()
    .parse(req.body);
  const payload = {
    content: a.content,
    reply_to: a.reply_to ? Number(a.reply_to) : undefined,
    mentions: a.mentions
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    question: a.question === "yes",
  };
  const message = room.idempotent(
    res.locals.principal.id,
    a.request_id,
    "post_message",
    payload,
    () => {
      const m = room.postMessage(
        res.locals.principal.id,
        payload.content,
        payload.reply_to,
        payload.mentions,
        payload.question,
      );
      return { id: m.id };
    },
  );
  res.redirect(303, `/boards?view=thread&message_id=${message.id}`);
});
app.post("/attention", permit("post"), (req, res) => {
  const a = z
    .object({
      request_id: z.string(),
      attention_id: z.coerce.number().int().positive(),
      state: z.enum(["acknowledged", "answered", "resolved"]),
      csrf: z.string().optional(),
    })
    .strict()
    .parse(req.body);
  room.idempotent(
    res.locals.principal.id,
    a.request_id,
    "update_attention",
    { id: a.attention_id, state: a.state },
    () =>
      room.collaboration.attention(
        res.locals.principal.id,
        a.attention_id,
        a.state,
      ),
  );
  res.redirect(303, "/boards?view=inbox");
});
app.post("/record", permit("post"), (req, res) => {
  const a = z.record(z.string()).parse(req.body);
  const kind = z
    .enum(["status", "work", "test", "log", "pr_note"])
    .parse(a.kind);
  const lines = (key: string) =>
    (a[key] ?? "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  const fields = (keys: string[]) =>
    Object.fromEntries(keys.map((key) => [key, a[key] ?? ""]));
  const data =
    kind === "status"
      ? fields([
          "summary",
          "detail",
          "state",
          "task",
          "repo",
          "branch",
          "worktree",
          "blockers",
        ])
      : kind === "work"
        ? {
            ...fields(["title", "state", "repo", "branch", "blockers"]),
            areas: lines("areas"),
            depends_on: lines("depends_on"),
            lease_until:
              Date.now() +
              z.coerce.number().min(0).max(1440).parse(a.lease_minutes) * 60000,
          }
        : kind === "test"
          ? {
              ...fields([
                "repo",
                "commit",
                "suite",
                "command",
                "state",
                "started_at",
                "summary",
              ]),
              ...(a.state !== "running"
                ? { finished_at: new Date().toISOString() }
                : {}),
              artifacts: lines("artifacts"),
            }
          : kind === "log"
            ? {
                ...fields(["level", "summary", "output", "repo", "work_key"]),
                artifacts: lines("artifacts"),
              }
            : fields(["summary", "detail"]);
  const expected = Number(a.expected_version);
  // Hash the stable form, not derived timestamps, so browser retries replay exactly.
  const { csrf: _csrf, request_id: _request, ...payload } = a;
  room.idempotent(
    res.locals.principal.id,
    a.request_id,
    "form_record",
    payload,
    () =>
      room.collaboration.put(
        res.locals.principal.id,
        kind,
        a.key,
        data,
        expected,
      ),
  );
  res.redirect(303, `/boards?view=${kind}`);
});
app.get("/record/:kind/:key", (req, res) => {
  const kind = z
    .enum(["status", "work", "test", "log", "pr", "pr_note"])
    .parse(req.params.kind);
  const result = room.collaboration.content(
    kind,
    req.params.key,
    Number(req.query.offset ?? 0),
    req.query.version === undefined ? undefined : Number(req.query.version),
  );
  if (!result) {
    res.status(404).send("not found");
    return;
  }
  res
    .type("html")
    .send(
      renderContent(
        result.content,
        result.next_offset === null
          ? null
          : `${req.path}?version=${result.version}&offset=${result.next_offset}`,
      ),
    );
});
app.post("/annotate", permit("annotate"), (req, res) => {
  const fields = z
    .object({
      request_id: z.string(),
      flag: z.enum(FLAGS),
      note: z.string().max(10000).optional(),
      message_id: z.string().optional(),
      document_name: z.string().max(200).optional(),
      document_version: z.string().optional(),
      csrf: z.string().optional(),
    })
    .strict()
    .parse(req.body);
  const payload = {
    flag: fields.flag,
    note: fields.note || undefined,
    messageId: fields.message_id ? Number(fields.message_id) : undefined,
    documentName: fields.document_name || undefined,
    documentVersion: fields.document_version
      ? Number(fields.document_version)
      : undefined,
  };
  const principal = res.locals.principal as Principal;
  room.idempotent(principal.id, fields.request_id, "annotate", payload, () => {
    const annotation = room.annotate({ ...payload, agent: principal.id });
    return { id: annotation.id, flag: annotation.flag };
  });
  res.redirect(303, "/");
});
for (const [route, kind] of [
  ["/message/:id", "messages"],
  ["/doc/:name", "documents"],
  ["/annotation/:id", "annotations"],
] as const) {
  app.get(route, (req, res) => {
    const offset =
      req.query.offset === undefined ? 0 : Number(req.query.offset);
    const version =
      req.query.version === undefined
        ? undefined
        : z.number().int().positive().safe().parse(Number(req.query.version));
    const params = req.params as Record<string, string>;
    const key =
      kind === "documents"
        ? params.name
        : z.number().int().positive().safe().parse(Number(params.id));
    const result = room.reads.content(kind, key, offset, version);
    if (!result) {
      res.status(404).send("not found");
      return;
    }
    const query = new URLSearchParams({ offset: String(result.next_offset) });
    if (kind === "documents") query.set("version", String(result.meta.version));
    const next = result.next_offset !== null ? `${req.path}?${query}` : null;
    if (req.query.format === "text") {
      if (next) res.set("Link", `<${next}&format=text>; rel="next"`);
      res.type("text/plain").send(result.content);
    } else res.type("html").send(renderContent(result.content, next));
  });
}
app.get("/export", permit("export"), (_req, res) => {
  res
    .type("application/json")
    .set("Content-Disposition", 'attachment; filename="oneroom-export.json"');
  const source = Readable.from(room.exportChunks());
  source.on("error", () => res.destroy());
  res.on("close", () => source.destroy());
  source.pipe(res);
});
app.get("/metrics", permit("metrics"), (_req, res) =>
  res.json({ ...ops.snapshot(), ...room.operationalStatus() }),
);
app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (res.headersSent) return next(err);
    const message = err instanceof Error ? err.message : "";
    const supplied =
      typeof err === "object" && err !== null && "status" in err
        ? Number(err.status)
        : undefined;
    const validation =
      err instanceof z.ZodError ||
      /^(oneroom:|offset |Unknown view|after_id |before_id |document_version |message_id )/.test(
        message,
      );
    const code = /database size limit|free disk reserve/.test(message)
      ? 503
      : /request_id was already used/.test(message)
        ? 409
        : supplied && supplied >= 400 && supplied < 500
          ? supplied
          : validation
            ? 400
            : 500;
    if (code >= 500)
      console.error(JSON.stringify({ event: "request_failed", status: code }));
    res
      .status(code)
      .json({
        error:
          code === 413
            ? "request body too large"
            : code === 500
              ? "internal server error"
              : "invalid request",
      });
  },
);
const httpServer = app.listen(cfg.port, cfg.host, () => {
  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : cfg.port;
  console.log(`[oneroom] listening on ${cfg.host}:${port}`);
  console.log(
    `[oneroom] Browser: ${cfg.publicUrl ?? `http://localhost:${port}`}/login; MCP: POST /mcp`,
  );
  console.log(
    `[oneroom] Credentials: ${cfg.credentialsFile ? "named credentials file" : "bootstrap admin key file"}; access tokens are never logged`,
  );
});
httpServer.requestTimeout = 30000;
httpServer.headersTimeout = 15000;
httpServer.on("error", () => {
  console.error("[oneroom] failed to listen; check bind address and port");
  room.close();
  process.exitCode = 1;
});
let lastWarnings = "";
const monitor = setInterval(() => {
  try {
    const status = room.operationalStatus();
    const warnings = status.warnings.join(",");
    if (warnings !== lastWarnings)
      console.log(JSON.stringify({ event: "capacity", ...status }));
    lastWarnings = warnings;
  } catch {
    console.error(JSON.stringify({ event: "storage_check_failed" }));
  }
}, 30000);
monitor.unref();
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(monitor);
  closeDelivery();
  if (githubTimer) clearInterval(githubTimer);
  github.stop();
  const deadline = setTimeout(() => {
    httpServer.closeAllConnections();
    process.exit(1);
  }, 10000);
  deadline.unref();
  httpServer.close(() => {
    clearTimeout(deadline);
    room.close();
    process.exitCode = 0;
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
