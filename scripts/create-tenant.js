import crypto from "node:crypto";
import { createConfig, loadDotenv } from "../server/config.js";
import { openDatabase, createTenant, getTenantBySlug } from "../server/db.js";
import { hashPassword } from "../server/auth.js";

loadDotenv();
const [, , slug, name, password] = process.argv;

if (!slug || !name || !password) {
  console.error("Usage: npm run tenant:create -- <slug> <display name> <password>");
  process.exit(1);
}
if (!/^[a-z0-9][a-z0-9-]{1,48}$/i.test(slug)) {
  console.error("Slug must be 2-49 characters: letters, numbers, and hyphens.");
  process.exit(1);
}
if (password.length < 8) {
  console.error("Password must be at least 8 characters.");
  process.exit(1);
}

const config = createConfig();
const db = openDatabase(config);
if (getTenantBySlug(db, slug)) {
  console.error(`Tenant "${slug}" already exists.`);
  process.exit(1);
}

createTenant(db, {
  id: crypto.randomUUID(),
  slug,
  name: name.slice(0, 120),
  passwordHash: hashPassword(password),
  reportTime: config.reports.defaultTime,
  reportTimezone: config.reports.defaultTimezone,
});

console.log(`Created tenant "${slug}" (${name}).`);
db.close();
