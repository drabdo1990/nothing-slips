// src/server/actions/events.ts
//
// Event CRUD, with the three scopes the brief requires.
//
//   "this"          → an override row (seriesId + recurrenceId); the series is untouched
//   "thisAndFuture" → cap the series with UNTIL, then create a NEW master from that occurrence
//   "series"        → edit the master (or its root, if we were handed an override)
//
// Two invariants hold in every path below:
//   * authorization is re-derived from the session, never from the payload
//   * reminder rows for touched occurrences are cancelled, and the scheduler rematerializes them —
//     so an edit can never leave a stale alarm pointing at the old time

"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireUser } from "@/server/guards";
import {
  eventInputSchema,
  scopeSchema,
  fieldErrors,
  type EventInput,
  type MutationScope,
} from "@/lib/validation";
import { detectConflicts, type BusyBlock, type Conflict } from "@/lib/conflicts";
import { capSeriesUntil, occurrenceWallClockFakeUtc, type OccurrenceMarker } from "@/lib/time/rrule-edit";
import { dayWindowUtc } from "@/lib/time/zone";
import { materializeReminders } from "@/lib/reminders/scheduler";
import { loadOccurrenceViews } from "@/server/queries";
import { parseQuickAdd } from "@/lib/quickAdd/parser";

export type ActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; errors: Record<string, string> };

const fail = (errors: Record<string, string>) => ({ ok: false as const, errors });

function revalidateCalendar() {
  revalidatePath("/");
  revalidatePath("/calendar");
  revalidatePath("/agenda");
}

/** Rematerialize right away so a new alarm is visible without waiting for the next tick. */
async function refreshReminders(userId: string) {
  await materializeReminders({ now: new Date(), windowDays: 45, lookbackDays: 1, userId });
}

function eventWriteData(input: EventInput) {
  return {
    title: input.title,
    notes: input.notes ?? null,
    location: input.location ?? null,
    categoryId: input.categoryId ?? null,
    allDay: input.allDay,
    // The zone the wall clock is pinned to — never inferred, always explicit.
    timezone: input.timezone,
    // All-day rows carry dates and NO instants; timed rows carry instants and NO dates.
    // This mutual exclusion is what stops an all-day block from shifting by timezone.
    startUtc: input.allDay ? null : input.startUtc!,
    endUtc: input.allDay ? null : input.endUtc!,
    startDate: input.allDay ? input.startDate! : null,
    endDate: input.allDay ? input.endDate! : null,
    overrideQuietHours: input.overrideQuietHours,
    travelBufferMinutes: input.travelBufferMinutes,
  };
}

// ────────────────────────────────────────────────────────────── create

export async function createEvent(raw: unknown): Promise<ActionResult<{ id: string; conflicts: Conflict[] }>> {
  const user = await requireUser();
  const parsed = eventInputSchema.safeParse(raw);
  if (!parsed.success) return fail(fieldErrors(parsed.error));
  const input = parsed.data;

  const settings = await prisma.user.findUniqueOrThrow({
    where: { id: user.id },
    select: { defaultReminderOffsets: true },
  });

  const conflicts = await findConflicts(user.id, input, null);

  const created = await prisma.$transaction(async (tx) => {
    const event = await tx.event.create({
      data: {
        userId: user.id,
        ...eventWriteData(input),
        rrule: input.rrule ?? null,
      },
    });

    const rules =
      input.reminders.length > 0
        ? input.reminders
        : settings.defaultReminderOffsets.map((offsetMinutes) => ({
            offsetMinutes,
            channels: ["push", "email"],
          }));

    if (rules.length > 0) {
      await tx.reminderRule.createMany({
        data: rules.map((rule) => ({
          userId: user.id,
          eventId: event.id,
          offsetMinutes: rule.offsetMinutes,
          channels: rule.channels,
        })),
        skipDuplicates: true,
      });
    }
    return event;
  });

  await refreshReminders(user.id);
  revalidateCalendar();
  return { ok: true, data: { id: created.id, conflicts } };
}

