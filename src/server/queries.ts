// src/server/queries.ts
//
// Every read is scoped to `userId` — there is no query in this file that can return another
// person's calendar. Views consume `OccurrenceView`, so the UI never touches RRULEs or timezones
// itself; it renders values that were computed once, here.

import { prisma } from "@/lib/db";
import { expandOccurrences, type OccurrenceWhen } from "@/lib/time/recurrence";
import { phaseOf, type EventPhase } from "@/lib/time/status";
import { dayWindowUtc } from "@/lib/time/zone";

export interface ReminderSummary {
  id: string;
  status: string;
  offsetMinutes: number;
  scheduledFor: string;
  sentAt: string | null;
  acknowledgedAt: string | null;
  lateBySeconds: number | null;
  lastError: string | null;
}

export interface OccurrenceView {
  /** Reminder identity / stable occurrence key. */
  key: string;
  rootEventId: string;
  /** The row whose fields apply (override when present). */
  eventId: string;
  isOverride: boolean;
  cancelled: boolean;
  when: OccurrenceWhen;
  title: string;
  notes: string | null;
  location: string | null;
  allDay: boolean;
  timezone: string;
  rrule: string | null;
  overrideQuietHours: boolean;
  travelBufferMinutes: number;
  category: { id: string; name: string; color: string; icon: string } | null;
  reminderOffsets: number[];
  /** The nearest reminder that still matters for this occurrence. */
  nextReminder: ReminderSummary | null;
  /** True when every reminder for this occurrence has been acknowledged. */
  done: boolean;
  phase: EventPhase;
}

export interface WindowQuery {
  fromUtc: Date;
  toUtc: Date;
}

/**
 * Occurrences a user has not cancelled are "live". Reminder state is attached so the UI reads it
 * rather than inferring it — the brief's rule: state is never client-side.
 */
export async function loadOccurrenceViews(
  userId: string,
  window: WindowQuery,
  now: Date = new Date(),
): Promise<OccurrenceView[]> {
  const masters = await prisma.event.findMany({
    where: {
      userId,
      seriesId: null,
      OR: [
        { rrule: { not: null } },
        {
          allDay: false,
          startUtc: { gte: new Date(window.fromUtc.getTime() - 31 * 86_400_000), lt: window.toUtc },
        },
        {
          allDay: true,
          startDate: {
            gte: shiftDate(window.fromUtc, -31),
            lt: shiftDate(window.toUtc, 1),
          },
        },
      ],
    },
    include: {
      category: true,
      reminderRules: { orderBy: { offsetMinutes: "desc" } },
      overrides: { include: { category: true, reminderRules: { orderBy: { offsetMinutes: "desc" } } } },
    },
  });

  if (masters.length === 0) return [];

  const expanded = masters.flatMap((master) =>
    expandOccurrences(master, master.overrides, window, { includeCancelled: false }),
  );

  // One query for all reminder state in the window, keyed by occurrence.
  const keys = [...new Set(expanded.map((o) => o.key))];
  const reminders = await prisma.reminder.findMany({
    where: { userId, occurrenceId: { in: keys } },
    select: {
      id: true,
      occurrenceId: true,
      status: true,
      offsetMinutes: true,
      scheduledFor: true,
      sentAt: true,
      acknowledgedAt: true,
      lateBySeconds: true,
      lastError: true,
    },
    orderBy: { scheduledFor: "asc" },
  });

  const byOccurrence = new Map<string, typeof reminders>();
  for (const reminder of reminders) {
    const list = byOccurrence.get(reminder.occurrenceId) ?? [];
    list.push(reminder);
    byOccurrence.set(reminder.occurrenceId, list);
  }

  const views: OccurrenceView[] = [];

  for (const occurrence of expanded) {
    const rules = occurrence.event.reminderRules;
    const own = byOccurrence.get(occurrence.key) ?? [];
    const relevant = own.filter((r) => r.status !== "cancelled" && r.status !== "snoozed");

    // "Next" = the earliest reminder that has not yet resolved, else the most recent one.
    const unresolved = relevant.find((r) =>
      ["pending", "deferred", "claimed"].includes(r.status),
    );
    const next = unresolved ?? relevant.at(-1) ?? null;

    const acknowledged = relevant.filter((r) => r.acknowledgedAt !== null);
    const done = relevant.length > 0 && acknowledged.length === relevant.length;

    views.push({
      key: occurrence.key,
      rootEventId: occurrence.rootEventId,
      eventId: occurrence.effectiveEventId,
      isOverride: occurrence.isOverride,
      cancelled: occurrence.cancelled,
      when: occurrence.when,
      title: occurrence.event.title,
      notes: occurrence.event.notes,
      location: occurrence.event.location,
      allDay: occurrence.event.allDay,
      timezone: occurrence.event.timezone,
      rrule: masters.find((m) => m.id === occurrence.rootEventId)?.rrule ?? null,
      overrideQuietHours: occurrence.event.overrideQuietHours,
      travelBufferMinutes: occurrence.event.travelBufferMinutes,
      category: occurrence.event.category
        ? {
            id: occurrence.event.category.id,
            name: occurrence.event.category.name,
            color: occurrence.event.category.color,
            icon: occurrence.event.category.icon,
          }
        : null,
      reminderOffsets: rules.map((r) => r.offsetMinutes),
      nextReminder: next
        ? {
            id: next.id,
            status: next.status,
            offsetMinutes: next.offsetMinutes,
            scheduledFor: next.scheduledFor.toISOString(),
            sentAt: next.sentAt?.toISOString() ?? null,
            acknowledgedAt: next.acknowledgedAt?.toISOString() ?? null,
            lateBySeconds: next.lateBySeconds,
            lastError: next.lastError,
          }
        : null,
      done,
      phase: phaseOf({ when: occurrence.when, now, done }),
    });
  }

  return views.sort(sortViews);
}

