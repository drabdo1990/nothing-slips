// app/api/reminders/active/route.ts
//
// The in-app alert feed. The browser polls this; it does NOT decide when to alarm.
//
// That inversion is the point: whether something is due is a property of a row's state on the
// server, so an in-tab reminder survives a refresh, a second tab, a laptop waking from sleep, and a
// clock that has drifted. `setTimeout` never appears in this app's scheduling path.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionUser } from "@/server/guards";
import { formatOccurrenceWhen } from "@/lib/time/format";
import { humanizeOffset } from "@/lib/reminders/offsets";
import { whenForReminder } from "@/lib/reminders/occurrence";
import { zoneLabel } from "@/lib/time/zone";
import type { ActiveAlert, ActiveAlertsResponse } from "@/lib/reminders/alert";

export const dynamic = "force-dynamic";

/** How far back an unresolved reminder stays on screen. */
const LOOKBACK_MINUTES = 45;

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const settings = await prisma.user.findUnique({
    where: { id: user.id },
    select: { timezone: true },
  });
  if (!settings) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const now = new Date();
  const since = new Date(now.getTime() - LOOKBACK_MINUTES * 60_000);

  const reminders = await prisma.reminder.findMany({
    where: {
      userId: user.id,
      // Only reminders that have actually come due and are not resolved.
      scheduledFor: { lte: now, gte: since },
      acknowledgedAt: null,
      status: { in: ["pending", "claimed", "sent", "deferred"] },
    },
    include: { event: true },
    orderBy: { scheduledFor: "asc" },
    take: 5,
  });

  const alerts: ActiveAlert[] = reminders.map((reminder) => {
    const when = whenForReminder(reminder, reminder.event);
    const formatted = formatOccurrenceWhen(when, reminder.event.timezone, settings.timezone);
    const crossZone =
      reminder.event.timezone !== settings.timezone ? ` (${zoneLabel(reminder.event.timezone)})` : "";
    const lateBySeconds =
      reminder.sentAt && reminder.lateBySeconds !== null
        ? reminder.lateBySeconds
        : Math.max(0, Math.round((now.getTime() - reminder.scheduledFor.getTime()) / 1000));

    return {
      reminderId: reminder.id,
      occurrenceKey: reminder.occurrenceId,
      eventId: reminder.eventId,
      title: reminder.event.title,
      body: `${formatted.text}${crossZone}`,
      ariaLabel: `${humanizeOffset(reminder.offsetMinutes)}: ${reminder.event.title}, ${formatted.ariaLabel}`,
      url: `/event/${reminder.eventId}?r=${reminder.id}`,
      offsetLabel: humanizeOffset(reminder.offsetMinutes),
      status: reminder.status,
      dueAt: reminder.scheduledFor.toISOString(),
      lateBySeconds,
      canSnooze: true,
    };
  });

  return NextResponse.json(
    { alerts, serverTime: now.toISOString(), timezone: settings.timezone } satisfies ActiveAlertsResponse,
    { headers: { "cache-control": "no-store" } },
  );
}
