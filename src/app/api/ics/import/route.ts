// app/api/ics/import/route.ts
//
// ICS import. Imports as a PREVIEW by default (`?commit=false`), because importing a calendar
// silently is exactly the kind of thing that ruins trust in a scheduling app.

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getSessionUser } from "@/server/guards";
import { importIcs } from "@/lib/ics";
import { materializeReminders } from "@/lib/reminders/scheduler";
import { localDateString } from "@/lib/time/zone";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  ics: z.string().min(1).max(5_000_000),
  commit: z.boolean().default(false),
});

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: "invalid-body" }, { status: 400 });

  const settings = await prisma.user.findUniqueOrThrow({
    where: { id: user.id },
    select: { timezone: true, defaultReminderOffsets: true },
  });

  const imported = importIcs(parsed.data.ics, settings.timezone);
  // Guardrail: a malformed or hostile file should not enqueue unbounded work.
  const usable = imported
    .filter((event) => event.startDate !== null || event.startUtc !== null)
    .slice(0, 2000);

  const preview = usable.slice(0, 25).map((event) => ({
    title: event.title,
    allDay: event.allDay,
    start: event.allDay
      ? event.startDate
      : localDateString(event.startUtc!, settings.timezone),
    rrule: event.rrule,
    location: event.location,
  }));

  if (!parsed.data.commit) {
    return NextResponse.json({ ok: true, count: usable.length, preview });
  }

  let created = 0;
  for (const event of usable) {
    const row = await prisma.event.create({
      data: {
        userId: user.id,
        title: event.title,
        notes: event.notes,
        location: event.location,
        allDay: event.allDay,
        timezone: event.timezone,
        startUtc: event.startUtc,
        endUtc: event.endUtc,
        startDate: event.startDate,
        endDate: event.endDate,
        rrule: event.rrule,
        exdates: event.exdates,
      },
    });

    if (settings.defaultReminderOffsets.length > 0) {
      await prisma.reminderRule.createMany({
        data: settings.defaultReminderOffsets.map((offsetMinutes) => ({
          userId: user.id,
          eventId: row.id,
          offsetMinutes,
          channels: ["push", "email"],
        })),
        skipDuplicates: true,
      });
    }
    created++;
  }

  await materializeReminders({ now: new Date(), windowDays: 45, lookbackDays: 1, userId: user.id });

  return NextResponse.json({ ok: true, count: created, preview });
}
