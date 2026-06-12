#!/usr/bin/env node
import { timingSafeEqual } from "node:crypto";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "./config.js";
import { Room } from "./db.js";
import { buildMcpServer } from "./mcp.js";
import { renderHome } from "./ui.js";

const cfg = loadConfig();
const room = new Room(cfg);
const app = express();

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false }));

function keyMatches(provided: string | undefined): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(cfg.key);
  return a.length === b.length && timingSafeEqual(a, b);
}

function extractKey(req: express.Request): string | undefined {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
  const q = req.query.key;
  return typeof q === "string" ? q : undefined;
}

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

app.use((req, res, next) => {
  if (keyMatches(extractKey(req))) return next();
  res.status(401).json({ error: "oneroom: missing or invalid access key" });
});

// ---- MCP endpoint (stateless streamable HTTP) -------------------------------

app.post("/mcp", async (req, res) => {
  try {
    const server = buildMcpServer(room);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: e instanceof Error ? e.message : "internal error" },
        id: null,
      });
    }
  }
});

app.get("/mcp", (_req, res) => {
  // Stateless mode: no server-initiated streams.
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed" },
    id: null,
  });
});

app.delete("/mcp", (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed" },
    id: null,
  });
});

// ---- Human audit UI ---------------------------------------------------------

app.get("/", (req, res) => {
  res.type("html").send(renderHome(room, extractKey(req) ?? ""));
});

app.post("/annotate", (req, res) => {
  try {
    const { agent, flag, note, message_id, document_name } = req.body as Record<string, string>;
    room.annotate({
      agent: agent || "human",
      flag: flag as never,
      note: note || undefined,
      messageId: message_id ? Number(message_id) : undefined,
      documentName: document_name || undefined,
    });
    res.redirect(`/?key=${encodeURIComponent(extractKey(req) ?? "")}`);
  } catch (e) {
    res.status(400).send(e instanceof Error ? e.message : "bad request");
  }
});

app.get("/doc/:name", (req, res) => {
  const doc = room.getDocument(req.params.name);
  if (!doc) {
    res.status(404).send("not found");
    return;
  }
  res.type(doc.meta.mime.startsWith("text/") ? doc.meta.mime : "text/plain").send(doc.content);
});

app.get("/export", (_req, res) => {
  res.json(room.exportAll());
});

// ---- boot ---------------------------------------------------------------

app.listen(cfg.port, () => {
  console.log(`[oneroom] listening on :${cfg.port}`);
  console.log(`[oneroom] data dir: ${cfg.dataDir}`);
  if (cfg.keyGenerated) {
    console.log(`[oneroom] generated access key (also saved to ${cfg.keyFile}):`);
    console.log(`\n  ${cfg.key}\n`);
  }
  console.log(`[oneroom] agents connect to   POST /mcp   with header  Authorization: Bearer <key>`);
  console.log(`[oneroom] humans audit at     http://localhost:${cfg.port}/?key=<key>`);
});

process.on("SIGINT", () => {
  room.close();
  process.exit(0);
});
process.on("SIGTERM", () => {
  room.close();
  process.exit(0);
});
