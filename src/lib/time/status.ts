// src/lib/time/status.ts
//
// The visual language of "where am I in the day". Derived, never stored.
// upcoming (calm blue) → imminent (amber) → now (green) → overdue (red) → done (grey).

import type { Occurrence, OccurrenceWhen } from "./recurrence";

export type EventPhase = "upcoming" | "imminent" | "now" | "overdue" | "done";

export interface PhaseInput {
  when: OccurrenceWhen;
  now: Date;
  /** Marked done by the user, or the reminder was acknowledged. */
  done?: boolean;
  /** An event whose end has passed but that was never acknowledged. */
  acknowledged?: boolean;
}

/** How close counts as "imminent" — the window in which the row turns amber. */
export const IMMINENT_MINUTES = 15;

export function phaseOf({ when, now, done }: PhaseInput): EventPhase {
  if (done) return "done";

  if (when.kind === "allDay") {
    // All-day blocks are "now" for the whole of the local date they cover.
    const today = now.toISOString().slice(0, 10);
    const start = when.startDate;
    const endExclusive = when.endDateExclusive;
    if (today >= start && today < endExclusive) return "now";
    return today < start ? "upcoming" : "overdue";
  }

  const start = new Date(when.startUtc).getTime();
  const end = when.endUtc ? new Date(when.endUtc).getTime() : start;
  const t = now.getTime();

  if (t < start) {
    const minutesUntil = (start - t) / 60_000;
    return minutesUntil <= IMMINENT_MINUTES ? "imminent" : "upcoming";
  }
  if (t <= end) return "now";
  return "overdue";
}

/** Tailwind classes for each phase, kept next to the states they describe. */
export const PHASE_CLASSES: Record<EventPhase, { dot: string; text: string; chip: string; label: string }> = {
  upcoming: {
    dot: "bg-status-upcoming",
    text: "text-status-upcoming",
    chip: "bg-primary-50 text-primary-700 border-primary-200",
    label: "Upcoming",
  },
  imminent: {
    dot: "bg-status-imminent",
    text: "text-status-imminent",
    chip: "bg-warn-50 text-warn-500 border-warn-500/30",
    label: "Starting soon",
  },
  now: {
    dot: "bg-status-now",
    text: "text-status-now",
    chip: "bg-success-50 text-success-500 border-success-500/30",
    label: "Happening now",
  },
  overdue: {
    dot: "bg-status-overdue",
    text: "text-status-overdue",
    chip: "bg-danger-50 text-danger-500 border-danger-500/30",
    label: "Missed",
  },
  done: {
    dot: "bg-status-done",
    text: "text-status-done",
    chip: "bg-mist text-slate border-mist",
    label: "Done",
  },
};
