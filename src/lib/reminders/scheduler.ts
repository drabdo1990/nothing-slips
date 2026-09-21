// src/lib/reminders/scheduler.ts
//
// THE TICK. Runs every minute via Vercel Cron → /api/cron/tick. It never assumes it fired on time:
// it sweeps a window, so a tick that is late or skipped still delivers, and says how late.
//
// Sequence, and why in this order:
//   1. materialize  — ensure Reminder rows exist for the rolling window (idempotent by unique key)
//   2. reconcile    — cancel rows that an edit/exdate has invalidated
//   3. expire       — mark long-overdue pending rows as missed (bounded sweep, honest record)
//   4. reclaim      — return rows abandoned by a crashed tick to pending
//   5. claim        — atomically lease due rows (FOR UPDATE SKIP LOCKED)
//   6. deliver      — push → email, decide quiet-hours deferral, settle state, back off failures
//
// Idempotency: steps 1 and 5 cannot double-create or double-claim. Delivery is at-least-once, and a
// duplicate push is collapsed by the OS via the payload `tag`. Exactly-once page-level fan-out is
// deliberately traded for never-missing-an-alarm.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { planReminders, decideDelivery, settleDelivery, MAX_ATTEMPTS, DEFAULT_STALE_AFTER_MINUTES } from "./plan";
import { deliverReminder } from "@/lib/notifications/dispatcher";
import { addDays, localDateString } from "@/lib/time/zone";

export interface TickOptions {
  now?: Date;
  /** How far ahead to materialize occurrences. 45 days bounds work while covering "1 day before". */
  materializeWindowDays?: number;
  /** Look-back for the materialize window, so occurrences currently running are covered. */
  materializeLookbackDays?: number;
  claimLimit?: number;
  staleAfterMinutes?: number;
  leaseSeconds?: number;
  origin?: string;
  /** Restrict the tick to one user (dev / manual "send my alarms now"). */
  userId?: string;
}

export interface TickResult {
  materialized: number;
  reconciled: number;
  expired: number;
  reclaimed: number;
  claimed: number;
  sent: number;
  deferred: number;
  stale: number;
  retried: number;
  missed: number;
  errors: string[];
}

const defaults = {
  materializeWindowDays: 45,
  materializeLookbackDays: 7,
  claimLimit: 200,
  staleAfterMinutes: DEFAULT_STALE_AFTER_MINUTES,
  leaseSeconds: 120,
};