function sortViews(a: OccurrenceView, b: OccurrenceView): number {
  const keyOf = (view: OccurrenceView) =>
    view.when.kind === "allDay"
      ? Date.parse(`${view.when.startDate}T00:00:00Z`) - 1
      : Date.parse(view.when.startUtc);
  return keyOf(a) - keyOf(b);
}

function shiftDate(instant: Date, days: number): string {
  const shifted = new Date(instant.getTime() + days * 86_400_000);
  return shifted.toISOString().slice(0, 10);
}

export async function loadDay(userId: string, dateISO: string, tz: string, now = new Date()) {
  const { startUtc, endUtc } = dayWindowUtc(dateISO, tz);
  return loadOccurrenceViews(userId, { fromUtc: startUtc, toUtc: endUtc }, now);
}

/** The today view's three answers: what's now, what's next, what's overdue. */
export interface TodaySummary {
  now_occurrences: OccurrenceView[];
  next: OccurrenceView | null;
  rest: OccurrenceView[];
  overdue: OccurrenceView[];
  all: OccurrenceView[];
}

export function summariseToday(views: OccurrenceView[]): TodaySummary {
  const live = views.filter((v) => !v.cancelled);
  const nowOccurrences = live.filter((v) => v.phase === "now");
  const overdue = live.filter((v) => v.phase === "overdue");
  const upcomingList = live.filter((v) => v.phase === "upcoming" || v.phase === "imminent");
  const next = upcomingList[0] ?? null;

  return {
    now_occurrences: nowOccurrences,
    next,
    rest: upcomingList.filter((v) => v.key !== next?.key),
    overdue,
    all: live,
  };
}

/** The event detail page: the root plus a bounded set of its next occurrences. */
export async function loadEventDetail(userId: string, eventId: string, now = new Date()) {
  const anchor = await prisma.event.findFirst({
    where: { id: eventId, userId },
    select: { id: true, seriesId: true },
  });
  if (!anchor) return null;

  const rootId = anchor.seriesId ?? anchor.id;
  const from = new Date(now.getTime() - 14 * 86_400_000);
  const to = new Date(now.getTime() + 120 * 86_400_000);

  const views = await loadOccurrenceViews(userId, { fromUtc: from, toUtc: to }, now);
  const rootViews = views.filter((v) => v.rootEventId === rootId);
  if (rootViews.length === 0) {
    // A series whose first occurrence is in the past but which has no occurrence in the next 120
    // days: still show something rather than a 404.
    const fallback = await loadOccurrenceViews(userId, {
      fromUtc: new Date(now.getTime() - 366 * 86_400_000),
      toUtc: new Date(now.getTime() + 14 * 86_400_000),
    }, now);
    const historical = fallback.filter((v) => v.rootEventId === rootId);
    return { rootEventId: rootId, occurrences: historical, focus: historical.at(-1) ?? null };
  }

  const requested = views.find((v) => v.eventId === eventId);
  return { rootEventId: rootId, occurrences: rootViews, focus: requested ?? rootViews[0] ?? null };
}

/** All distinct occurrence keys for a series, so an edit can invalidate the right reminders. */
export async function occurrenceKeysForRoot(userId: string, rootEventId: string, fromUtc: Date) {
  const reminders = await prisma.reminder.findMany({
    where: { userId, occurrenceId: { startsWith: `evt_${rootEventId}` }, scheduledFor: { gte: fromUtc } },
    select: { id: true, occurrenceId: true },
  });
  return reminders;
}
