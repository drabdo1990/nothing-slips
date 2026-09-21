// app/calendar/page.tsx

import { requireUser } from "@/server/guards";
import { prisma } from "@/lib/db";
import { loadOccurrenceViews } from "@/server/queries";
import { addDays, dayWindowUtc, localDateString, monthGridUtc, weekWindowUtc } from "@/lib/time/zone";
import { DateTime } from "luxon";
import { CalendarToolbar, type CalendarViewName } from "@/components/calendar/CalendarToolbar";
import { DayView, MonthView, WeekView } from "@/components/calendar/CalendarViews";
import { QuickAdd } from "@/components/event/QuickAdd";

export const dynamic = "force-dynamic";

const VIEWS: CalendarViewName[] = ["day", "week", "month"];

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; date?: string }>;
}) {
  const user = await requireUser();
  const params = await searchParams;

  const settings = await prisma.user.findUniqueOrThrow({
    where: { id: user.id },
    select: { timezone: true },
  });
  const tz = settings.timezone;
  const now = new Date();
  const todayISO = localDateString(now, tz);

  const view: CalendarViewName = VIEWS.includes(params.view as CalendarViewName)
    ? (params.view as CalendarViewName)
    : "day";
  const anchorISO = /^\d{4}-\d{2}-\d{2}$/.test(params.date ?? "") ? params.date! : todayISO;

  // Each view asks for exactly the window it renders — never a whole month "just in case".
  const dayW = view === "day" ? dayWindowUtc(anchorISO, tz) : null;
  const weekW = view === "week" ? weekWindowUtc(anchorISO, tz) : null;
  const monthW =
    view === "month"
      ? monthGridUtc(DateTime.fromISO(anchorISO, { zone: tz }).year, DateTime.fromISO(anchorISO, { zone: tz }).month, tz)
      : null;

  const window = dayW ?? weekW ?? monthW!;
  // Day and week views need the explicit day list; a single day is its own list.
  const days = weekW?.days ?? monthW?.days ?? [anchorISO];

  const views = await loadOccurrenceViews(
    user.id,
    { fromUtc: window.startUtc, toUtc: window.endUtc },
    now,
  );

  const anchorDate = DateTime.fromISO(anchorISO, { zone: tz });
  const title =
    view === "day"
      ? anchorDate.toFormat("cccc d LLLL yyyy")
      : view === "week"
        ? `Week of ${DateTime.fromISO(days[0]!, { zone: tz }).toFormat("d LLL")}`
        : anchorDate.toFormat("LLLL yyyy");

  const previousISO =
    view === "day"
      ? addDays(anchorISO, -1)
      : view === "week"
        ? addDays(anchorISO, -7)
        : addDays(anchorISO, -30);
  const nextISO =
    view === "day" ? addDays(anchorISO, 1) : view === "week" ? addDays(anchorISO, 7) : addDays(anchorISO, 30);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold text-ink">Calendar</h1>

      <CalendarToolbar
        view={view}
        anchorISO={anchorISO}
        previousISO={previousISO}
        nextISO={nextISO}
        todayISO={todayISO}
        title={title}
      />

      {view === "day" ? (
        <DayView views={views} dateISO={anchorISO} tz={tz} />
      ) : view === "week" ? (
        <WeekView views={views} days={days} todayISO={todayISO} tz={tz} />
      ) : (
        <MonthView
          views={views}
          days={days}
          month={anchorDate.month}
          todayISO={todayISO}
          tz={tz}
        />
      )}

      <div className="border-t border-mist pt-4">
        <QuickAdd />
      </div>
    </div>
  );
}
