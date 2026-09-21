// app/api/cron/sync-calendars/route.ts
//
// Optional Google Calendar two-way sync. Kept deliberately thin: all real work is behind the
// CalendarSyncProvider interface, so deleting this route + src/lib/sync removes the feature
// without touching scheduling, reminders, or the UI.

import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { runCalendarSync } from "@/lib/sync";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(request: NextRequest) {
  if (env.CRON_SECRET) {
    if (request.headers.get("authorization") !== `Bearer ${env.CRON_SECRET}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  } else if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "cron-secret-not-configured" }, { status: 500 });
  }

  const result = await runCalendarSync();
  return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
}

export const GET = handle;
export const POST = handle;
