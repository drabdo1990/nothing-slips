// src/lib/time/format.ts
//
// Presentation of time. Two rules that keep this honest:
//  1. Every formatted value ships a screen-reader sentence alongside the visual string, because
//     "14:05" read aloud is useless and a countdown must never be a bare number.
//  2. When the viewer's zone differs from the event's own zone, the zone is LABELLED. Silently
//     rendering a Berlin meeting in the viewer's zone is how people miss meetings.

import { DateTime } from "luxon";
import { zoneAbbreviation, zoneLabel, UTC } from "./zone";
import type { Occurrence, OccurrenceWhen } from "./recurrence";

export interface FormattedTime {
  /** Compact visual string, e.g. "09:00 – 09:30" or "Thu 26 Mar". */
  text: string;
  /** Full sentence for assistive tech, e.g. "Thursday 26 March, 9:00 to 9:30 am, Central European Time". */
  ariaLabel: string;
  /** True when the event's zone differs from the viewer's and has been labelled. */
  crossZone: boolean;
}

function dt(instant: string | Date, tz: string): DateTime {
  return DateTime.fromJSDate(typeof instant === "string" ? new Date(instant) : instant, {
    zone: UTC,
  }).setZone(tz);
}

export function formatTime(instant: string | Date, tz: string): string {
  return dt(instant, tz).toFormat("HH:mm");
}

export function formatTimeWithZone(instant: string | Date, tz: string): string {
  return `${dt(instant, tz).toFormat("HH:mm")} ${zoneAbbreviation(tz, new Date(instant))}`;
}

/**
 * Render an occurrence's time the way the viewer should read it, without ever lying about zones.
 * `viewerTz` is the person looking; `eventTz` is the zone the wall clock was pinned to.
 */
export function formatOccurrenceWhen(when: OccurrenceWhen, eventTz: string, viewerTz: string): FormattedTime {
  const crossZone = eventTz !== viewerTz;

  if (when.kind === "allDay") {
    const start = DateTime.fromISO(when.startDate, { zone: UTC });
    const endInclusive = DateTime.fromISO(when.endDateExclusive, { zone: UTC }).minus({ days: 1 });
    const isMultiDay = when.startDate !== endInclusive.toISODate();
    const text = isMultiDay
      ? `${start.toFormat("d LLL")} – ${endInclusive.toFormat("d LLL")}`
      : "All day";
    const ariaLabel = isMultiDay
      ? `All day, from ${start.toFormat("d LLLL")} through ${endInclusive.toFormat("d LLLL")}`
      : `All day, ${start.toFormat("cccc d LLLL")}`;
    return { text, ariaLabel, crossZone: false }; // date-only values cannot shift, so no zone note
  }

  const start = dt(when.startUtc, viewerTz);
  const end = when.endUtc ? dt(when.endUtc, viewerTz) : null;

  const sameDay = end ? start.hasSame(end, "day") : true;
  let text = end
    ? sameDay
      ? `${start.toFormat("HH:mm")} – ${end.toFormat("HH:mm")}`
      : `${start.toFormat("d LLL HH:mm")} → ${end.toFormat("d LLL HH:mm")}`
    : start.toFormat("HH:mm");

  let ariaLabel = end
    ? `${start.toFormat("cccc d LLLL")}, ${start.toFormat("h:mm a")} to ${
        sameDay ? end.toFormat("h:mm a") : `${end.toFormat("cccc d LLLL")}, ${end.toFormat("h:mm a")}`
      }`
    : `${start.toFormat("cccc d LLLL")}, ${start.toFormat("h:mm a")}`;

  if (crossZone) {
    // e.g. "10:00 – 11:00 (15:00–16:00 Berlin)" — the viewer sees their own time first, plus the
    // event's original wall clock, explicitly labelled.
    const inEventZone = `${dt(when.startUtc, eventTz).toFormat("HH:mm")}${
      when.endUtc ? `–${dt(when.endUtc, eventTz).toFormat("HH:mm")}` : ""
    } ${zoneLabel(eventTz)}`;
    text = `${text} (${inEventZone})`;
    ariaLabel = `${ariaLabel}, your time. Original time ${zoneLabel(eventTz)} ${zoneAbbreviation(
      eventTz,
      new Date(when.startUtc),
    )}`;
  }

  return { text, ariaLabel, crossZone };
}

/** "in 12 min", "in 3 h 5 min", "now", "2 h ago". Always paired with an aria sentence. */
export function formatCountdown(target: Date, now: Date): { text: string; ariaLabel: string } {
  const diffMs = target.getTime() - now.getTime();
  const absMinutes = Math.round(Math.abs(diffMs) / 60_000);

  if (absMinutes < 1) {
    return { text: "now", ariaLabel: "happening now" };
  }

  const text =
    absMinutes < 60
      ? `${absMinutes} min`
      : `${Math.floor(absMinutes / 60)} h ${absMinutes % 60 ? `${absMinutes % 60} min` : ""}`.trim();

  if (diffMs > 0) return { text: `in ${text}`, ariaLabel: `in ${text.replace(" ", " ")}` };
  return { text: `${text} ago`, ariaLabel: `${text} ago` };
}

/**
 * Honest lateness for a delivered alarm. A tick that ran late must say so, not pretend.
 */
export function formatLateness(lateBySeconds: number | null): string {
  if (lateBySeconds === null || lateBySeconds < 45) return "";
  const minutes = Math.round(lateBySeconds / 60);
  if (minutes < 60) return `delivered ${minutes} min late`;
  const hours = Math.floor(minutes / 60);
  return `delivered ${hours} h ${minutes % 60} min late`;
}

/** "Mon 21 Sep" for headers and agenda grouping. */
export function formatDateHeading(dateISO: string, viewerTz: string): string {
  const d = DateTime.fromISO(dateISO, { zone: viewerTz });
  const today = DateTime.now().setZone(viewerTz).toISODate();
  if (dateISO === today) return "Today";
  if (dateISO === DateTime.now().setZone(viewerTz).plus({ days: 1 }).toISODate()) return "Tomorrow";
  if (dateISO === DateTime.now().setZone(viewerTz).minus({ days: 1 }).toISODate()) return "Yesterday";
  return d.toFormat("ccc d LLL");
}

/** Full aria sentence for a date heading. */
export function formatDateHeadingAria(dateISO: string): string {
  return DateTime.fromISO(dateISO, { zone: UTC }).toFormat("cccc d LLLL yyyy");
}

/** Occurrence → the single line the agenda/today list renders. */
export function formatOccurrenceTime(o: Occurrence, viewerTz: string): FormattedTime {
  return formatOccurrenceWhen(o.when, o.event.timezone, viewerTz);
}
