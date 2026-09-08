import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";
import { credentialSchema } from "./auth.js";

const cfg = loadConfig();
const file = cfg.credentialsFile ?? path.join(cfg.dataDir, "credentials.json");
const entries = credentialSchema.parse(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [{ id: "admin", role: "admin", token: cfg.key }]);
const [command, id, role] = process.argv.slice(2);
if (command === "list") {
  console.log(JSON.stringify(entries.map(({ id, role }) => ({ id, role })), null, 2));
} else {
  const index = entries.findIndex(entry => entry.id === id);
  let token: string | undefined;
  if (command === "add" && index === -1) {
    token = "or_" + randomBytes(32).toString("base64url");
    entries.push(credentialSchema.element.parse({ id, role, token }));
  } else if (command === "rotate" && index !== -1) {
    token = "or_" + randomBytes(32).toString("base64url"); entries[index].token = token;
  } else if (command === "remove" && index !== -1) {
    entries.splice(index, 1);
  } else throw new Error("Usage: credentials add <unique-id> <admin|agent|human|reader> | rotate <id> | remove <id> | list");
  if (!entries.some(entry => entry.role === "admin")) throw new Error("Cannot remove the last admin");
  const temp = file + "." + randomBytes(6).toString("hex") + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(entries, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  try { fs.renameSync(temp, file); } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  console.log("Credentials saved. Restart the server to activate changes and revoke existing sessions.");
  if (token) console.log(`Token for ${id} (store securely): ${token}`);
}