export async function runTick(options: TickOptions = {}): Promise<TickResult> {
  const now = options.now ?? new Date();
  const staleAfterMinutes = options.staleAfterMinutes ?? defaults.staleAfterMinutes;
  const origin = options.origin ?? env.AUTH_URL ?? "http://localhost:3000";

  const result: TickResult = {
    materialized: 0,
    reconciled: 0,
    expired: 0,
    reclaimed: 0,
    claimed: 0,
    sent: 0,
    deferred: 0,
    stale: 0,
    retried: 0,
    missed: 0,
    errors: [],
  };

  // ── 1 + 2. materialize and reconcile ───────────────────────────────────────
  try {
    const materialized = await materializeReminders({
      now,
      windowDays: options.materializeWindowDays ?? defaults.materializeWindowDays,
      lookbackDays: options.materializeLookbackDays ?? defaults.materializeLookbackDays,
      userId: options.userId,
    });
    result.materialized = materialized.created;
    result.reconciled = materialized.cancelled;
  } catch (error) {
    result.errors.push(`materialize: ${describe(error)}`);
  }

  // ── 3. expire long-overdue pending rows ────────────────────────────────────
  const expiryCutoff = new Date(now.getTime() - staleAfterMinutes * 60_000);
  try {
    const expired = await prisma.reminder.findMany({
      where: { status: { in: ["pending", "deferred"] }, scheduledFor: { lte: expiryCutoff } },
      select: { id: true, userId: true, lateBySeconds: true, scheduledFor: true },
      take: 500,
    });
    if (expired.length > 0) {
      await prisma.$transaction([
        prisma.reminder.updateMany({
          where: { id: { in: expired.map((r) => r.id) } },
          data: { status: "missed", lastError: "window-expired", claimToken: null, claimedAt: null },
        }),
        prisma.notificationLog.createMany({
          data: expired.map((r) => ({
            userId: r.userId,
            reminderId: r.id,
            channel: "none",
            result: "skipped",
            detail: "expired-before-delivery",
            lateBySeconds: Math.round((now.getTime() - r.scheduledFor.getTime()) / 1000),
          })),
        }),
      ]);
      result.expired = expired.length;
    }
  } catch (error) {
    result.errors.push(`expire: ${describe(error)}`);
  }

  // ── 4. reclaim abandoned leases ────────────────────────────────────────────
  const leaseCutoff = new Date(now.getTime() - (options.leaseSeconds ?? defaults.leaseSeconds) * 1000);
  try {
    const reclaimed = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      UPDATE reminders
         SET status = 'pending'::"ReminderStatus",
             "claimToken" = NULL,
             "claimedAt" = NULL,
             "updatedAt" = ${now}
       WHERE status = 'claimed'::"ReminderStatus"
         AND "claimedAt" < ${leaseCutoff}
         AND attempts < ${MAX_ATTEMPTS}
      RETURNING id
    `);
    result.reclaimed = reclaimed.length;

    // A lease that expired with no attempts left is genuinely lost.
    await prisma.reminder.updateMany({
      where: { status: "claimed", claimedAt: { lt: leaseCutoff }, attempts: { gte: MAX_ATTEMPTS } },
      data: { status: "missed", lastError: "lease-expired" },
    });
  } catch (error) {
    result.errors.push(`reclaim: ${describe(error)}`);
  }

  // ── 5. claim due rows atomically ───────────────────────────────────────────
  const claimToken = globalThis.crypto.randomUUID();
  const claimCutoff = new Date(now.getTime() - staleAfterMinutes * 60_000);

  let claimed: { id: string }[] = [];
  try {
    claimed = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      WITH due AS (
        SELECT id
          FROM reminders
         WHERE status = 'pending'::"ReminderStatus"
           AND "scheduledFor" <= ${now}
           AND "scheduledFor" > ${claimCutoff}
         ORDER BY "scheduledFor" ASC
         LIMIT ${options.claimLimit ?? defaults.claimLimit}
         FOR UPDATE SKIP LOCKED
      )
      UPDATE reminders r
         SET status = 'claimed'::"ReminderStatus",
             "claimToken" = ${claimToken},
             "claimedAt" = ${now},
             attempts = r.attempts + 1,
             "updatedAt" = ${now}
        FROM due
       WHERE r.id = due.id
      RETURNING r.id
    `);
    result.claimed = claimed.length;
  } catch (error) {
    result.errors.push(`claim: ${describe(error)}`);
    return result;
  }

  // ── 6. deliver each claimed reminder ───────────────────────────────────────
  for (const { id } of claimed) {
    try {
      const outcome = await deliverOne(id, { now, origin, staleAfterMinutes });
      if (outcome === "sent") result.sent++;
      else if (outcome === "deferred") result.deferred++;
      else if (outcome === "stale") result.stale++;
      else if (outcome === "retried") result.retried++;
      else if (outcome === "missed") result.missed++;
    } catch (error) {
      result.errors.push(`deliver ${id}: ${describe(error)}`);
    }
  }

  return result;
}

type DeliverOneOutcome = "sent" | "deferred" | "stale" | "retried" | "missed" | "noop";