export async function createEventFromQuickAdd(
  text: string,
): Promise<ActionResult<{ id: string; conflicts: Conflict[]; interpreted: string }>> {
  const user = await requireUser();
  const settings = await prisma.user.findUniqueOrThrow({
    where: { id: user.id },
    select: { timezone: true },
  });

  const draft = parseQuickAdd(text, { now: new Date(), timezone: settings.timezone });
  const result = await createEvent({
    title: draft.title,
    allDay: draft.allDay,
    timezone: draft.timezone,
    startUtc: draft.startUtc,
    endUtc: draft.endUtc,
    startDate: draft.startDate,
    endDate: draft.endDateExclusive,
    rrule: draft.rrule,
    reminders: [],
  });
  if (!result.ok) return result;

  return {
    ok: true,
    data: {
      id: result.data.id,
      conflicts: result.data.conflicts,
      interpreted: draft.allDay
        ? `${draft.title} · all day ${draft.startDate}`
        : `${draft.title} · ${new Date(draft.startUtc!).toUTCString()}`,
    },
  };
}

// ────────────────────────────────────────────────────────────── update

export interface UpdateEventArgs {
  /** The row the user is looking at: a master, or an override row. */
  eventId: string;
  /** The occurrence being edited: UTC ISO for timed, YYYY-MM-DD for all-day. */
  occurrenceStart: string;
  scope: MutationScope;
  values: unknown;
}

export async function updateEvent(args: UpdateEventArgs): Promise<ActionResult<{ conflicts: Conflict[] }>> {
  const user = await requireUser();
  const scope = scopeSchema.parse(args.scope);

  const parsed = eventInputSchema.safeParse(args.values);
  if (!parsed.success) return fail(fieldErrors(parsed.error));
  const input = parsed.data;

  const target = await prisma.event.findFirst({
    where: { id: args.eventId, userId: user.id },
    include: { series: true },
  });
  if (!target) return fail({ _: "That event no longer exists" });

  const root = target.series ?? target;
  const conflicts = await findConflicts(user.id, input, target.id);

  // ── whole series (or a standalone event) ──────────────────────────────────
  if (scope === "series" || root.rrule === null) {
    await prisma.$transaction(async (tx) => {
      await tx.event.update({
        where: { id: root.id },
        data: eventWriteData(input),
      });
      // A series edit changes the cadence too, so the rule moves with the fields.
      await tx.event.update({ where: { id: root.id }, data: { rrule: input.rrule ?? null } });
      await writeRules(tx, user.id, root.id, input);
    });

    await cancelFutureReminders(user.id, root.id, new Date());
    await refreshReminders(user.id);
    revalidateCalendar();
    return { ok: true, data: { conflicts } };
  }

  // ── this occurrence only ──────────────────────────────────────────────────
  if (scope === "this") {
    await prisma.$transaction(async (tx) => {
      const override = await tx.event.upsert({
        where: { seriesId_recurrenceId: { seriesId: root.id, recurrenceId: args.occurrenceStart } },
        create: {
          userId: user.id,
          seriesId: root.id,
          recurrenceId: args.occurrenceStart,
          ...eventWriteData(input),
          rrule: null, // an override never recurs on its own
          status: "confirmed",
        },
        update: { ...eventWriteData(input), status: "confirmed" },
      });
      await writeRules(tx, user.id, override.id, input);
    });

    // Only this occurrence's alarms are invalidated; the rest of the series keeps firing.
    await cancelRemindersForOccurrence(user.id, root.id, args.occurrenceStart);
    await refreshReminders(user.id);
    revalidateCalendar();
    return { ok: true, data: { conflicts } };
  }

  // ── this and future ───────────────────────────────────────────────────────
  const boundary = boundaryMarker(root, args.occurrenceStart);
  if (!boundary) return fail({ _: "That occurrence could not be located in the series" });

  await prisma.$transaction(async (tx) => {
    await tx.event.update({
      where: { id: root.id },
      data: { rrule: capSeriesUntil(root.rrule!, boundary) },
    });

    const created = await tx.event.create({
      data: {
        userId: user.id,
        ...eventWriteData(input),
        rrule: input.rrule ?? null,
      },
    });

    // Per-occurrence edits in the tail move with it — we re-parent them rather than lose them.
    const tailOverrides = await tx.event.findMany({
      where: { seriesId: root.id, status: { not: "cancelled" } },
      select: {
        id: true,
        recurrenceId: true,
        allDay: true,
        timezone: true,
        startUtc: true,
        startDate: true,
      },
    });

    for (const override of tailOverrides) {
      if (isAtOrAfter(override, boundary)) {
        await tx.event.update({ where: { id: override.id }, data: { seriesId: created.id } });
      }
    }

    await writeRules(tx, user.id, created.id, input);
  });

  await cancelFutureReminders(user.id, root.id, boundaryInstant(boundary));
  await refreshReminders(user.id);
  revalidateCalendar();
  return { ok: true, data: { conflicts } };
}

