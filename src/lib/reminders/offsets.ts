// src/lib/reminders/offsets.ts
//
// Reminder offsets are minutes-before-start. Everything that creates, renders or validates an
// offset goes through this file so the vocabulary never diverges.

export const MINUTE = 1;
export const HOUR = 60;
export const DAY = 1440;

export interface OffsetPreset {
  minutes: number;
  label: string;
}

/** The presets offered in the UI. Anything else is still valid via the numeric field. */
export const OFFSET_PRESETS: OffsetPreset[] = [
  { minutes: 1 * DAY, label: "1 day before" },
  { minutes: 2 * HOUR, label: "2 hours before" },
  { minutes: 1 * HOUR, label: "1 hour before" },
  { minutes: 30, label: "30 min before" },
  { minutes: 10, label: "10 min before" },
  { minutes: 5, label: "5 min before" },
  { minutes: 0, label: "At start time" },
];

export const MAX_OFFSET_MINUTES = 60 * 24 * 30; // 30 days
export const MAX_REMINDERS_PER_EVENT = 5;

export function isValidOffset(minutes: number): boolean {
  return Number.isInteger(minutes) && minutes >= 0 && minutes <= MAX_OFFSET_MINUTES;
}

/** "10 min before" / "1 day before" / "At start time". */
export function humanizeOffset(minutes: number): string {
  const preset = OFFSET_PRESETS.find((p) => p.minutes === minutes);
  if (preset) return preset.label;
  if (minutes === 0) return "At start time";
  if (minutes % DAY === 0) return `${minutes / DAY} day${minutes / DAY === 1 ? "" : "s"} before`;
  if (minutes % HOUR === 0) return `${minutes / HOUR} hour${minutes / HOUR === 1 ? "" : "s"} before`;
  return `${minutes} min before`;
}

/** "10 min" — compact form for chips and notification bodies. */
export function shortOffset(minutes: number): string {
  if (minutes === 0) return "now";
  if (minutes % DAY === 0) return `${minutes / DAY}d`;
  if (minutes % HOUR === 0) return `${minutes / HOUR}h`;
  return `${minutes}m`;
}

/**
 * Parses "1d", "2h", "30m", "45", "1d 2h" into minutes. Accepts what people actually type.
 */
export function parseOffset(input: string): number | null {
  const text = input.trim().toLowerCase();
  if (!text) return null;
  if (text === "at start" || text === "now") return 0;

  let total = 0;
  let matched = false;
  const re = /(\d+)\s*(d|day|days|h|hr|hrs|hour|hours|m|min|mins|minute|minutes)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const value = Number(m[1]);
    const unit = m[2];
    if (!unit) {
      total += value; // bare number = minutes
    } else if (unit.startsWith("d")) {
      total += value * DAY;
    } else if (unit.startsWith("h")) {
      total += value * HOUR;
    } else {
      total += value;
    }
    matched = true;
  }
  if (!matched) return null;
  return isValidOffset(total) ? total : null;
}

/** Deduplicate + sort descending (largest lead time first, as users read them). */
export function normalizeOffsets(offsets: number[]): number[] {
  return [...new Set(offsets.filter(isValidOffset))]
    .sort((a, b) => b - a)
    .slice(0, MAX_REMINDERS_PER_EVENT);
}

/**
 * Snooze durations offered on an alarm. Lives here (not in the server action module) because a
 * `"use server"` file may only export async functions — the UI cannot import a constant from it.
 */
export const SNOOZE_PRESETS = [5, 10, 15, 60] as const;

/**
 * The instant a reminder is due: the occurrence anchor minus the offset.
 * Pure subtraction on real instants — safe, because both sides are UTC epochs and the offset is a
 * *duration*, not a wall-clock time. (Interval arithmetic across DST is exactly right; it is
 * wall-clock arithmetic that is dangerous.)
 */
export function scheduledFor(anchorUtc: Date, offsetMinutes: number): Date {
  return new Date(anchorUtc.getTime() - offsetMinutes * 60_000);
}
