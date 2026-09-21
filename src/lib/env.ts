// src/lib/env.ts
//
// Fail fast and loudly rather than mid-alarm — but only for what the current entrypoint actually
// needs. The scheduler (`npm run tick`) and the seed script are legitimate entrypoints that never
// touch authentication, so they must not be forced to fake an AUTH_SECRET to run.

import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  AUTH_URL: z.string().url().optional(),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default("Nothing Slips <alarms@example.com>"),
  NEXT_PUBLIC_VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default("mailto:alarms@example.com"),
  CRON_SECRET: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment configuration → ${issues}`);
  }
  return parsed.data;
}

export const env = load();

/**
 * The session secret, validated at the point of use rather than at import.
 *
 * Auth.js is imported by nearly every route, so in the web app this still fails fast — the error
 * just surfaces on the first authenticated request instead of on process boot. In exchange,
 * `prisma/seed.ts` and `scripts/tick.ts` no longer require a secret they have no use for.
 */
export function requireAuthSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error(
      "AUTH_SECRET is required for authentication and must be at least 16 characters. See .env.example.",
    );
  }
  return secret;
}

/** Push is optional infrastructure: absent keys mean "email-only", not "broken app". */
export function pushConfigured(): boolean {
  return Boolean(env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
}

export function emailConfigured(): boolean {
  return Boolean(env.RESEND_API_KEY);
}

export function googleSyncConfigured(): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}
