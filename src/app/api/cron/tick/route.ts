// app/api/cron/tick/route.ts
//
// The scheduled entrypoint. Vercel Cron invokes this every minute with
// `Authorization: Bearer $CRON_SECRET`.
//
// It is intentionally idempotent and safe to invoke concurrently: claiming uses
// `FOR UPDATE SKIP LOCKED`, so two overlapping ticks split the work instead of duplicating it.
// The same property means a manual `curl` here is a safe way to "send my alarms now".

import { NextResponse, type NextRequest } from "next/server";
import { runTick } from "@/lib/reminders/scheduler";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function unauthorized(): NextResponse {
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

async function handle(request: NextRequest) {
  // When CRON_SECRET is configured it is mandatory. Without it we refuse to run in production,
  // because an open tick endpoint is a free denial-of-service on the alarm pipeline.
  if (env.CRON_SECRET) {
    const header = request.headers.get("authorization");
    if (header !== `Bearer ${env.CRON_SECRET}`) return unauthorized();
  } else if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "cron-secret-not-configured" }, { status: 500 });
  }

  const startedAt = Date.now();
  const result = await runTick({ origin: new URL(request.url).origin });

  return NextResponse.json(
    { ...result, durationMs: Date.now() - startedAt },
    { headers: { "cache-control": "no-store" } },
  );
}

export const GET = handle;
export const POST = handle;
