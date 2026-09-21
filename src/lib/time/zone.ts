// src/lib/time/zone.ts
//
// ONE place that converts between UTC instants and IANA wall clocks. Luxon only — never raw
// `Date` arithmetic across a DST boundary.
//
// Why this matters:
//  * Instants are stored UTC. Users think in wall clocks ("9am Thursday, Europe/Berlin").
//    The only correct bridge is an IANA zone, which knows the offset *for that date*.
//  * Luxon resolves DST edge cases deterministically:
//      - Spring-forward GAP (02:30 on the day clocks jump to 03:00): Luxon moves forward to
//        03:30, i.e. the meeting happens at the first existing instant. We accept that; a
//        nonexistent local time cannot be honoured literally.
//      - Fall-back AMBIGUITY (02:30 occurs twice): Luxon chooses the FIRST occurrence (earlier
//        offset). Documented here so nobody "fixes" it later by accident.
//  * Calendar-date arithmetic (adding days to an all-day event) is done on a UTC calendar, which
//    has no offsets at all — so it can never shift by a timezone.

import { DateTime, IANAZone } from "luxon";

export const UTC = "UTC";

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number;
  minute: number;
  second: number;
}

export function isValidIanaZone(tz: string): boolean {
  return IANAZone.isValidZone(tz);
}

/** Throws early rather than silently mis-scheduling a whole calendar. */
export function assertIanaZone(tz: string): string {
  if (!isValidIanaZone(tz)) throw new Error(`Invalid IANA timezone: ${tz}`);
  return tz;
}

/** Wall clock in `tz` → UTC instant. See the DST notes at the top of this file. */
export function localPartsToUtc(parts: LocalParts, tz: string): Date {
  const dt = DateTime.fromObject(
    {
      year: parts.year,
      month: parts.month,
      day: parts.day,
      hour: parts.hour,
      minute: parts.minute,
      second: parts.second,
    },
    { zone: assertIanaZone(tz) },
  );
  if (!dt.isValid) throw new Error(`Could not resolve local time in ${tz}: ${dt.invalidReason}`);
  return dt.toUTC().toJSDate();
}

/** UTC instant → wall clock in `tz`. */
export function utcToLocalParts(instant: Date, tz: string): LocalParts {
  const dt = DateTime.fromJSDate(instant, { zone: UTC }).setZone(assertIanaZone(tz));
  if (!dt.isValid) throw new Error(`Could not render instant in ${tz}`);
  return {
    year: dt.year,
    month: dt.month,
    day: dt.day,
    hour: dt.hour,
    minute: dt.minute,
    second: dt.second,
  };
}

/** "YYYY-MM-DD" for the instant, as seen in `tz`. */
export function localDateString(instant: Date, tz: string): string {
  return DateTime.fromJSDate(instant, { zone: UTC }).setZone(assertIanaZone(tz)).toISODate()!;
}

/** "HH:mm" for the instant, as seen in `tz`. */
export function localTimeString(instant: Date, tz: string): string {
  return DateTime.fromJSDate(instant, { zone: UTC }).setZone(assertIanaZone(tz)).toFormat("HH:mm");
}

/**
 * The value an `<input type="datetime-local">` expects: a wall clock in `tz`, with no offset.
 * This is the *only* place a "naked" local string is allowed to exist, and it never reaches the
 * database — the form converts it straight back through `localPartsToUtc` on submit.
 */
export function toDateTimeLocalValue(instant: Date, tz: string): string {
  return DateTime.fromJSDate(instant, { zone: UTC }).setZone(assertIanaZone(tz)).toFormat("yyyy-MM-dd'T'HH:mm");
}

/** The inverse: an `<input type="datetime-local">` value plus its zone → a real UTC instant. */
export function fromDateTimeLocalValue(value: string, tz: string): Date | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!match) return null;
  return localPartsToUtc(
    {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
      hour: Number(match[4]),
      minute: Number(match[5]),
      second: 0,
    },
    tz,
  );
}

/**
 * Pure calendar-day arithmetic on a "YYYY-MM-DD" string.
 * Uses a UTC calendar purely as a day counter: no offsets involved, so nothing can shift.
 */
export function addDays(dateISO: string, days: number): string {
  const dt = DateTime.fromISO(dateISO, { zone: UTC }).plus({ days });
  if (!dt.isValid) throw new Error(`Invalid date: ${dateISO}`);
  return dt.toISODate()!;
}

/** Whole days between two calendar dates (b - a). */
export function diffDays(aISO: string, bISO: string): number {
  return Math.round(
    DateTime.fromISO(bISO, { zone: UTC }).diff(DateTime.fromISO(aISO, { zone: UTC }), "days").days,
  );
}

/** 1 = Monday … 7 = Sunday. */
export function isoWeekday(dateISO: string): number {
  return DateTime.fromISO(dateISO, { zone: UTC }).weekday;
}

/** [start, end) UTC instants covering the local calendar day `dateISO` in `tz`. */
export function dayWindowUtc(dateISO: string, tz: string): { startUtc: Date; endUtc: Date } {
  return {
    startUtc: localPartsToUtc({ ...dateAtMidnight(dateISO), hour: 0, minute: 0, second: 0 }, tz),
    endUtc: localPartsToUtc({ ...dateAtMidnight(addDays(dateISO, 1)), hour: 0, minute: 0, second: 0 }, tz),
  };
}

/** Monday-anchored week containing `dateISO`. */
export function weekWindowUtc(dateISO: string, tz: string): { startUtc: Date; endUtc: Date; days: string[] } {
  const weekday = isoWeekday(dateISO);
  const monday = addDays(dateISO, -(weekday - 1));
  const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  return {
    startUtc: dayWindowUtc(days[0]!, tz).startUtc,
    endUtc: dayWindowUtc(days[6]!, tz).endUtc,
    days,
  };
}

/** The grid shown by a month view: whole weeks covering the month. */
export function monthGridUtc(year: number, month: number, tz: string): {
  startUtc: Date;
  endUtc: Date;
  days: string[];
} {
  const first = DateTime.fromObject({ year, month, day: 1 }, { zone: UTC });
  const firstOfGrid = addDays(first.toISODate()!, -(first.weekday - 1));
  const lastOfMonth = first.endOf("month");
  const lastOfGrid = addDays(lastOfMonth.toISODate()!, 7 - lastOfMonth.weekday);
  const days: string[] = [];
  for (let d = firstOfGrid; d <= lastOfGrid; d = addDays(d, 1)) days.push(d);
  return {
    startUtc: dayWindowUtc(firstOfGrid, tz).startUtc,
    endUtc: dayWindowUtc(lastOfGrid, tz).endUtc,
    days,
  };
}

export function minutesBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / 60_000;
}

export function nowUtc(): Date {
  return new Date();
}

function dateAtMidnight(dateISO: string): Omit<LocalParts, "hour" | "minute" | "second"> {
  const [y, m, d] = dateISO.split("-").map(Number);
  if (!y || !m || !d) throw new Error(`Invalid date: ${dateISO}`);
  return { year: y, month: m, day: d };
}

/** "CET" / "CEST" / "GMT+2" — used to label a zone when it differs from the viewer's. */
export function zoneAbbreviation(tz: string, at: Date = new Date()): string {
  return DateTime.fromJSDate(at, { zone: UTC }).setZone(assertIanaZone(tz)).toFormat("ZZZZ");
}

/** Short human label for a zone: "Europe/Berlin" → "Berlin". */
export function zoneLabel(tz: string): string {
  return tz === UTC ? "UTC" : (tz.split("/").pop() ?? tz).replace(/_/g, " ");
}