async function deliverOne(
  reminderId: string,
  ctx: { now: Date; origin: string; staleAfterMinutes: number },
): Promise<DeliverOneOutcome> {
  const reminder = await prisma.reminder.findUnique({
    where: { id: reminderId },
    include: { event: true, user: true },
  });
  if (!reminder) return "noop";
  // Another worker settled it between claim and now — nothing to do.
  if (reminder.status !== "claimed") return "noop";

  const decision = decideDelivery({
    now: ctx.now,
    scheduledFor: reminder.scheduledFor,
    quiet: {
      timezone: reminder.user.timezone,
      quietHoursEnabled: reminder.user.quietHoursEnabled,
      quietHoursStart: reminder.user.quietHoursStart,
      quietHoursEnd: reminder.user.quietHoursEnd,
      dnd: reminder.user.dnd,
    },
    quietOverride: reminder.quietOverride,
    staleAfterMinutes: ctx.staleAfterMinutes,
  });

  if (decision.kind === "defer") {
    // Deferral: the alarm is not dropped, it moves — and the reason is recorded.
    // Crucially, a deferral is not a delivery attempt, so we hand the attempt budget back.
    const conflict = await prisma.reminder.findUnique({
      where: {
        occurrenceId_offsetMinutes_scheduledFor: {
          occurrenceId: reminder.occurrenceId,
          offsetMinutes: reminder.offsetMinutes,
          scheduledFor: decision.until,
        },
      },
      select: { id: true },
    });

    await prisma.$transaction([
      prisma.reminder.update({
        where: { id: reminder.id },
        data: conflict
          ? { status: "cancelled", lastError: `duplicate-deferral:${decision.reason}`, claimToken: null, claimedAt: null }
          : {
              status: "deferred",
              scheduledFor: decision.until,
              attempts: { decrement: 1 },
              claimToken: null,
              claimedAt: null,
              lastError: `deferred:${decision.reason}`,
            },
      }),
      prisma.notificationLog.create({
        data: {
          userId: reminder.userId,
          reminderId: reminder.id,
          channel: "none",
          result: "skipped",
          detail: `deferred:${decision.reason}`,
        },
      }),
    ]);
    return "deferred";
  }

  if (decision.kind === "stale") {
    await prisma.$transaction([
      prisma.reminder.update({
        where: { id: reminder.id },
        data: {
          status: "missed",
          lastError: "stale-beyond-window",
          lateBySeconds: decision.lateBySeconds,
          claimToken: null,
          claimedAt: null,
        },
      }),
      prisma.notificationLog.create({
        data: {
          userId: reminder.userId,
          reminderId: reminder.id,
          channel: "none",
          result: "skipped",
          detail: "stale-beyond-window",
          lateBySeconds: decision.lateBySeconds,
        },
      }),
    ]);
    return "stale";
  }

  const subscriptions = await prisma.pushSubscription.findMany({
    where: { userId: reminder.userId, disabled: false },
    select: { id: true, endpoint: true, p256dh: true, auth: true },
  });

  const outcome = await deliverReminder({
    reminder: {
      reminderId: reminder.id,
      occurrenceId: reminder.occurrenceId,
      eventId: reminder.eventId,
      offsetMinutes: reminder.offsetMinutes,
      channels: reminder.channels,
      lateBySeconds: decision.lateBySeconds,
      occurrenceStartUtc: reminder.occurrenceStartUtc,
    },
    event: reminder.event,
    user: {
      id: reminder.user.id,
      email: reminder.user.email,
      timezone: reminder.user.timezone,
      emailFallbackEnabled: reminder.user.emailFallbackEnabled,
    },
    subscriptions,
    origin: ctx.origin,
  });

  // Retire push subscriptions the push service says are dead.
  if (outcome.disableSubscriptionIds.length > 0) {
    await prisma.pushSubscription.updateMany({
      where: { id: { in: outcome.disableSubscriptionIds } },
      data: { disabled: true },
    });
  }

  const logRows = outcome.attempts.map((attempt) => ({
    userId: reminder.userId,
    reminderId: reminder.id,
    channel: attempt.channel,
    result: attempt.ok ? "sent" : "failed",
    detail: attempt.detail,
    lateBySeconds: decision.lateBySeconds,
  }));

  const failureDetail = outcome.attempts.map((a) => a.detail).join(",") || "no-delivery-channel";

  // The retry/give-up policy lives in one pure function so it can be reasoned about and tested.
  const settled = settleDelivery({
    delivered: outcome.delivered,
    attempts: reminder.attempts,
    now: ctx.now,
    lateBySeconds: decision.lateBySeconds,
    failureDetail,
  });

  const clearedLease = { claimToken: null, claimedAt: null } as const;

  if (settled.status === "sent") {
    await prisma.$transaction([
      prisma.reminder.update({
        where: { id: reminder.id },
        data: {
          status: "sent",
          sentAt: settled.sentAt,
          lateBySeconds: settled.lateBySeconds,
          lastError: null,
          ...clearedLease,
        },
      }),
      ...(logRows.length > 0 ? [prisma.notificationLog.createMany({ data: logRows })] : []),
    ]);
    return "sent";
  }

  if (settled.status === "pending") {
    await prisma.$transaction([
      prisma.reminder.update({
        where: { id: reminder.id },
        data: {
          status: "pending",
          scheduledFor: settled.scheduledFor,
          lastError: settled.lastError,
          ...clearedLease,
        },
      }),
      prisma.notificationLog.createMany({
        data:
          logRows.length > 0
            ? logRows
            : [
                {
                  userId: reminder.userId,
                  reminderId: reminder.id,
                  channel: "none",
                  result: "failed",
                  detail: "no-delivery-channel",
                },
              ],
      }),
    ]);
    return "retried";
  }

  await prisma.$transaction([
    prisma.reminder.update({
      where: { id: reminder.id },
      data: {
        status: "missed",
        lastError: settled.lastError,
        lateBySeconds: settled.lateBySeconds,
        ...clearedLease,
      },
    }),
    ...(logRows.length > 0 ? [prisma.notificationLog.createMany({ data: logRows })] : []),
  ]);
  return "missed";
}

// ────────────────────────────────────────────────────────────── materialize

export interface MaterializeInput {
  now: Date;
  windowDays: number;
  lookbackDays: number;
  userId?: string;
}

export interface MaterializeResult {
  created: number;
  cancelled: number;
}

/**
 * Ensure Reminder rows exist for every occurrence whose reminders fall inside the rolling window.
 * Bounded work: only series/starts that can intersect the window are loaded, and occurrences are
 * expanded on demand — the infinite series is never materialized.
 */
