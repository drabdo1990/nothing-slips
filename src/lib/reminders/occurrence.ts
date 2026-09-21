// src/lib/reminders/occurrence.ts
//
// Rebuilds an occurrence's *time* from a materialized Reminder row.
//
// Why not just read the event? Because the event row holds the SERIES' first start, not this
// occurrence's. The Reminder already stores `occurrenceStartUtc` — the single authoritative value —
// so we reconstruct from it and take only the *duration/shape* from the event. This is what keeps a
// recurring 09:00 meeting rendering as 09:00 on the 8th week, not the 1st week.

import type { EventTimeInput, OccurrenceWhen } from "@/lib/time/recurrence";
import { allDaySpanDays, durationMs } from "@/lib/time/recurrence";
import { addDays, localDateString } from "@/lib/time/zone";

export interface ReminderTimeSource {
  occurrenceStartUtc: Date;
}

export function whenForReminder(reminder: ReminderTimeSource, event: EventTimeInput): OccurrenceWhen {
  if (event.allDay) {
    const startDate = localDateString(reminder.occurrenceStartUtc, event.timezone);
    return {
      kind: "allDay",
      startDate,
      endDateExclusive: addDays(startDate, allDaySpanDays(event)),
    };
  }

  const span = durationMs(event) ?? 0;
  return {
    kind: "timed",
    startUtc: reminder.occurrenceStartUtc.toISOString(),
    endUtc: new Date(reminder.occurrenceStartUtc.getTime() + span).toISOString(),
  };
}
