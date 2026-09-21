// scripts/sync-vercel-env.mjs
//
// Pushes the values in .env.deploy.local to the linked Vercel project and prints a
// key x environment matrix.
//
// Two lessons are baked in, both from mistakes that actually shipped:
//
//  1. PRESENCE IS NOT EQUALITY. An earlier version only asked "does this key exist on Vercel?".
//     So replacing a value locally silently did nothing: production kept using an invalid Resend
//     key while the local file looked correct, and delivery failed with no obvious cause. Values
//     are now written unconditionally. The script never reports "in sync" from presence alone.
//
//  2. SOME KEYS ARE NOT OURS TO MANAGE. DATABASE_URL and DIRECT_URL are written by the Neon
//     integration, and this file happens to hold a *different* database (db.prisma.io). Pushing
//     from here would repoint production at the wrong database, so those keys are reported and
//     never overwritten — drift is surfaced instead of acted on.
//
// Usage:  node scripts/sync-vercel-env.mjs
// Requires: `vercel login` (it reuses the CLI's stored token).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ENV_FILE = ".env.deploy.local";
const TARGETS = ["production", "preview", "development"];

/** Keys whose value is owned by an integration, not by this file. Never pushed from here. */
const EXTERNALLY_MANAGED = new Set(["DATABASE_URL", "DIRECT_URL"]);

/** Legitimately absent before the first deploy (the domain does not exist yet). */
const OPTIONAL = new Set(["AUTH_URL"]);

const MANAGED = [
  "DATABASE_URL",
  "DIRECT_URL",
  "AUTH_SECRET",
  "AUTH_URL",
  "CRON_SECRET",
  "NEXT_PUBLIC_VAPID_PUBLIC_KEY",
  "VAPID_PRIVATE_KEY",
  "VAPID_SUBJECT",
  "RESEND_API_KEY",
  "EMAIL_FROM",
];

function fail(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

function readEnvFile(path) {
  if (!existsSync(path)) fail(`${path} not found. Create it from .env.example.`);
  const values = new Map();
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)="(.*)"\s*$/);
    if (match) values.set(match[1], match[2]);
  }
  return values;
}

function readVercelToken() {
  const candidates = [
    join(process.env.APPDATA ?? "", "com.vercel.cli", "Data", "auth.json"),
    join(process.env.APPDATA ?? "", "com.vercel.cli", "auth.json"),
    join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".vercel", "auth.json"),
  ];
  const path = candidates.find((candidate) => candidate && existsSync(candidate));
  if (!path) fail("No Vercel credentials found. Run `vercel login` first.");
  return JSON.parse(readFileSync(path, "utf8")).token;
}

function readProjectId() {
  if (!existsSync(".vercel/project.json")) fail("Not linked to a Vercel project. Run `vercel link`.");
  return JSON.parse(readFileSync(".vercel/project.json", "utf8")).projectId;
}

/** Strip credentials so a URL can be compared/printed safely. */
function host(spec) {
  try {
    return new URL(spec.replace(/^postgres(ql)?:/, "http:")).host;
  } catch {
    return "<unparseable>";
  }
}

const values = readEnvFile(ENV_FILE);
const token = readVercelToken();
const projectId = readProjectId();

async function api(path, init = {}) {
  const response = await fetch(`https://api.vercel.com${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) console.error(`  API ${response.status} on ${path}: ${JSON.stringify(body)?.slice(0, 200)}`);
  return body;
}

const existing = (await api(`/v9/projects/${projectId}/env?decrypt=true`))?.envs ?? [];
const present = new Set();
const existingKeys = new Set();
const existingType = new Map();
const currentValue = new Map();
for (const entry of existing) {
  existingKeys.add(entry.key);
  if (typeof entry.value === "string") currentValue.set(`${entry.key}|${entry.target?.[0]}`, entry.value);
  for (const target of entry.target ?? []) present.add(`${entry.key}|${target}`);
  // The API requires `type` on every write, and defaulting to `encrypted` would silently downgrade
  // a record Vercel holds as `sensitive`. Reuse whatever protection level it already has; prefer
  // production's, since that is the most locked-down environment.
  if (
    entry.type &&
    (!existingType.has(entry.key) || (entry.target ?? []).includes("production"))
  ) {
    existingType.set(entry.key, entry.type);
  }
}

// ---- report ---------------------------------------------------------------

console.log(`\n${"key".padEnd(30)}${TARGETS.map((t) => t.padEnd(14)).join("")}`);
console.log("-".repeat(30 + TARGETS.length * 14));

const missing = new Set();
const toWrite = [];

for (const key of MANAGED) {
  const value = values.get(key)?.trim() ?? "";

  if (EXTERNALLY_MANAGED.has(key)) {
    const onVercel = TARGETS.map((t) => (present.has(`${key}|${t}`) ? "integration" : "absent"));
    const live = currentValue.get(`${key}|production`);
    const drifted = value && live && host(value) !== host(live);
    console.log(key.padEnd(30) + onVercel.map((c) => c.padEnd(14)).join(""));
    if (drifted) {
      console.log(`    note: this file holds ${host(value)}, Vercel uses ${host(live)} — NOT pushed (integration owns it)`);
    }
    continue;
  }

  const cells = TARGETS.map((target) => {
    if (value) return "writing".padEnd(14);
    if (present.has(`${key}|${target}`)) return "on vercel".padEnd(14);
    if (!OPTIONAL.has(key)) missing.add(key);
    return "MISSING".padEnd(14);
  });
  console.log(key.padEnd(30) + cells.join(""));

  if (value) toWrite.push({ key, value });
}

if (missing.size > 0) {
  console.log(`\n  ${missing.size} required key(s) neither set locally nor on Vercel: ${[...missing].join(", ")}`);
  console.log("  Fill them in and run this again.\n");
  process.exit(1);
}

// ---- write ----------------------------------------------------------------

if (toWrite.length === 0) {
  console.log("\n  Nothing to push (every managed key has an empty local value).");
  process.exit(0);
}

console.log(`\n  writing ${toWrite.length} key(s) across ${TARGETS.length} environments…`);
let failures = 0;

for (const { key, value } of toWrite) {
  // Reuse the existing protection level (see existingType above); only brand-new keys get
  // `encrypted`, which is Vercel's normal level for secrets that should still be readable locally.
  const body = {
    key,
    value,
    type: existingType.get(key) ?? "encrypted",
    target: TARGETS,
  };

  const result = await api(`/v10/projects/${projectId}/env?upsert=true`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!result || (!result.key && !result.created)) failures++;
  else console.log(`    ok  ${key}`);
}

if (failures > 0) fail(`${failures} write(s) failed. See the API errors above.`);
console.log("  done.\n");
