// src/lib/reminders/plan.ts
//
// Pure scheduling core. No I/O: given occurrences + rules, decide which Reminder rows must exist
// and what should happen to a due one. Keeping this pure is what lets us prove idempotency and
// quiet-hour behaviour in unit tests instead of hoping.

import { expandOccurrences, occurrenceAnchorUtc, type EventTimeInput, type Occurrence } from "@/lib/time/recurrence";
import { isQuietAt, quietHoursEndUtc, type QuietHoursSettings } from "@/lib/time/quietHours";
import { normalizeOffsets, scheduledFor } from "./offsets";

export interface ReminderRuleInput {
  eventId: string;
  offsetMinutes: number;
  channels: string[];
}

export interface PlannedReminder {
  userId: string;
  eventId: string;
  occurrenceId: string;
  occurrenceStartUtc: Date;
  offsetMinutes: number;
  scheduledFor: Date;
  channels: string[];
  quietOverride: boolean;
}

export interface SeriesInput<T extends EventTimeInput = EventTimeInput> {
  master: T;
  overrides: EventTimeInput[];
}

export interface PlanOptions {
  userId: string;
  window: { fromUtc: Date; toUtc: Date };
  rulesByEventId: Map<string, ReminderRuleInput[]>;
  /** Fallback when an event has no explicit rule: the user's default offsets. */
  defaultOffsets: number[];
  defaultChannels?: string[];
  quietOverride: boolean;
}

/**
 * Plan the Reminder rows that must exist for `window`.
 *
 * Idempotency is structural, not hopeful: the planned identity is
 * (occurrenceId, offsetMinutes, scheduledFor), which is exactly the DB unique key. Running this
 * twice yields the same set, and `createMany({ skipDuplicates: true })` makes the second run a
 * no-op. That is why a doubled or retried cron invocation cannot double-alarm.
 */
export function planReminders<T extends EventTimeInput>(
  series: SeriesInput<T>[],
  options: PlanOptions,
): PlannedReminder[] {
  const { userId, window, rulesByEventId, defaultOffsets, defaultChannels = ["push", "email"], quietOverride } = options;
  const planned: PlannedReminder[] = [];

  for (const { master, overrides } of series) {
    const occurrences = expandOccurrences(master, overrides, window);

    for (const occurrence of occurrences) {
      if (occurrence.cancelled) continue;

      // Rules live on the effective event (an override can carry its own reminders); if the
      // override has none, the series' rules apply — which is what users expect when they nudge
      // one occurrence of a recurring thing.
      const ownRules = rulesByEventId.get(occurrence.effectiveEventId) ?? [];
      const seriesRules = rulesByEventId.get(master.id) ?? [];
      const rules = ownRules.length > 0 ? ownRules : seriesRules;

      const offsets = normalizeOffsets(
        rules.length > 0 ? rules.map((r) => r.offsetMinutes) : defaultOffsets,
      );
      if (offsets.length === 0) continue;

      const channels = rules.length > 0 ? rules[0]!.channels : defaultChannels;
      const anchor = occurrenceAnchorUtc(occurrence, master.timezone);

      for (const offsetMinutes of offsets) {
        const rule = rules.find((r) => r.offsetMinutes === offsetMinutes);
        const due = scheduledFor(anchor, offsetMinutes);

        planned.push({
          userId,
          eventId: occurrence.effectiveEventId,
          occurrenceId: occurrence.key,
          occurrenceStartUtc: anchor,
          offsetMinutes,
          scheduledFor: due,
          channels: rule?.channels ?? channels,
          quietOverride,
        });
      }
    }
  }

  return planned;
}

// ────────────────────────────────────────────────────────────── delivery decision

export type DeliveryDecision =
  | { kind: "deliver"; lateBySeconds: number }
  | { kind: "defer"; until: Date; reason: "quiet-hours" | "dnd" }
  | { kind: "stale"; lateBySeconds: number };

export interface DecideDeliveryInput {
  now: Date;
  scheduledFor: Date;
  quiet: QuietHoursSettings;
  /** "This genuinely cannot be missed." */
  quietOverride: boolean;
  /** Beyond this, an alarm is noise rather than help; we record it as missed instead. */
  staleAfterMinutes?: number;
}

