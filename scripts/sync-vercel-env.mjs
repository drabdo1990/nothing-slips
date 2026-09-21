// scripts/sync-vercel-env.mjs
//
// Pushes every key in .env.deploy.local to the linked Vercel project across all three
// environments, and prints a key x environment matrix so the result is unambiguous.
//
// Why this exists: `vercel env ls` wraps its output in ways that are genuinely ambiguous to parse
// (and `vercel env add KEY preview` can no-op without a useful error), which is how a gap went
// unnoticed the first time. This talks to the API directly and verifies by reading back.
//
// Usage:  node scripts/sync-vercel-env.mjs
// Requires: `vercel login` (it reuses the CLI's stored token).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ENV_FILE = ".env.deploy.local";
const TARGETS = ["production", "preview", "development"];

// Keys we manage. Anything else in the env file is ignored.
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

// AUTH_URL is derived from the deployment, so it is legitimately blank before the first deploy.
const OPTIONAL = new Set(["AUTH_URL"]);

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
  if (!path) fail(`No Vercel credentials found. Run \`vercel login\` first.`);
  return JSON.parse(readFileSync(path, "utf8")).token;
}

function readProjectId() {
  if (!existsSync(".vercel/project.json")) fail("Not linked to a Vercel project. Run `vercel link`.");
  return JSON.parse(readFileSync(".vercel/project.json", "utf8")).projectId;
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
  if (!response.ok) {
    console.error(`  API ${response.status} on ${path}: ${JSON.stringify(body)?.slice(0, 200)}`);
  }
  return body;
}

const existing = (await api(`/v9/projects/${projectId}/env`))?.envs ?? [];
const present = new Set();
for (const entry of existing) {
  for (const target of entry.target ?? []) present.add(`${entry.key}|${target}`);
}

// ---- report ---------------------------------------------------------------

console.log(`\n${"key".padEnd(30)}${TARGETS.map((t) => t.padEnd(14)).join("")}`);
console.log("-".repeat(30 + TARGETS.length * 14));

let missingRequired = new Set();
const toWrite = [];

for (const key of MANAGED) {
  const value = values.get(key)?.trim() ?? "";
  const cells = TARGETS.map((target) => {
    const already = present.has(`${key}|${target}`);
    if (!value) {
      // Count the KEY as missing, not each environment cell — otherwise "3 keys" reports as 9.
      if (!OPTIONAL.has(key)) missingRequired.add(key);
      return "no value".padEnd(14);
    }
    if (!already) toWrite.push({ key, target, value });
    return (already ? "set" : "will set").padEnd(14);
  });
  console.log(key.padEnd(30) + cells.join(""));
}

if (missingRequired.size > 0) {
  console.log(
    `\n  ${missingRequired.size} required key(s) missing from ${ENV_FILE}: ${[...missingRequired].join(", ")}`,
  );
  console.log("  Fill them in and run this again.\n");
  process.exit(1);
}

if (toWrite.length === 0) {
  console.log("\n  Vercel is already in sync with " + ENV_FILE + ".");
  process.exit(0);
}

// ---- write ---------------------------------------------------------------

console.log(`\n  writing ${toWrite.length} value(s)…`);
let failures = 0;

for (const { key, target, value } of toWrite) {
  const result = await api(`/v10/projects/${projectId}/env?upsert=true`, {
    method: "POST",
    body: JSON.stringify({ key, value, type: "encrypted", target: [target] }),
  });
  if (!result || (!result.key && !result.created)) failures++;
}

if (failures > 0) fail(`${failures} write(s) failed. See the API errors above.`);
console.log("  done. Run this again to verify.\n");
