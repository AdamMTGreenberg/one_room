import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FLAGS, Room } from "./db.js";

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function err(e: unknown) {
  return {
    content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }],
    isError: true,
  };
}

const agentName = z
  .string()
  .min(1)
  .max(64)
  .describe("Your agent name, stable across the session, e.g. 'claude-backend' or 'codex-ui'");

export function buildMcpServer(room: Room): McpServer {
  const server = new McpServer({ name: "oneroom", version: "0.1.0" });

  server.registerTool(
    "catch_up",
    {
      title: "Catch up on the room",
      description:
        "Call this FIRST when you start working. Returns pinned read-first messages, the recent " +
        "chat tail, the document list, and room status. Then post a message saying who you are " +
        "and what you are about to work on.",
      inputSchema: {
        agent: agentName,
        limit: z.number().int().min(1).max(200).optional().describe("Recent messages to include (default 30)"),
      },
    },
    async ({ agent, limit }) => {
      try {
        return json({
          you_are: agent,
          read_first: room.readFirstMessages(),
          recent_messages: room.readMessages({ limit: limit ?? 30 }),
          documents: room.listDocuments(),
          status: room.status(),
          protocol:
            "Post a short message announcing what you are working on. Post again when you finish, " +
            "fail, or learn something other agents need. Flag failures with annotate(flag='failed') " +
            "and important context with annotate(flag='read-first').",
        });
      } catch (e) {
        return err(e);
      }
    }
  );

  server.registerTool(
    "post_message",
    {
      title: "Post a message to the room",
      description:
        "Append a message to the single shared chat. All agents and humans see it. Messages can " +
        "never be edited or deleted, so write what future readers need: what you did, what you " +
        "are doing, what failed, what to avoid.",
      inputSchema: {
        agent: agentName,
        content: z.string().min(1).describe("Message body (markdown welcome)"),
        reply_to: z.number().int().optional().describe("Message id this replies to"),
      },
    },
    async ({ agent, content, reply_to }) => {
      try {
        return json(room.postMessage(agent, content, reply_to));
      } catch (e) {
        return err(e);
      }
    }
  );

  server.registerTool(
    "read_messages",
    {
      title: "Read the chat",
      description:
        "Read messages from the shared chat in chronological order, with their annotations. Use " +
        "after_id to poll for messages newer than the last one you saw.",
      inputSchema: {
        limit: z.number().int().min(1).max(500).optional().describe("Max messages (default 50)"),
        before_id: z.number().int().optional().describe("Only messages with id < before_id"),
        after_id: z.number().int().optional().describe("Only messages with id > after_id"),
        include_archived: z
          .boolean()
          .optional()
          .describe("Include messages older than the retention window (they are hidden, never deleted)"),
      },
    },
    async ({ limit, before_id, after_id, include_archived }) => {
      try {
        return json(
          room.readMessages({ limit, beforeId: before_id, afterId: after_id, includeArchived: include_archived })
        );
      } catch (e) {
        return err(e);
      }
    }
  );

  server.registerTool(
    "annotate",
    {
      title: "Annotate a message or document",
      description:
        "Attach a flag to a message or a document. Nothing is ever deleted in this room; " +
        "annotation is how you mark things stale, outdated, or failed, pin critical context with " +
        "'read-first', or clear an earlier read-first pin with 'resolved'.",
      inputSchema: {
        agent: agentName,
        flag: z.enum(FLAGS).describe("read-first | stale | outdated | failed | resolved | note"),
        note: z.string().optional().describe("Why this flag applies, and what to do instead if relevant"),
        message_id: z.number().int().optional().describe("Target message id (exactly one target required)"),
        document_name: z.string().optional().describe("Target document name (exactly one target required)"),
      },
    },
    async ({ agent, flag, note, message_id, document_name }) => {
      try {
        return json(room.annotate({ agent, flag, note, messageId: message_id, documentName: document_name }));
      } catch (e) {
        return err(e);
      }
    }
  );

  server.registerTool(
    "search",
    {
      title: "Search messages and documents",
      description: "Full-text search (SQLite FTS5) across the chat and document store.",
      inputSchema: {
        query: z.string().min(1).describe("Search terms; FTS5 syntax allowed, falls back to phrase match"),
        scope: z.enum(["messages", "documents", "all"]).optional().describe("Default: all"),
        limit: z.number().int().min(1).max(100).optional().describe("Max results per scope (default 20)"),
        include_archived: z.boolean().optional(),
      },
    },
    async ({ query, scope, limit, include_archived }) => {
      try {
        return json(room.search({ query, scope, limit, includeArchived: include_archived }));
      } catch (e) {
        return err(e);
      }
    }
  );

  server.registerTool(
    "store_document",
    {
      title: "Store a document",
      description:
        "Store a named document (plan, spec, decision record, findings). Storing an existing name " +
        "creates a new immutable version; old versions remain readable. Post a message announcing " +
        "significant documents so other agents notice them.",
      inputSchema: {
        agent: agentName,
        name: z.string().min(1).max(200).describe("Stable document name, e.g. 'architecture.md'"),
        content: z.string().min(1),
        mime: z.string().optional().describe("Default text/markdown"),
      },
    },
    async ({ agent, name, content, mime }) => {
      try {
        return json(room.storeDocument(agent, name, content, mime));
      } catch (e) {
        return err(e);
      }
    }
  );

  server.registerTool(
    "get_document",
    {
      title: "Get a document",
      description: "Fetch a document by name (latest version unless a version is given).",
      inputSchema: {
        name: z.string().min(1),
        version: z.number().int().optional(),
      },
    },
    async ({ name, version }) => {
      try {
        const doc = room.getDocument(name, version);
        if (!doc) return err(new Error(`oneroom: document "${name}" not found`));
        return json(doc);
      } catch (e) {
        return err(e);
      }
    }
  );

  server.registerTool(
    "list_documents",
    {
      title: "List documents",
      description: "List all documents (latest version of each) with their annotations.",
      inputSchema: {},
    },
    async () => {
      try {
        return json(room.listDocuments());
      } catch (e) {
        return err(e);
      }
    }
  );

  server.registerTool(
    "status",
    {
      title: "Room status",
      description: "Counts, storage usage versus limits, and the retention window.",
      inputSchema: {},
    },
    async () => {
      try {
        return json(room.status());
      } catch (e) {
        return err(e);
      }
    }
  );

  return server;
}
