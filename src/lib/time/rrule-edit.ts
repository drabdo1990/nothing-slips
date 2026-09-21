// src/lib/time/rrule-edit.ts
//
// Series surgery: "this and future" is implemented by CAPPING the existing series with UNTIL and
// creating a new master from that occurrence onward. That keeps a single, honest model — no
// phantom "recurrence exceptions" table, no duplicate alarms.
//
// THE SUBTLE BIT: recurrence.ts expands RRULEs in a "fake-UTC" frame — the DTSTART we hand rrule
// carries a trailing Z, but its components are the series' WALL CLOCK (see that file). Therefore
// UNTIL must also be expressed in that same fake-UTC wall-clock frame, not as a real instant.
// Getting this wrong silently drops or duplicates an occurrence, so it lives in one function.

import { utcToLocalParts } from "./zone";

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

function toBasicUtc(date: Date): string {
  return (
    `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

export interface OccurrenceMarker {
  /** True when the occurrence is a calendar date rather than an instant. */
  allDay: boolean;
  /** Real UTC instant for timed occurrences. */
  startUtc: Date | null;
  /** "YYYY-MM-DD" for all-day occurrences. */
  startDate: string | null;
  /** The series' IANA zone: the wall clock UNTIL must be expressed in. */
  timezone: string;
}

/** The fake-UTC wall clock of an occurrence — the frame rrule works in. */
export function occurrenceWallClockFakeUtc(marker: OccurrenceMarker): Date {
  if (marker.allDay) {
    const [y, m, d] = (marker.startDate ?? "1970-01-01").split("-").map(Number);
    return new Date(Date.UTC(y!, m! - 1, d!, 0, 0, 0));
  }
  if (!marker.startUtc) throw new Error("Timed occurrence marker needs startUtc");
  const parts = utcToLocalParts(marker.startUtc, marker.timezone);
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second));
}

/** Removes any existing UNTIL/COUNT so a rule can be re-capped cleanly. */
export function stripTerminators(rrule: string): string {
  return rrule
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .filter((part) => !/^(UNTIL|COUNT)=/i.test(part))
    .join(";");
}

/**
 * Cap a series so it ends immediately BEFORE `marker`'s occurrence.
 * One second before is enough: rrule compares instants, and our expansion has second resolution.
 */
export function capSeriesUntil(rrule: string, marker: OccurrenceMarker): string {
  const wallClock = occurrenceWallClockFakeUtc(marker);
  const until = new Date(wallClock.getTime() - 1000);
  return `${stripTerminators(rrule)};UNTIL=${toBasicUtc(until)}`;
}

/**
 * "This and future" — the new series starts at the occurrence, so its own start becomes the new
 * DTSTART (via the event row) and it keeps the original cadence.
 */
export function newSeriesFrom(rrule: string): string {
  return stripTerminators(rrule);
}

/** True when the rule already ends on its own (UNTIL or COUNT). */
export function isBoundedRule(rrule: string): boolean {
  return /(^|;)(UNTIL|COUNT)=/i.test(rrule);
}

/**
 * Milliseconds-order comparison helper used by the edit actions to decide which overrides belong to
 * the tail being replaced by a split.
 */
export function isAfterOccurrence(
  candidate: OccurrenceMarker,
  boundary: OccurrenceMarker,
): boolean {
  return occurrenceWallClockFakeUtc(candidate).getTime() >= occurrenceWallClockFakeUtc(boundary).getTime();
}
