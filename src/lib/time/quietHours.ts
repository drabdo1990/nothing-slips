// src/lib/time/quietHours.ts
//
// Quiet hours are stored as LOCAL WALL-CLOCK strings ("22:00"/"07:00") plus the user's IANA zone.
// Storing them that way means they keep meaning 10pm across a DST change. The evaluation happens
// per tick, against a real instant.
//
// Quiet hours are a *deferral*, not a cancellation: the alarm still fires, at the moment quiet
// hours end — unless the event sets `overrideQuietHours`, because some things cannot be missed.

import { addDays, assertIanaZone, localPartsToUtc, utcToLocalParts } from "./zone";

export interface QuietHoursSettings {
  timezone: string; // IANA
  quietHoursEnabled: boolean;
  quietHoursStart: string; // "HH:mm"
  quietHoursEnd: string; // "HH:mm"
  dnd: boolean;
}

export const QUIET_OFFSET_OVERRIDABLE = true;

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  if (h === undefined || m === undefined || Number.isNaN(h) || Number.isNaN(m)) {
    throw new Error(`Invalid quiet-hours time: ${hhmm}`);
  }
  return h * 60 + m;
}

/**
 * Is the user inside quiet hours at this instant?
 * A window whose end is before its start wraps midnight (22:00 → 07:00), which is the common case.
 */
export function isQuietAt(settings: QuietHoursSettings, atUtc: Date): boolean {
  if (settings.dnd) return true; // do-not-disturb is an unconditional mute
  if (!settings.quietHoursEnabled) return false;

  const tz = assertIanaZone(settings.timezone);
  const local = utcToLocalParts(atUtc, tz);
  const minutes = local.hour * 60 + local.minute;

  const start = toMinutes(settings.quietHoursStart);
  const end = toMinutes(settings.quietHoursEnd);

  if (start === end) return false; // degenerate config = "no quiet window"
  if (start > end) return minutes >= start || minutes < end; // wraps midnight
  return minutes >= start && minutes < end;
}

/**
 * When quiet hours end for a reminder firing at `atUtc`, as a UTC instant — or null when there is
 * no *scheduled* end. This is what makes deferral correct: the caller re-schedules to this instant.
 *
 * DND deliberately returns null: it is a mute with no end, so the caller re-evaluates on a short
 * interval instead of guessing a wake-up time. Quiet hours, by contrast, do end — at a wall clock
 * the user configured, which is why the result is built in the user's zone.
 */
export function quietHoursEndUtc(settings: QuietHoursSettings, atUtc: Date): Date | null {
  if (settings.dnd) return null;
  if (!settings.quietHoursEnabled) return null;
  if (!isQuietAt(settings, atUtc)) return null;

  const tz = assertIanaZone(settings.timezone);
  const local = utcToLocalParts(atUtc, tz);
  const minutes = local.hour * 60 + local.minute;
  const start = toMinutes(settings.quietHoursStart);
  const end = toMinutes(settings.quietHoursEnd);
  const wraps = start > end;

  const localDate = `${local.year}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")}`;
  // If the window wraps and we are past its start, the end lands tomorrow.
  const endDate = wraps && minutes >= start ? addDays(localDate, 1) : localDate;
  const [endHour, endMinute] = settings.quietHoursEnd.split(":").map(Number);
  const [y, mo, d] = endDate.split("-").map(Number);

  // Built as a wall clock in the user's zone, so a DST change inside the window is handled.
  return localPartsToUtc(
    { year: y!, month: mo!, day: d!, hour: endHour!, minute: endMinute!, second: 0 },
    tz,
  );
}

export function formatQuietHours(settings: QuietHoursSettings): string {
  if (settings.dnd) return "Do not disturb — all alarms deferred";
  if (!settings.quietHoursEnabled) return "Off";
  return `${settings.quietHoursStart} – ${settings.quietHoursEnd} (${settings.timezone})`;
}
