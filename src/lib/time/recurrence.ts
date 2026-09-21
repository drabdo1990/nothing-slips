// src/lib/time/recurrence.ts
//
// Series → occurrences. This is the only place RRULEs are interpreted.
//
// KEY IDEA — "floating local expansion":
//   An RRULE describes a *wall clock* ("every Thursday at 09:00"), not a UTC instant. If we
//   expanded it in UTC, a weekly 09:00 Berlin meeting would silently become 10:00 after the
//   spring DST change. So:
//     1. Read the series' wall clock in its OWN IANA zone.
//     2. Expand with rrule using a fake-UTC DTSTART whose UTC components equal that wall clock
//        (rrule's documented behaviour when DTSTART carries a trailing "Z").
//     3. Reinterpret each result's UTC components as wall clock and convert to a real instant
//        through Luxon. DST is therefore handled by Luxon, per date.
//
// All-day events never touch instants at all: they are expanded as calendar dates, so they can
// never shift by a timezone.

import { DateTime } from "luxon";
import { rrulestr } from "rrule";
import {
  addDays,
  assertIanaZone,
  dayWindowUtc,
  localPartsToUtc,
  utcToLocalParts,
  UTC,
  type LocalParts,
} from "./zone";

/** Structural input — Prisma's `Event` satisfies this, and tests can pass plain objects. */
export interface EventTimeInput {
  id: string;
  timezone: string; // IANA
  allDay: boolean;
  startUtc: Date | null;
  endUtc: Date | null;
  startDate: string | null; // YYYY-MM-DD
  endDate: string | null; // YYYY-MM-DD, EXCLUSIVE
  rrule: string | null;
  exdates: string[];
  seriesId: string | null;
  recurrenceId: string | null;
  status: "confirmed" | "cancelled";
}

export type OccurrenceWhen =
  | { kind: "timed"; startUtc: string; endUtc: string | null }
  | { kind: "allDay"; startDate: string; endDateExclusive: string };

export interface Occurrence<T extends EventTimeInput = EventTimeInput> {
  /** Reminder identity. Stable across re-materialization; this is the idempotency anchor. */
  key: string;
  /** The series master (or the standalone event). Reminders are always stamped with this root. */
  rootEventId: string;
  /** The row whose fields apply: the override row when one exists, else the master. */
  effectiveEventId: string;
  isOverride: boolean;
  /** Identity of the ORIGINAL occurrence: UTC ISO for timed, YYYY-MM-DD for all-day. */
  originalStart: string;
  cancelled: boolean;
  when: OccurrenceWhen;
  event: T;
}

export interface Window {
  /** Inclusive UTC instant. */
  fromUtc: Date;
  /** Exclusive UTC instant. */
  toUtc: Date;
}

/** Guardrail: a pathological rule must not lock up a request or a cron tick. */
export const MAX_OCCURRENCES_PER_SERIES = 1000;

export function occurrenceKey(rootEventId: string, originalStart: string | null): string {
  return originalStart === null ? `evt_${rootEventId}` : `evt_${rootEventId}#${originalStart}`;
}

/** Identity of an event's own first occurrence. */
export function originalStartOf(event: EventTimeInput): string | null {
  if (event.allDay) return event.startDate;
  return event.startUtc ? event.startUtc.toISOString() : null;
}

/** Human-free duration in ms; used for override/occurrence rendering. */
export function durationMs(event: EventTimeInput): number | null {
  if (event.allDay) return null;
  if (!event.startUtc || !event.endUtc) return null;
  return event.endUtc.getTime() - event.startUtc.getTime();
}

export function allDaySpanDays(event: EventTimeInput): number {
  if (!event.startDate || !event.endDate) return 1;
  const start = DateTime.fromISO(event.startDate, { zone: UTC });
  const end = DateTime.fromISO(event.endDate, { zone: UTC });
  return Math.max(1, Math.round(end.diff(start, "days").days));
}

// ────────────────────────────────────────────────────────────── expansion

interface RawOccurrence {
  originalStart: string;
  when: OccurrenceWhen;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

function basicStamp(parts: LocalParts): string {
  return (
    `${pad(parts.year, 4)}${pad(parts.month)}${pad(parts.day)}` +
    `T${pad(parts.hour)}${pad(parts.minute)}${pad(parts.second)}`
  );
}

/** rrule requires DTSTART inline; the event row owns the start, so we always override it. */
function stripDtstart(rule: string): string {
  return rule
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.toUpperCase().startsWith("DTSTART"))
    .map((line) => (line.toUpperCase().startsWith("RRULE:") ? line : `RRULE:${line}`))
    .join("\n");
}

