// src/components/calendar/CalendarViews.tsx
//
// Day / week / month. All three are pure renderers over `OccurrenceView[]` — no timezone logic here,
// no RRULE logic here. If something looks wrong in a view, the bug is upstream in `loadOccurrenceViews`.

import Link from "next/link";
import { CalendarDays } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { PHASE_CLASSES } from "@/lib/time/status";
import { cn } from "@/components/ui/cn";
import { DateTime } from "luxon";
import { UTC } from "@/lib/time/zone";
import { formatOccurrenceWhen } from "@/lib/time/format";
import type { OccurrenceView } from "@/server/queries";

const HOUR_HEIGHT = 44; // px; keeps a full day readable on a phone without scrolling forever

function startMs(view: OccurrenceView): number {
  return view.when.kind === "allDay" ? 0 : Date.parse(view.when.startUtc);
}

function endMs(view: OccurrenceView): number {
  if (view.when.kind === "allDay") return 0;
  return view.when.endUtc ? Date.parse(view.when.endUtc) : Date.parse(view.when.startUtc) + 30 * 60_000;
}

function eventHref(view: OccurrenceView): string {
  return `/event/${view.eventId}?occ=${encodeURIComponent(view.key)}`;
}

// ────────────────────────────────────────────────────────────── day

export function DayView({
  views,
  dateISO,
  tz,
}: {
  views: OccurrenceView[];
  dateISO: string;
  tz: string;
}) {
  const allDay = views.filter((view) => view.when.kind === "allDay");
  const timed = views.filter((view) => view.when.kind === "timed");

  const dayStart = DateTime.fromISO(dateISO, { zone: tz }).startOf("day");
  const dayStartMs = dayStart.toUTC().toMillis();

  if (views.length === 0) {
    return (
      <EmptyState
        icon={CalendarDays}
        title="Nothing scheduled"
        description="A clear day. Add something with quick-add, or leave it clear."
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {allDay.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {allDay.map((view) => (
            <li key={view.key}>
              <Link
                href={eventHref(view)}
                className="transition-quiet block rounded-lg border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-ink hover:border-primary-400"
              >
                <span className="font-medium">{view.title}</span>
                <span className="ml-2 text-xs text-slate">All day</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}

      {/* Absolute positioning against a real 24-hour axis: this is the day's true shape. */}
      <div
        className="relative rounded-[var(--radius-card)] border border-mist bg-surface"
        style={{ height: 24 * HOUR_HEIGHT }}
      >
        {Array.from({ length: 24 }, (_, hour) => (
          <div
            key={hour}
            className="absolute inset-x-0 border-t border-mist/70"
            style={{ top: hour * HOUR_HEIGHT }}
          >
            <span className="absolute -top-2 left-1 bg-surface px-1 text-[11px] text-slate tabular">
              {String(hour).padStart(2, "0")}:00
            </span>
          </div>
        ))}

        {timed.map((view) => {
          const offsetMinutes = (startMs(view) - dayStartMs) / 60_000;
          const durationMinutes = Math.max(15, (endMs(view) - startMs(view)) / 60_000);
          const top = (offsetMinutes / 60) * HOUR_HEIGHT;
          const height = Math.max(20, (durationMinutes / 60) * HOUR_HEIGHT);

          return (
            <Link
              key={view.key}
              href={eventHref(view)}
              className={cn(
                "transition-quiet absolute right-1 left-12 overflow-hidden rounded-md border px-2 py-1 text-xs hover:shadow-card",
                PHASE_CLASSES[view.phase].chip,
              )}
              style={{ top, height }}
            >
              <span className="block truncate font-medium">{view.title}</span>
              <span className="block truncate text-[11px] text-slate tabular">
                {formatOccurrenceWhen(view.when, view.timezone, tz).text}
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────── week

export function WeekView({
  views,
  days,
  todayISO,
  tz,
}: {
  views: OccurrenceView[];
  days: string[];
  todayISO: string;
  tz: string;
}) {
  const byDay = new Map<string, OccurrenceView[]>(days.map((day) => [day, []]));

  for (const view of views) {
    if (view.when.kind === "allDay") {
      // An all-day block spans dates; it appears on every date it covers.
      for (const day of days) {
        if (day >= view.when.startDate && day < view.when.endDateExclusive) {
          byDay.get(day)?.push(view);
        }
      }
      continue;
    }
    const localDate = DateTime.fromJSDate(new Date(view.when.startUtc), { zone: UTC })
      .setZone(tz)
      .toISODate();
    if (localDate && byDay.has(localDate)) byDay.get(localDate)!.push(view);
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-7">
      {days.map((day) => {
        const items = (byDay.get(day) ?? []).sort((a, b) => startMs(a) - startMs(b));
        const isToday = day === todayISO;
        return (
          <section
            key={day}
            aria-label={DateTime.fromISO(day, { zone: tz }).toFormat("cccc d LLLL")}
            className={cn(
              "rounded-[var(--radius-card)] border p-2",
              isToday ? "border-primary-400 bg-primary-50/50" : "border-mist bg-surface",
            )}
          >
            <h3 className="mb-2 flex items-baseline justify-between text-xs font-semibold text-slate">
              <span>{DateTime.fromISO(day, { zone: tz }).toFormat("ccc")}</span>
              <span className={cn("text-sm", isToday ? "text-primary-600" : "text-ink")}>
                {DateTime.fromISO(day, { zone: tz }).day}
              </span>
            </h3>

            {items.length === 0 ? (
              <p className="text-[11px] text-slate/70">—</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {items.map((view) => (
                  <li key={`${day}:${view.key}`}>
                    <Link
                      href={eventHref(view)}
                      className={cn(
                        "transition-quiet block truncate rounded-md border px-2 py-1 text-[11px]",
                        PHASE_CLASSES[view.phase].chip,
                      )}
                    >
                      {view.when.kind === "allDay" ? (
                        <span className="font-medium">{view.title}</span>
                      ) : (
                        <>
                          <span className="tabular">
                            {DateTime.fromJSDate(new Date(view.when.startUtc), { zone: UTC })
                              .setZone(tz)
                              .toFormat("HH:mm")}
                          </span>{" "}
                          <span className="font-medium">{view.title}</span>
                        </>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

// ────────────────────────────────────────────────────────────── month

export function MonthView({
  views,
  days,
  month,
  todayISO,
  tz,
}: {
  views: OccurrenceView[];
  days: string[];
  month: number;
  todayISO: string;
  tz: string;
}) {
  const byDay = new Map<string, OccurrenceView[]>(days.map((day) => [day, []]));

  for (const view of views) {
    if (view.when.kind === "allDay") {
      for (const day of days) {
        if (day >= view.when.startDate && day < view.when.endDateExclusive) byDay.get(day)?.push(view);
      }
      continue;
    }
    const localDate = DateTime.fromJSDate(new Date(view.when.startUtc), { zone: UTC })
      .setZone(tz)
      .toISODate();
    if (localDate && byDay.has(localDate)) byDay.get(localDate)!.push(view);
  }

  return (
    <Card className="overflow-hidden p-0">
      <div className="grid grid-cols-7 border-b border-mist bg-paper px-1 py-2 text-center text-[11px] font-semibold text-slate">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>
      <ol className="grid grid-cols-7">
        {days.map((day) => {
          const items = (byDay.get(day) ?? []).sort((a, b) => startMs(a) - startMs(b));
          const inMonth = DateTime.fromISO(day, { zone: UTC }).month === month;
          const isToday = day === todayISO;
          return (
            <li
              key={day}
              className={cn(
                "min-h-20 border-r border-b border-mist p-1 last:border-r-0",
                !inMonth && "bg-paper/60",
              )}
            >
              <div className="flex items-baseline justify-between">
                <span
                  className={cn(
                    "inline-flex size-6 items-center justify-center rounded-full text-xs tabular",
                    isToday ? "bg-primary-500 font-semibold text-white" : inMonth ? "text-ink" : "text-slate/60",
                  )}
                >
                  {DateTime.fromISO(day, { zone: UTC }).day}
                </span>
              </div>

              <ul className="mt-1 flex flex-col gap-0.5">
                {items.slice(0, 3).map((view) => (
                  <li key={view.key}>
                    <Link
                      href={eventHref(view)}
                      className={cn(
                        "block truncate rounded px-1 text-[10px] leading-4",
                        PHASE_CLASSES[view.phase].chip,
                      )}
                      title={view.title}
                    >
                      {view.title}
                    </Link>
                  </li>
                ))}
                {items.length > 3 ? (
                  <li className="px-1 text-[10px] text-slate">
                    +{items.length - 3} more
                    <span className="sr-only">
                      {" "}
                      on {DateTime.fromISO(day, { zone: tz }).toFormat("d LLLL")}
                    </span>
                  </li>
                ) : null}
              </ul>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