// ────────────────────────────────────────────────────────────── delete

export interface DeleteEventArgs {
  eventId: string;
  occurrenceStart: string;
  scope: MutationScope;
}

export async function deleteEvent(args: DeleteEventArgs): Promise<ActionResult> {
  const user = await requireUser();
  const scope = scopeSchema.parse(args.scope);

  const target = await prisma.event.findFirst({
    where: { id: args.eventId, userId: user.id },
    include: { series: true },
  });
  if (!target) return fail({ _: "That event no longer exists" });

  const root = target.series ?? target;

  // ── whole series ──────────────────────────────────────────────────────────
  if (scope === "series" || root.rrule === null) {
    // Cascades to overrides, reminder rules and reminders.
    await prisma.event.delete({ where: { id: root.id } });
    revalidateCalendar();
    return { ok: true, data: undefined };
  }

  // ── this occurrence only ──────────────────────────────────────────────────
  if (scope === "this") {
    await prisma.$transaction([
      // An EXDATE on the master is the canonical "this occurrence is off".
      prisma.event.update({
        where: { id: root.id },
        data: { exdates: { push: args.occurrenceStart } },
      }),
      prisma.event.deleteMany({ where: { seriesId: root.id, recurrenceId: args.occurrenceStart } }),
    ]);
    await cancelRemindersForOccurrence(user.id, root.id, args.occurrenceStart);
    revalidateCalendar();
    return { ok: true, data: undefined };
  }

  // ── this and future ───────────────────────────────────────────────────────
  const boundary = boundaryMarker(root, args.occurrenceStart);
  if (!boundary) return fail({ _: "That occurrence could not be located in the series" });

  await prisma.event.update({
    where: { id: root.id },
    data: { rrule: capSeriesUntil(root.rrule!, boundary) },
  });
  await cancelFutureReminders(user.id, root.id, boundaryInstant(boundary));
  revalidateCalendar();
  return { ok: true, data: undefined };
}

// ────────────────────────────────────────────────────────────── helpers

async function writeRules(
  tx: Prisma.TransactionClient,
  userId: string,
  eventId: string,
  input: EventInput,
): Promise<void> {
  await tx.reminderRule.deleteMany({ where: { eventId } });
  if (input.reminders.length === 0) return;
  await tx.reminderRule.createMany({
    data: input.reminders.map((rule) => ({
      userId,
      eventId,
      offsetMinutes: rule.offsetMinutes,
      channels: rule.channels,
    })),
    skipDuplicates: true,
  });
}

/** Turn the occurrence the user tapped into a marker we can cap a series with. */
function boundaryMarker(
  root: { allDay: boolean; timezone: string; startUtc: Date | null; startDate: string | null },
  occurrenceStart: string,
): OccurrenceMarker | null {
  if (root.allDay) {
    const date = occurrenceStart.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    return { allDay: true, startUtc: null, startDate: date, timezone: root.timezone };
  }
  const instant = new Date(occurrenceStart);
  if (Number.isNaN(instant.getTime())) return null;
  return { allDay: false, startUtc: instant, startDate: null, timezone: root.timezone };
}

/** The real UTC instant a boundary corresponds to — used to scope reminder cancellation. */
function boundaryInstant(boundary: OccurrenceMarker): Date {
  if (boundary.allDay && boundary.startDate) {
    return dayWindowUtc(boundary.startDate, boundary.timezone).startUtc;
  }
  return boundary.startUtc!;
}

