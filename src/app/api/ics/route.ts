// app/api/ics/route.ts
//
// ICS export. Series are exported as a single VEVENT with RRULE (not expanded), which is what every
// calendar client expects and keeps the payload small.

import { prisma } from "@/lib/db";
import { getSessionUser } from "@/server/guards";
import { exportIcs, icsEventFromRow } from "@/lib/ics";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const events = await prisma.event.findMany({
    where: { userId: user.id, seriesId: null },
    include: { reminderRules: { orderBy: { offsetMinutes: "desc" } } },
    orderBy: { startUtc: "asc" },
  });

  const body = exportIcs(
    events.map((event) =>
      icsEventFromRow(
        {
          id: event.id,
          title: event.title,
          notes: event.notes,
          location: event.location,
          timezone: event.timezone,
          allDay: event.allDay,
          startUtc: event.startUtc,
          endUtc: event.endUtc,
          startDate: event.startDate,
          endDate: event.endDate,
          rrule: event.rrule,
          exdates: event.exdates,
          seriesId: null,
          recurrenceId: null,
          status: event.status,
        },
        event.reminderRules.map((rule) => rule.offsetMinutes),
      ),
    ),
    `${user.name ?? user.email}'s calendar`,
  );

  return new Response(body, {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      // A stable filename so repeated downloads replace rather than accumulate.
      "content-disposition": `attachment; filename="nothing-slips.ics"`,
      "cache-control": "no-store",
    },
  });
}
