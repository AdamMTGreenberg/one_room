import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { SCHEMA_VERSION } from "./migrations.js";

async function hash(file: string) {
  const sha = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) sha.update(chunk);
  return sha.digest("hex");
}
function inspect(file: string) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    if (db.pragma("integrity_check", { simple: true }) !== "ok") throw new Error("Backup integrity check failed");
    const version = db.pragma("user_version", { simple: true }) as number;
    if (version > SCHEMA_VERSION) throw new Error("Backup needs a newer server");
    return version;
  } finally { db.close(); }
}
const [command = "create", argument, target] = process.argv.slice(2);
if (command === "create") {
  const dataDir = path.resolve(process.env.ONEROOM_DATA_DIR ?? "./data");
  const directory = path.resolve(argument ?? path.join(dataDir, "backups"));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `oneroom-${new Date().toISOString().replaceAll(":", "-")}-${randomBytes(4).toString("hex")}.db`);
  const temp = file + ".partial";
  const source = new Database(path.join(dataDir, "oneroom.db"), { readonly: true, fileMustExist: true });
  try {
    const fd = fs.openSync(temp, "wx", 0o600); fs.closeSync(fd);
    await source.backup(temp);
    const version = inspect(temp);
    const sha256 = await hash(temp);
    fs.linkSync(temp, file); // Atomic, refuses to overwrite a previous backup.
    fs.writeFileSync(file + ".json", JSON.stringify({ created_at: new Date().toISOString(), schema_version: version,
      bytes: fs.statSync(file).size, sha256 }) + "\n", { mode: 0o600, flag: "wx" });
    console.log(file);
  } finally { source.close(); if (fs.existsSync(temp)) fs.unlinkSync(temp); }
} else if (command === "verify" || command === "restore") {
  if (!argument) throw new Error("Specify a backup file");
  const file = path.resolve(argument);
  const manifest = JSON.parse(fs.readFileSync(file + ".json", "utf8"));
  if (await hash(file) !== manifest.sha256) throw new Error("Backup checksum does not match its manifest");
  inspect(file);
  if (command === "restore") {
    if (!target) throw new Error("Restore requires a new, nonexistent data directory");
    const dir = path.resolve(target);
    fs.mkdirSync(dir, { mode: 0o700 }); // Refuse any existing destination, including nonempty rooms.
    fs.copyFileSync(file, path.join(dir, "oneroom.db"), fs.constants.COPYFILE_EXCL);
    fs.chmodSync(path.join(dir, "oneroom.db"), 0o600);
    console.log(`Restored to ${dir}. Credentials are separate; restore them securely or generate a new bootstrap key on startup.`);
  } else console.log("Backup checksum and SQLite integrity verified");
} else throw new Error("Usage: backup create [output-directory] | verify <backup.db> | restore <backup.db> <new-data-directory>");