export const DEFAULT_STALE_AFTER_MINUTES = 180;

/** Sanity bound on a deferral, so a mis-typed quiet window cannot push an alarm out by days. */
export const MAX_DEFERRAL_HOURS = 12;

/**
 * The one place that answers "should this alarm fire right now?".
 *
 * Order matters:
 *  1. A per-event override beats quiet hours — deliberately, and only per event.
 *  2. Otherwise quiet hours defer to the *end of the configured window*. Deferral, never
 *     cancellation: the alarm still fires, just at 07:00 instead of 23:30.
 *  3. DND has no scheduled end, so we re-evaluate on a short interval rather than guessing.
 *  4. A very late alarm is recorded as stale rather than fired at 3am for a 9am meeting. The
 *     lateness is still logged honestly.
 *
 * Note that a deferral is NOT a delivery attempt — the caller gives the attempts budget back.
 */
export function decideDelivery({
  now,
  scheduledFor: due,
  quiet,
  quietOverride,
  staleAfterMinutes = DEFAULT_STALE_AFTER_MINUTES,
}: DecideDeliveryInput): DeliveryDecision {
  const lateBySeconds = Math.max(0, Math.round((now.getTime() - due.getTime()) / 1000));

  if (!quietOverride && isQuietAt(quiet, now)) {
    const until = quietHoursEndUtc(quiet, now);
    if (until && until.getTime() > now.getTime()) {
      const cap = now.getTime() + MAX_DEFERRAL_HOURS * 3_600_000;
      return { kind: "defer", until: new Date(Math.min(until.getTime(), cap)), reason: "quiet-hours" };
    }
    // DND with no configured window: re-evaluate on the next tick rather than guessing.
    return { kind: "defer", until: new Date(now.getTime() + 15 * 60_000), reason: "dnd" };
  }

  if (lateBySeconds > staleAfterMinutes * 60) {
    return { kind: "stale", lateBySeconds };
  }

  return { kind: "deliver", lateBySeconds };
}

/** Retry backoff for transient channel failures: 1m, 5m, 15m. */
export const RETRY_BACKOFF_MINUTES = [1, 5, 15];
export const MAX_ATTEMPTS = RETRY_BACKOFF_MINUTES.length + 1;

/** Pure so tests can pin "now". Returns null when the attempts budget is exhausted. */
export function backoffFor(attempts: number, now: Date): Date | null {
  const minutes = RETRY_BACKOFF_MINUTES[attempts - 1];
  if (minutes === undefined) return null;
  return new Date(now.getTime() + minutes * 60_000);
}

// ────────────────────────────────────────────────────────────── settlement

export type SettleOutcome =
  | { status: "sent"; sentAt: Date; lateBySeconds: number | null }
  | { status: "pending"; scheduledFor: Date; lastError: string }
  | { status: "missed"; lastError: string; lateBySeconds: number | null };

export interface SettleInput {
  /** Did at least one channel actually deliver? */
  delivered: boolean;
  attempts: number; // already incremented by the claim
  now: Date;
  lateBySeconds: number | null;
  failureDetail: string;
}

/**
 * The retry policy, in one place: succeed → sent; fail with budget left → pending at a backoff;
 * fail with no budget → missed (recorded, never silent).
 *
 * Note what does NOT happen: a failure never leaves the row in `claimed`, and it never disappears.
 * "Did it actually alarm me?" stays answerable.
 */
export function settleDelivery({ delivered, attempts, now, lateBySeconds, failureDetail }: SettleInput): SettleOutcome {
  if (delivered) {
    return { status: "sent", sentAt: now, lateBySeconds };
  }

  const retryAt = backoffFor(attempts, now);
  if (retryAt) {
    return { status: "pending", scheduledFor: retryAt, lastError: failureDetail };
  }

  return { status: "missed", lastError: failureDetail, lateBySeconds };
}

/** Reminder rows that a given occurrence edit invalidates. Used when an event is edited/deleted. */
export function pendingStatusesForReschedule(): string[] {
  return ["pending", "deferred", "claimed"];
}

export type { Occurrence };
