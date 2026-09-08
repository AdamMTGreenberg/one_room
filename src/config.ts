import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  dbPath: string;
  key: string;
  keyFile: string;
  keyGenerated: boolean;
  maxDbBytes: number;
  maxMessageBytes: number;
  maxDocBytes: number;
  retentionDays: number;
  maxResponseBytes?: number;
  credentialsFile?: string;
  publicUrl?: string;
  sessionHours?: number;
  ratePerMinute?: number;
  minFreeDiskBytes?: number;
  maxConcurrentRequests?: number;
}

function envInt(name: string, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < min || n > max) {
    throw new Error(`Invalid value for ${name}: expected an integer from ${min} to ${max}`);
  }
  return n;
}

export function loadConfig(): Config {
  // Validate before creating files or generating credentials.
  const port = envInt("ONEROOM_PORT", 7777, 0, 65535);
  const host = process.env.ONEROOM_HOST ?? "127.0.0.1";
  if (!host.trim()) throw new Error("ONEROOM_HOST must not be empty");
  const maxDbBytes = envInt("ONEROOM_MAX_DB_MB", 256, 1, 1_048_576) * 1024 * 1024;
  const maxMessageBytes = envInt("ONEROOM_MAX_MESSAGE_KB", 64, 1, 65_536) * 1024;
  const maxDocBytes = envInt("ONEROOM_MAX_DOC_KB", 512, 1, 65_536) * 1024;
  const retentionDays = envInt("ONEROOM_RETENTION_DAYS", 0, 0, 1_000_000);
  const maxResponseBytes = envInt("ONEROOM_MAX_RESPONSE_KB", 256, 64, 1024) * 1024;
  const sessionHours = envInt("ONEROOM_SESSION_HOURS", 8, 1, 168);
  const ratePerMinute = envInt("ONEROOM_RATE_PER_MINUTE", 120, 1, 10000);
  const minFreeDiskBytes = envInt("ONEROOM_MIN_FREE_DISK_MB", 64, 0, 1048576) * 1024 * 1024;
  const maxConcurrentRequests = envInt("ONEROOM_MAX_CONCURRENT_REQUESTS", 16, 1, 128);
  let publicUrl: string | undefined;
  if (process.env.ONEROOM_PUBLIC_URL) {
    const url = new URL(process.env.ONEROOM_PUBLIC_URL);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("ONEROOM_PUBLIC_URL must be an HTTP(S) origin without a path or credentials");
    }
    publicUrl = url.origin;
  }
  let credentialsFile = process.env.ONEROOM_CREDENTIALS_FILE || undefined;
  const dataDir = path.resolve(process.env.ONEROOM_DATA_DIR ?? "./data");
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (!credentialsFile && fs.existsSync(path.join(dataDir, "credentials.json"))) credentialsFile = path.join(dataDir, "credentials.json");

  const keyFile = path.join(dataDir, "oneroom.key");
  let key = (process.env.ONEROOM_KEY ?? "").trim();
  if (process.env.ONEROOM_KEY !== undefined && !key) {
    throw new Error("ONEROOM_KEY must not be empty");
  }
  let keyGenerated = false;
  if (!key) {
    if (fs.existsSync(keyFile)) {
      key = fs.readFileSync(keyFile, "utf8").trim();
    } else {
      key = "or_" + randomBytes(24).toString("base64url");
      fs.writeFileSync(keyFile, key + "\n", { mode: 0o600, flag: "wx" });
      keyGenerated = true;
    }
  }

  if (!key || !/^[\x21-\x7e]+$/.test(key) || key.length > 4096) {
    throw new Error("Access key must be nonempty, at most 4096 characters, and contain only printable ASCII without spaces");
  }

  return {
    port,
    host,
    dataDir,
    dbPath: path.join(dataDir, "oneroom.db"),
    key,
    keyFile,
    keyGenerated,
    maxDbBytes,
    maxMessageBytes,
    maxDocBytes,
    retentionDays,
    maxResponseBytes, credentialsFile, publicUrl, sessionHours, ratePerMinute,
    minFreeDiskBytes, maxConcurrentRequests,
  };
}