function fakeUtcDate(dateISO: string, h = 0, m = 0, s = 0): Date {
  const [y, mo, d] = dateISO.split("-").map(Number);
  return new Date(Date.UTC(y!, mo! - 1, d!, h, m, s));
}

function fakeUtcToDate(d: Date): string {
  return DateTime.fromJSDate(d, { zone: UTC }).toISODate()!;
}

/**
 * Expand the master series into raw occurrences overlapping `window`.
 * Bounds are computed in the series' own wall clock and padded by 2 days so that DST offsets and
 * multi-day events near the edges are never dropped; the caller filters precisely afterwards.
 */
function expandMaster(master: EventTimeInput, window: Window): RawOccurrence[] {
  const tz = assertIanaZone(master.timezone);

  if (!master.rrule) {
    const originalStart = originalStartOf(master);
    if (!originalStart) return [];
    return [{ originalStart, when: whenFor(master) }];
  }

  const rule = rrulestr(`DTSTART:${basicStamp(wallClockParts(master))}Z\n${stripDtstart(master.rrule)}`);

  const fromLocal = utcToLocalParts(window.fromUtc, tz);
  const toLocal = utcToLocalParts(window.toUtc, tz);
  const lo = fakeUtcDate(
    DateTime.fromObject({ year: fromLocal.year, month: fromLocal.month, day: fromLocal.day }, { zone: UTC }).toISODate()!,
  );
  const hi = fakeUtcDate(addDays(
    DateTime.fromObject({ year: toLocal.year, month: toLocal.month, day: toLocal.day }, { zone: UTC }).toISODate()!,
    2,
  ), 23, 59, 59);

  const candidates = rule.between(lo, hi, true);
  const out: RawOccurrence[] = [];

  for (const candidate of candidates.slice(0, MAX_OCCURRENCES_PER_SERIES)) {
    if (master.allDay) {
      const startDate = fakeUtcToDate(candidate);
      out.push({
        originalStart: startDate,
        when: { kind: "allDay", startDate, endDateExclusive: addDays(startDate, allDaySpanDays(master)) },
      });
      continue;
    }

    // Candidate's UTC components ARE the series' wall clock; convert through the series zone.
    const local: LocalParts = {
      year: candidate.getUTCFullYear(),
      month: candidate.getUTCMonth() + 1,
      day: candidate.getUTCDate(),
      hour: candidate.getUTCHours(),
      minute: candidate.getUTCMinutes(),
      second: candidate.getUTCSeconds(),
    };
    const startUtc = localPartsToUtc(local, tz);
    const span = durationMs(master) ?? 0;
    out.push({
      originalStart: startUtc.toISOString(),
      when: {
        kind: "timed",
        startUtc: startUtc.toISOString(),
        endUtc: new Date(startUtc.getTime() + span).toISOString(),
      },
    });
  }

  return out;
}

function wallClockParts(event: EventTimeInput): LocalParts {
  if (event.allDay && event.startDate) {
    const [y, m, d] = event.startDate.split("-").map(Number);
    return { year: y!, month: m!, day: d!, hour: 0, minute: 0, second: 0 };
  }
  if (!event.startUtc) throw new Error(`Event ${event.id} has no start`);
  return utcToLocalParts(event.startUtc, event.timezone);
}

function whenFor(event: EventTimeInput): OccurrenceWhen {
  if (event.allDay) {
    if (!event.startDate) throw new Error(`All-day event ${event.id} has no startDate`);
    return {
      kind: "allDay",
      startDate: event.startDate,
      endDateExclusive: event.endDate ?? addDays(event.startDate, 1),
    };
  }
  if (!event.startUtc) throw new Error(`Timed event ${event.id} has no startUtc`);
  return {
    kind: "timed",
    startUtc: event.startUtc.toISOString(),
    endUtc: event.endUtc ? event.endUtc.toISOString() : null,
  };
}

