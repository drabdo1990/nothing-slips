// src/lib/conflicts.ts
//
// Conflict detection, surfaced at creation time — not discovered afterwards.
//
// Everything here works on half-open UTC intervals [start, end), which is the only representation
// that cannot lie. All-day events are converted to real intervals by the caller (using the event's
// own zone), so a "whole day" block collides correctly with a 10:00 meeting.

export interface BusyBlock {
  id: string;
  title: string;
  startUtc: Date;
  /** Exclusive. Equal to startUtc for zero-length blocks. */
  endUtc: Date;
  /** Minutes of travel/transition the user wants before this block. */
  bufferBeforeMinutes: number;
  location?: string | null;
}

export type ConflictKind = "overlap" | "no-travel-time";

export interface Conflict {
  kind: ConflictKind;
  withId: string;
  withTitle: string;
  overlapMinutes: number;
  /** Set for "no-travel-time": the gap the user actually has before the other block. */
  gapMinutes?: number;
}

/** [start, end) with the buffer folded in — the window that is genuinely unavailable. */
function effectiveStart(block: BusyBlock): number {
  return block.startUtc.getTime() - block.bufferBeforeMinutes * 60_000;
}

function overlaps(a: BusyBlock, b: BusyBlock): number {
  const start = Math.max(effectiveStart(a), effectiveStart(b));
  const end = Math.min(a.endUtc.getTime(), b.endUtc.getTime());
  return end - start;
}

/**
 * `candidate` is the thing being created/edited; `others` is the same day's agenda (plus a
 * generous margin). Returns conflicts ordered by severity.
 */
export function detectConflicts(candidate: BusyBlock, others: BusyBlock[]): Conflict[] {
  const conflicts: Conflict[] = [];

  for (const other of others) {
    if (other.id === candidate.id) continue;

    const overlapMs = overlaps(candidate, other);
    if (overlapMs > 0) {
      conflicts.push({
        kind: "overlap",
        withId: other.id,
        withTitle: other.title,
        overlapMinutes: Math.round(overlapMs / 60_000),
      });
      continue;
    }

    // Back-to-back with a location but no travel time is the quiet failure mode this app exists to
    // catch: two meetings across town, zero minutes between them.
    const gapMs = Math.min(
      Math.abs(other.startUtc.getTime() - candidate.endUtc.getTime()),
      Math.abs(candidate.startUtc.getTime() - other.endUtc.getTime()),
    );

    if (
      candidate.bufferBeforeMinutes > 0 &&
      gapMs >= 0 &&
      gapMs < candidate.bufferBeforeMinutes * 60_000 &&
      candidate.location
    ) {
      conflicts.push({
        kind: "no-travel-time",
        withId: other.id,
        withTitle: other.title,
        overlapMinutes: 0,
        gapMinutes: Math.round(gapMs / 60_000),
      });
    }
  }

  return conflicts.sort((a, b) => (b.kind === "overlap" ? 1 : 0) - (a.kind === "overlap" ? 1 : 0));
}

export function describeConflict(conflict: Conflict): string {
  if (conflict.kind === "overlap") {
    return `Overlaps “${conflict.withTitle}” by ${conflict.overlapMinutes} min`;
  }
  return `Only ${conflict.gapMinutes} min before “${conflict.withTitle}” — no time to travel`;
}

/**
 * The day's real shape: merged busy intervals plus the free gaps between them, so the UI can show
 * back-to-back blocks and genuine free time rather than a wall of boxes.
 */
export interface DayShape {
  busy: { startUtc: Date; endUtc: Date }[];
  free: { startUtc: Date; endUtc: Date; minutes: number }[];
  busyMinutes: number;
  backToBackCount: number;
}

export function shapeOfDay(
  blocks: BusyBlock[],
  window: { startUtc: Date; endUtc: Date },
  minimumFreeMinutes = 15,
): DayShape {
  const sorted = [...blocks].sort((a, b) => a.startUtc.getTime() - b.startUtc.getTime());
  const busy: { startUtc: Date; endUtc: Date }[] = [];
  let backToBackCount = 0;

  for (const block of sorted) {
    const last = busy.at(-1);
    if (last && block.startUtc.getTime() <= last.endUtc.getTime()) {
      if (block.startUtc.getTime() === last.endUtc.getTime()) backToBackCount++;
      last.endUtc = new Date(Math.max(last.endUtc.getTime(), block.endUtc.getTime()));
    } else {
      busy.push({ startUtc: block.startUtc, endUtc: block.endUtc });
    }
  }

  const free: DayShape["free"] = [];
  let cursor = window.startUtc;
  for (const interval of busy) {
    if (interval.startUtc.getTime() - cursor.getTime() >= minimumFreeMinutes * 60_000) {
      free.push({
        startUtc: cursor,
        endUtc: interval.startUtc,
        minutes: Math.round((interval.startUtc.getTime() - cursor.getTime()) / 60_000),
      });
    }
    cursor = new Date(Math.max(cursor.getTime(), interval.endUtc.getTime()));
  }
  if (window.endUtc.getTime() - cursor.getTime() >= minimumFreeMinutes * 60_000) {
    free.push({
      startUtc: cursor,
      endUtc: window.endUtc,
      minutes: Math.round((window.endUtc.getTime() - cursor.getTime()) / 60_000),
    });
  }

  const busyMinutes = busy.reduce(
    (total, interval) => total + Math.round((interval.endUtc.getTime() - interval.startUtc.getTime()) / 60_000),
    0,
  );

  return { busy, free, busyMinutes, backToBackCount };
}