function isAtOrAfter(
  override: {
    allDay: boolean;
    startUtc: Date | null;
    startDate: string | null;
    timezone: string;
    recurrenceId: string | null;
  },
  boundary: OccurrenceMarker,
): boolean {
  if (!override.recurrenceId) return false;
  // Compare on the ORIGINAL occurrence identity, in the series' wall-clock frame.
  const candidate: OccurrenceMarker = override.allDay
    ? { allDay: true, startUtc: null, startDate: override.recurrenceId.slice(0, 10), timezone: override.timezone }
    : { allDay: false, startUtc: new Date(override.recurrenceId), startDate: null, timezone: override.timezone };
  return (
    occurrenceWallClockFakeUtc(candidate).getTime() >= occurrenceWallClockFakeUtc(boundary).getTime()
  );
}

/**
 * Cancel every unresolved reminder for ONE occurrence.
 * Reminder rows point at the EFFECTIVE event (master or override), but the occurrence key is always
 * rooted at the master — so matching on the key prefix is both correct and narrow.
 */
export async function cancelRemindersForOccurrence(
  userId: string,
  rootEventId: string,
  occurrenceStart: string,
): Promise<void> {
  await prisma.reminder.updateMany({
    where: {
      userId,
      occurrenceId: { in: [`evt_${rootEventId}`, `evt_${rootEventId}#${occurrenceStart}`] },
      status: { in: ["pending", "deferred", "claimed"] },
    },
    data: { status: "cancelled", lastError: "occurrence-changed", claimToken: null, claimedAt: null },
  });
}

/** Cancel unresolved reminders for a whole series, from an instant onward. */
export async function cancelFutureReminders(
  userId: string,
  rootEventId: string,
  fromUtc: Date,
): Promise<void> {
  await prisma.reminder.updateMany({
    where: {
      userId,
      OR: [{ occurrenceId: `evt_${rootEventId}` }, { occurrenceId: { startsWith: `evt_${rootEventId}#` } }],
      occurrenceStartUtc: { gte: fromUtc },
      status: { in: ["pending", "deferred", "claimed"] },
    },
    data: { status: "cancelled", lastError: "series-edited", claimToken: null, claimedAt: null },
  });
}

/**
 * Conflicts are computed BEFORE the write, so the user is warned at creation time. The event is
 * still saved — the brief asks for surfacing, not blocking; people double-book on purpose.
 */
async function findConflicts(userId: string, input: EventInput, ignoreEventId: string | null): Promise<Conflict[]> {
  const settings = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { timezone: true } });
  const tz = input.timezone || settings.timezone;

  const candidateStart = input.allDay ? dayWindowUtc(input.startDate!, tz).startUtc : input.startUtc!;
  const candidateEnd = input.allDay ? dayWindowUtc(input.endDate!, tz).startUtc : input.endUtc!;

  // A generous ± window catches the neighbours that actually matter without scanning a month.
  const views = await loadOccurrenceViews(
    userId,
    {
      fromUtc: new Date(candidateStart.getTime() - 12 * 3_600_000),
      toUtc: new Date(candidateEnd.getTime() + 12 * 3_600_000),
    },
    new Date(),
  );

  const toInterval = (view: (typeof views)[number]): { startUtc: Date; endUtc: Date } =>
    view.when.kind === "allDay"
      ? {
          startUtc: dayWindowUtc(view.when.startDate, view.timezone).startUtc,
          endUtc: dayWindowUtc(view.when.endDateExclusive, view.timezone).startUtc,
        }
      : {
          startUtc: new Date(view.when.startUtc),
          endUtc: view.when.endUtc ? new Date(view.when.endUtc) : new Date(view.when.startUtc),
        };

  const candidate: BusyBlock = {
    id: ignoreEventId ?? "__candidate__",
    title: input.title,
    startUtc: candidateStart,
    endUtc: candidateEnd,
    bufferBeforeMinutes: input.travelBufferMinutes,
    location: input.location ?? null,
  };

  const others: BusyBlock[] = views
    .filter((view) => view.rootEventId !== ignoreEventId)
    .map((view) => {
      const { startUtc, endUtc } = toInterval(view);
      return {
        id: view.rootEventId,
        title: view.title,
        startUtc,
        endUtc,
        bufferBeforeMinutes: view.travelBufferMinutes,
        location: view.location,
      };
    });

  return detectConflicts(candidate, others);
}