function overlaps(when: OccurrenceWhen, window: Window, tz: string): boolean {
  if (when.kind === "allDay") {
    const fromDate = DateTime.fromJSDate(window.fromUtc, { zone: UTC }).setZone(tz).toISODate()!;
    const toDate = DateTime.fromJSDate(window.toUtc, { zone: UTC }).setZone(tz).toISODate()!;
    // Exclusive end dates, so `<=` on start and `>` on end is the correct half-open comparison.
    return when.startDate <= toDate && when.endDateExclusive > fromDate;
  }
  const start = new Date(when.startUtc).getTime();
  const end = when.endUtc ? new Date(when.endUtc).getTime() : start;
  return end >= window.fromUtc.getTime() && start < window.toUtc.getTime();
}

export interface ExpandOptions {
  /** Include occurrences that were cancelled/overridden-away. Default false. */
  includeCancelled?: boolean;
}

/**
 * Public entry point.
 *
 * `master`   — a row with seriesId === null (standalone event or series master).
 * `overrides`— rows with seriesId === master.id (per-occurrence edits / cancellations).
 */
export function expandOccurrences<T extends EventTimeInput>(
  master: T,
  overrides: EventTimeInput[],
  window: Window,
  options: ExpandOptions = {},
): Occurrence<T>[] {
  const tz = assertIanaZone(master.timezone);
  const exdates = new Set(master.exdates);
  const overrideByOriginal = new Map<string, EventTimeInput>();
  for (const o of overrides) {
    if (o.recurrenceId) overrideByOriginal.set(o.recurrenceId, o);
  }

  const occurrences: Occurrence<T>[] = [];
  const consumed = new Set<string>();

  for (const raw of expandMaster(master, window)) {
    // "Delete this occurrence" is an EXDATE on the master.
    if (exdates.has(raw.originalStart)) continue;

    const override = overrideByOriginal.get(raw.originalStart);
    if (override) {
      consumed.add(override.id);
      if (override.status === "cancelled") {
        if (options.includeCancelled) {
          occurrences.push(buildOccurrence(master, null, raw.originalStart, whenFor(override), true));
        }
        continue;
      }
      occurrences.push(buildOccurrence(master, override as T, raw.originalStart, whenFor(override), true));
      continue;
    }

    if (!overlaps(raw.when, window, tz)) continue;
    occurrences.push(buildOccurrence(master, null, raw.originalStart, raw.when, false));
  }

  // An override may have been MOVED into this window from outside it, so it is not covered by the
  // master expansion above. Add any leftover override that lands here.
  for (const o of overrides) {
    if (consumed.has(o.id) || !o.recurrenceId) continue;
    if (o.status === "cancelled" && !options.includeCancelled) continue;
    const when = whenFor(o);
    if (!overlaps(when, window, tz)) continue;
    occurrences.push(
      buildOccurrence(master, o as T, o.recurrenceId, when, o.status === "cancelled"),
    );
  }

  return occurrences.sort((a, b) => startSortKey(a) - startSortKey(b));
}

function buildOccurrence<T extends EventTimeInput>(
  master: T,
  override: T | null,
  originalStart: string,
  when: OccurrenceWhen,
  cancelled: boolean,
): Occurrence<T> {
  const isRecurring = master.rrule !== null;
  return {
    key: occurrenceKey(master.id, isRecurring ? originalStart : null),
    rootEventId: master.id,
    effectiveEventId: override?.id ?? master.id,
    isOverride: override !== null,
    originalStart,
    cancelled,
    when,
    event: (override ?? master) as T,
  };
}

/** Ordering key: all-day first (they represent the whole day), then by instant. */
export function startSortKey(o: Occurrence): number {
  if (o.when.kind === "allDay") return DateTime.fromISO(o.when.startDate, { zone: UTC }).toMillis() - 1;
  return new Date(o.when.startUtc).getTime();
}

/**
 * The UTC instant an occurrence is anchored to, used to schedule reminders.
 * Timed events anchor to their start. All-day events have no instant of their own, so they anchor
 * to *local midnight on that date in the event's zone* — which is what "remind me the day before"
 * means in practice, and stays correct across DST.
 */
export function occurrenceAnchorUtc(o: Occurrence, viewerTz: string): Date {
  if (o.when.kind === "timed") return new Date(o.when.startUtc);
  const tz = o.event.timezone || viewerTz;
  return dayWindowUtc(o.when.startDate, tz).startUtc;
}

/** Occurrences that are not cancelled and start at or after `from`. */
export function upcoming(occurrences: Occurrence[], from: Date): Occurrence[] {
  return occurrences.filter((o) => !o.cancelled && startSortKey(o) >= from.getTime());
}

export { UTC };
