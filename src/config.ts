import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface Config {
  port: number;
  dataDir: string;
  dbPath: string;
  key: string;
  keyFile: string;
  keyGenerated: boolean;
  maxDbBytes: number;
  maxMessageBytes: number;
  maxDocBytes: number;
  retentionDays: number;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0) {
    throw new Error(`Invalid value for ${name}: ${raw}`);
  }
  return n;
}

export function loadConfig(): Config {
  const dataDir = path.resolve(process.env.ONEROOM_DATA_DIR ?? "./data");
  fs.mkdirSync(dataDir, { recursive: true });

  const keyFile = path.join(dataDir, "oneroom.key");
  let key = (process.env.ONEROOM_KEY ?? "").trim();
  let keyGenerated = false;
  if (!key) {
    if (fs.existsSync(keyFile)) {
      key = fs.readFileSync(keyFile, "utf8").trim();
    } else {
      key = "or_" + randomBytes(24).toString("base64url");
      fs.writeFileSync(keyFile, key + "\n", { mode: 0o600 });
      keyGenerated = true;
    }
  }

  return {
    port: envInt("ONEROOM_PORT", 7777),
    dataDir,
    dbPath: path.join(dataDir, "oneroom.db"),
    key,
    keyFile,
    keyGenerated,
    maxDbBytes: envInt("ONEROOM_MAX_DB_MB", 256) * 1024 * 1024,
    maxMessageBytes: envInt("ONEROOM_MAX_MESSAGE_KB", 64) * 1024,
    maxDocBytes: envInt("ONEROOM_MAX_DOC_KB", 512) * 1024,
    retentionDays: envInt("ONEROOM_RETENTION_DAYS", 0),
  };
}
