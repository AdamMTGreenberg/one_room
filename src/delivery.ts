import type express from "express";
import { z } from "zod";
import type { Room } from "./db.js";
import { allowed } from "./auth.js";

/** Authenticated application SSE, independent of the stateless MCP transport. */
export function mountDelivery(app: express.Express, room: Room) {
  const streams = new Map<string, express.Response>();
  app.get("/events", (req, res) => {
    if (res.locals.session) {
      res.status(401).json({ error: "explicit bearer credential required" });
      return;
    }
    const agent = res.locals.principal.id;
    if (streams.has(agent) || streams.size >= 4) {
      res
        .set("Retry-After", "5")
        .status(429)
        .json({ error: "event stream capacity reached" });
      return;
    }
    let cursor = z.coerce
      .number()
      .int()
      .nonnegative()
      .safe()
      .parse(req.headers["last-event-id"] ?? req.query.after_id ?? 0);
    res
      .status(200)
      .set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      });
    res.flushHeaders();
    req.socket.setTimeout(0);
    streams.set(agent, res);
    let blocked = false;
    const send = () => {
      if (blocked || res.destroyed) return;
      try {
        const page = room.collaboration.events(cursor, 20, agent);
        for (const event of page.items) {
          const ok = res.write(
            `id: ${event.id}\nevent: attention\ndata: ${JSON.stringify(event)}\n\n`,
          );
          cursor = event.id;
          if (!ok) {
            blocked = true;
            break;
          }
        }
      } catch {
        res.end();
      }
    };
    res.on("drain", () => {
      blocked = false;
      send();
    });
    const poll = setInterval(send, 1000);
    const keepAlive = setInterval(() => {
      if (!blocked) blocked = !res.write(": keep-alive\n\n");
    }, 15000);
    // Periodic reconnect rechecks credentials and prevents abandoned connections living forever.
    const rotate = setTimeout(() => res.end(), 55000);
    res.on("close", () => {
      clearInterval(poll);
      clearInterval(keepAlive);
      clearTimeout(rotate);
      streams.delete(agent);
    });
    res.write(": connected\n\n");
    send();
  });
  app.post("/wake/:action", (req, res) => {
    if (res.locals.session || !allowed(res.locals.principal, "post")) {
      res
        .status(403)
        .json({ error: "agent/admin/human bearer credential required" });
      return;
    }
    const agent = res.locals.principal.id;
    if (req.params.action === "register") {
      const a = z
        .object({ interval_seconds: z.number().int().min(30).max(86400) })
        .strict()
        .parse(req.body);
      res.json(room.collaboration.registerRunner(agent, a.interval_seconds));
    } else if (req.params.action === "claim") {
      const a = z
        .object({
          lease_seconds: z.number().int().min(30).max(3600).default(300),
        })
        .strict()
        .parse(req.body);
      res.json(room.collaboration.claimWake(agent, a.lease_seconds));
    } else if (req.params.action === "complete") {
      const a = z
        .object({
          token: z.string().uuid(),
          through_event: z.number().int().nonnegative().safe(),
          success: z.boolean(),
        })
        .strict()
        .parse(req.body);
      res.json(
        room.idempotent(agent, a.token, "wake_complete", a, () =>
          room.collaboration.finishWake(
            agent,
            a.token,
            a.through_event,
            a.success,
          ),
        ),
      );
    } else res.status(404).json({ error: "unknown wake action" });
  });
  return () => {
    for (const res of streams.values()) res.end();
  };
}
