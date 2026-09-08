import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import { z } from "zod";
import type { Config } from "./config.js";

export type Role = "admin" | "agent" | "human" | "reader";
export interface Principal { id: string; role: Role }
export type Permission = "read" | "post" | "annotate" | "document" | "export" | "metrics";
const permissions: Record<Role, Permission[]> = {
  admin: ["read", "post", "annotate", "document", "export", "metrics"],
  agent: ["read", "post", "annotate", "document"],
  human: ["read", "annotate", "export"],
  reader: ["read"],
};
export function allowed(principal: Principal, action: Permission): boolean { return permissions[principal.role].includes(action); }
export function requirePermission(principal: Principal, action: Permission): void {
  if (!allowed(principal, action)) throw new Error(`Permission denied: ${action}`);
}
const digest = (s: string) => createHash("sha256").update(s).digest();
export const equal = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

export const credentialSchema = z.array(z.object({
        id: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_.-]+$/),
        role: z.enum(["admin", "agent", "human", "reader"]),
        token: z.string().min(32).max(4096).regex(/^[\x21-\x7e]+$/),
      }).strict()).min(1).max(1000);

interface Session { principal: Principal; csrf: string; expires: number }
export class Auth {
  private credentials: { principal: Principal; hash: Buffer }[];
  private sessions = new Map<string, Session>();
  constructor(private cfg: Config) {
    if (cfg.credentialsFile) {
      const file = fs.statSync(cfg.credentialsFile);
      if (file.size > 1024 * 1024) throw new Error("Credentials file exceeds 1 MB");
      if (process.platform !== "win32" && (file.mode & 0o077)) throw new Error("Credentials file must have mode 0600 (no group/other access)");
      const entries = credentialSchema.parse(JSON.parse(fs.readFileSync(cfg.credentialsFile, "utf8")));
      if (new Set(entries.map(e => e.id)).size !== entries.length || new Set(entries.map(e => e.token)).size !== entries.length) {
        throw new Error("Credential identities and tokens must be unique");
      }
      if (!entries.some(e => e.role === "admin")) throw new Error("Credentials must include an admin");
      this.credentials = entries.map(({ id, role, token }) => ({ principal: { id, role }, hash: digest(token) }));
    } else {
      // Bootstrap credential; replace it with named credentials before sharing.
      this.credentials = [{ principal: { id: "admin", role: "admin" }, hash: digest(cfg.key) }];
    }
  }
  authenticate(token: unknown): Principal | null {
    if (typeof token !== "string" || !token || token.length > 4096) return null;
    const hash = digest(token);
    let principal: Principal | null = null;
    for (const c of this.credentials) if (timingSafeEqual(hash, c.hash)) principal = c.principal;
    return principal;
  }
  login(principal: Principal): { token: string; session: Session } {
    if (principal.role === "agent") throw new Error("Agent credentials cannot create browser sessions");
    const now = Date.now();
    for (const [token, session] of this.sessions) if (session.expires <= now) this.sessions.delete(token);
    if (this.sessions.size >= 1000) throw new Error("Session capacity reached; retry after existing sessions expire");
    const token = randomBytes(32).toString("base64url");
    const session = { principal, csrf: randomBytes(32).toString("base64url"), expires: now + (this.cfg.sessionHours ?? 8) * 3600000 };
    this.sessions.set(token, session);
    return { token, session };
  }
  session(token: string | undefined): Session | null {
    if (!token) return null;
    const session = this.sessions.get(token);
    if (!session) return null;
    if (session.expires <= Date.now()) { this.sessions.delete(token); return null; }
    return session;
  }
  logout(token: string | undefined): void { if (token) this.sessions.delete(token); }
}