export async function materializeReminders(input: MaterializeInput): Promise<MaterializeResult> {
  const { now, windowDays, lookbackDays, userId } = input;
  const fromUtc = new Date(now.getTime() - lookbackDays * 86_400_000);
  const toUtc = new Date(now.getTime() + windowDays * 86_400_000);
  // All-day events are matched on calendar dates in the user's zone; a one-day pad on each side
  // absorbs zone differences (the exact filter happens in expandOccurrences).
  const fromDate = addDays(localDateString(fromUtc, "UTC"), -1);
  const toDate = addDays(localDateString(toUtc, "UTC"), 1);

  const masters = await prisma.event.findMany({
    where: {
      seriesId: null,
      status: "confirmed",
      ...(userId ? { userId } : {}),
      OR: [
        { rrule: { not: null } },
        {
          allDay: false,
          startUtc: { gte: new Date(fromUtc.getTime() - 31 * 86_400_000), lt: toUtc },
        },
        { allDay: true, startDate: { gte: addDays(fromDate, -31), lt: toDate } },
      ],
    },
    include: {
      reminderRules: true,
      overrides: { include: { reminderRules: true } },
    },
  });

  if (masters.length === 0) return { created: 0, cancelled: 0 };

  const ownerIds = [...new Set(masters.map((m) => m.userId))];
  const owners = await prisma.user.findMany({
    where: { id: { in: ownerIds } },
    select: { id: true, defaultReminderOffsets: true },
  });
  const ownersById = new Map(owners.map((o) => [o.id, o]));

  const rulesByEventId = new Map<string, { eventId: string; offsetMinutes: number; channels: string[] }[]>();
  for (const master of masters) {
    rulesByEventId.set(master.id, master.reminderRules);
    for (const override of master.overrides) {
      rulesByEventId.set(override.id, override.reminderRules);
    }
  }

  const planned: ReturnType<typeof planReminders> = [];
  for (const master of masters) {
    const owner = ownersById.get(master.userId);
    if (!owner) continue;

    planned.push(
      ...planReminders([{ master, overrides: master.overrides }], {
        userId: master.userId,
        window: { fromUtc, toUtc },
        rulesByEventId,
        defaultOffsets: owner.defaultReminderOffsets,
        quietOverride: master.overrideQuietHours,
      }),
    );
  }

  // Filter to reminders that are actually due within the window (the "1 day before" offset can pull
  // an occurrence in even when the occurrence itself sits just outside it).
  const due = planned.filter((p) => p.scheduledFor >= fromUtc && p.scheduledFor <= toUtc);

  let created = 0;
  if (due.length > 0) {
    // skipDuplicates + the unique key = the idempotency guarantee. A re-run inserts nothing.
    const written = await prisma.reminder.createMany({
      data: due.map((p) => ({
        userId: p.userId,
        eventId: p.eventId,
        occurrenceId: p.occurrenceId,
        occurrenceStartUtc: p.occurrenceStartUtc,
        offsetMinutes: p.offsetMinutes,
        scheduledFor: p.scheduledFor,
        channels: p.channels,
        quietOverride: p.quietOverride,
        status: "pending" as const,
      })),
      skipDuplicates: true,
    });
    created = written.count;
  }

  // Reconciliation: an EXDATE, an edit, an offset change or a series split can invalidate rows that
  // already exist. A row's identity IS (event, occurrence, offset, due) — so anything in the window
  // that is not in the planned set is stale by definition. This is cheap: the window is bounded.
  const plannedIdentity = new Set(
    due.map(
      (p) => `${p.eventId}|${p.occurrenceId}|${p.offsetMinutes}|${p.scheduledFor.toISOString()}`,
    ),
  );

  const watchedEventIds = masters.flatMap((m) => [m.id, ...m.overrides.map((o) => o.id)]);
  const existing = await prisma.reminder.findMany({
    where: {
      eventId: { in: watchedEventIds },
      status: { in: ["pending", "deferred"] },
      scheduledFor: { gte: fromUtc, lte: toUtc },
    },
    select: { id: true, eventId: true, occurrenceId: true, offsetMinutes: true, scheduledFor: true },
  });

  const toCancel = existing.filter(
    (row) =>
      !plannedIdentity.has(
        `${row.eventId}|${row.occurrenceId}|${row.offsetMinutes}|${row.scheduledFor.toISOString()}`,
      ),
  );

  if (toCancel.length > 0) {
    await prisma.reminder.updateMany({
      where: { id: { in: toCancel.map((r) => r.id) } },
      data: { status: "cancelled", lastError: "occurrence-changed", claimToken: null, claimedAt: null },
    });
  }

  return { created, cancelled: toCancel.length };
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
