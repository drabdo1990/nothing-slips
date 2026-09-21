// src/server/actions/reminders.ts
//
// Snooze and acknowledge. Both are STATE TRANSITIONS on rows, not client-side timers.
//
// Snooze is modelled exactly as the brief's state machine describes: the original row becomes
// `snoozed` (terminal, and therefore visible in the audit trail), and a NEW pending row carries the
// rescheduled work. "Snooze reschedules rather than silently dropping."

"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { assertOwnsReminder, requireUser } from "@/server/guards";

export type ActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; errors: Record<string, string> };

const snoozeSchema = z.object({
  reminderId: z.string().cuid(),
  minutes: z.number().int().min(1).max(24 * 60),
});

/**
 * Reschedule a fired (or pending) alarm.
 *
 * The original row is terminal `snoozed`; the new row is `pending` with a future `scheduledFor`.
 * Because the idempotency key includes `scheduledFor`, the rescheduled row has its own identity —
 * and because we cancel any other future row for the same occurrence+offset first, a double tap on
 * "Snooze 10 min" cannot produce two alarms.
 */
export async function snoozeReminder(raw: unknown): Promise<ActionResult<{ reminderId: string; scheduledFor: string }>> {
  const user = await requireUser();
  const parsed = snoozeSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: { _: "Invalid snooze duration" } };
  const { reminderId, minutes } = parsed.data;

  await assertOwnsReminder(user.id, reminderId);

  const reminder = await prisma.reminder.findUniqueOrThrow({ where: { id: reminderId } });
  const now = new Date();
  const until = new Date(now.getTime() + minutes * 60_000);

  const created = await prisma.$transaction(async (tx) => {
    await tx.reminder.update({
      where: { id: reminderId },
      data: {
        status: "snoozed",
        snoozedUntil: until,
        acknowledgedAt: now,
        claimToken: null,
        claimedAt: null,
      },
    });

    // Any other unresolved reschedule for this occurrence+offset is superseded, not stacked.
    await tx.reminder.updateMany({
      where: {
        userId: user.id,
        occurrenceId: reminder.occurrenceId,
        offsetMinutes: reminder.offsetMinutes,
        id: { not: reminderId },
        status: { in: ["pending", "deferred", "claimed"] },
      },
      data: { status: "cancelled", lastError: "superseded-by-snooze", claimToken: null, claimedAt: null },
    });

    const rescheduled = await tx.reminder.create({
      data: {
        userId: reminder.userId,
        eventId: reminder.eventId,
        occurrenceId: reminder.occurrenceId,
        occurrenceStartUtc: reminder.occurrenceStartUtc,
        offsetMinutes: reminder.offsetMinutes,
        scheduledFor: until,
        channels: reminder.channels,
        // A snooze is an explicit user action, so it outranks quiet hours from here on: the user
        // said "remind me", not "remind me unless it is late".
        quietOverride: true,
        status: "pending",
      },
    });

    await tx.notificationLog.create({
      data: {
        userId: user.id,
        reminderId,
        channel: "none",
        result: "skipped",
        detail: `snoozed:${minutes}m`,
      },
    });

    return rescheduled;
  });

  revalidatePath("/");
  return { ok: true, data: { reminderId: created.id, scheduledFor: until.toISOString() } };
}

/** "Got it" on one reminder. */
export async function acknowledgeReminder(reminderId: string): Promise<ActionResult> {
  const user = await requireUser();
  await assertOwnsReminder(user.id, reminderId);

  await prisma.reminder.update({
    where: { id: reminderId },
    data: { status: "acknowledged", acknowledgedAt: new Date(), claimToken: null, claimedAt: null },
  });

  revalidatePath("/");
  return { ok: true, data: undefined };
}

const occurrenceDoneSchema = z.object({
  occurrenceKey: z.string().min(1),
  eventId: z.string().cuid(),
});

/**
 * "Done" for a whole occurrence — the user attended the thing.
 *
 * If the occurrence has no reminders at all, we still create a row, because the Reminder table is
 * the single ledger for "did this actually happen / was it acknowledged". Making it answerable from
 * data is the entire point.
 */
export async function markOccurrenceDone(raw: unknown): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = occurrenceDoneSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: { _: "Invalid occurrence" } };
  const { occurrenceKey, eventId } = parsed.data;

  const event = await prisma.event.findFirst({
    where: { id: eventId, userId: user.id },
    select: { id: true, timezone: true, allDay: true, startUtc: true, startDate: true },
  });
  if (!event) return { ok: false, errors: { _: "That event no longer exists" } };

  const now = new Date();
  const existing = await prisma.reminder.findMany({
    where: { userId: user.id, occurrenceId: occurrenceKey },
    select: { id: true, occurrenceStartUtc: true },
  });

  if (existing.length > 0) {
    await prisma.reminder.updateMany({
      where: { id: { in: existing.map((r) => r.id) } },
      data: { status: "acknowledged", acknowledgedAt: now, claimToken: null, claimedAt: null },
    });
  } else {
    // Anchor at the occurrence itself. For a recurring series this is derived from the key.
    const fromKey = occurrenceKey.includes("#") ? occurrenceKey.split("#")[1] : null;
    const anchor = fromKey ? new Date(fromKey) : (event.startUtc ?? new Date());
    await prisma.reminder.create({
      data: {
        userId: user.id,
        eventId: event.id,
        occurrenceId: occurrenceKey,
        occurrenceStartUtc: anchor,
        offsetMinutes: 0,
        scheduledFor: anchor,
        channels: [],
        status: "acknowledged",
        acknowledgedAt: now,
      },
    });
  }

  revalidatePath("/");
  revalidatePath("/agenda");
  return { ok: true, data: undefined };
}

/** "Got it" for everything currently firing — one tap to clear the alarm stack. */
export async function acknowledgeAllDue(): Promise<ActionResult<{ acknowledged: number }>> {
  const user = await requireUser();
  const now = new Date();

  const result = await prisma.reminder.updateMany({
    where: {
      userId: user.id,
      status: { in: ["pending", "deferred", "claimed", "sent"] },
      scheduledFor: { lte: now },
      acknowledgedAt: null,
    },
    data: { status: "acknowledged", acknowledgedAt: now, claimToken: null, claimedAt: null },
  });

  revalidatePath("/");
  return { ok: true, data: { acknowledged: result.count } };
}
