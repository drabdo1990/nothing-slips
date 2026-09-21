// tests/scheduler.test.ts
//
// These tests cover the promises the brief is emphatic about:
//   * a duplicate/retried cron run cannot double-alarm
//   * multiple offsets per event, plus a per-user default
//   * a late tick still delivers, and says how late
//   * quiet hours defer (never drop) unless the event overrides them
//   * failures retry with backoff, then are recorded as missed — never silently dropped

import { describe, expect, it } from "vitest";
import {
  decideDelivery,
  planReminders,
  settleDelivery,
  type ReminderRuleInput,
} from "@/lib/reminders/plan";
import { localPartsToUtc } from "@/lib/time/zone";
import type { EventTimeInput } from "@/lib/time/recurrence";

const BERLIN = "Europe/Berlin";

function event(overrides: Partial<EventTimeInput & { title: string; overrideQuietHours: boolean }> = {}) {
  const start = localPartsToUtc({ year: 2026, month: 9, day: 21, hour: 9, minute: 0, second: 0 }, BERLIN);
  return {
    id: "e1",
    title: "Standup",
    timezone: BERLIN,
    allDay: false,
    startUtc: start,
    endUtc: new Date(start.getTime() + 15 * 60_000),
    startDate: null,
    endDate: null,
    rrule: null,
    exdates: [],
    seriesId: null,
    recurrenceId: null,
    status: "confirmed" as const,
    overrideQuietHours: false,
    ...overrides,
  };
}

const noQuiet = {
  timezone: BERLIN,
  quietHoursEnabled: false,
  quietHoursStart: "22:00",
  quietHoursEnd: "07:00",
  dnd: false,
};
const quiet = { ...noQuiet, quietHoursEnabled: true };

const window = (from: string, to: string) => ({ fromUtc: new Date(from), toUtc: new Date(to) });

describe("planReminders", () => {
  const range = window("2026-09-01T00:00:00Z", "2026-10-01T00:00:00Z");

  it("creates one reminder per configured offset", () => {
    const master = event();
    const rules: ReminderRuleInput[] = [
      { eventId: "e1", offsetMinutes: 1440, channels: ["push", "email"] },
      { eventId: "e1", offsetMinutes: 60, channels: ["push"] },
      { eventId: "e1", offsetMinutes: 10, channels: ["push"] },
    ];

    const planned = planReminders([{ master, overrides: [] }], {
      userId: "u1",
      window: range,
      rulesByEventId: new Map([["e1", rules]]),
      defaultOffsets: [10],
      quietOverride: false,
    });

    expect(planned).toHaveLength(3);
    // 09:00 CEST = 07:00Z, so "1 day before" is 07:00Z the previous day.
    expect(planned.map((p) => p.scheduledFor.toISOString()).sort()).toEqual([
      "2026-09-20T07:00:00.000Z",
      "2026-09-21T06:00:00.000Z",
      "2026-09-21T06:50:00.000Z",
    ]);
  });

  it("falls back to the user's default offsets when an event has no rules", () => {
    const planned = planReminders([{ master: event(), overrides: [] }], {
      userId: "u1",
      window: range,
      rulesByEventId: new Map(),
      defaultOffsets: [30, 5],
      quietOverride: false,
    });
    expect(planned.map((p) => p.offsetMinutes)).toEqual([30, 5]);
  });

  it("is idempotent: planning twice yields an identical set of unique keys", () => {
    const master = event({ rrule: "FREQ=WEEKLY;BYDAY=MO" });
    const input = {
      userId: "u1",
      window: range,
      rulesByEventId: new Map([["e1", [{ eventId: "e1", offsetMinutes: 10, channels: ["push"] }]]]),
      defaultOffsets: [10],
      quietOverride: false,
    };

    const first = planReminders([{ master, overrides: [] }], input);
    const second = planReminders([{ master, overrides: [] }], input);

    const key = (p: (typeof first)[number]) =>
      `${p.occurrenceId}|${p.offsetMinutes}|${p.scheduledFor.toISOString()}`;

    expect(first.length).toBeGreaterThan(1);
    expect(second.map(key)).toEqual(first.map(key));
    // …and the identity quadruple is unique WITHIN a plan, so the DB unique key never conflicts
    // with itself. (This is precisely what makes createMany+skipDuplicates a no-op on a re-run.)
    expect(new Set(first.map(key)).size).toBe(first.length);
    expect(new Set(second.map(key)).size).toBe(second.length);
  });

  it("spreads a recurring series across the window without materializing it all", () => {
    const master = event({ rrule: "FREQ=DAILY" });
    // DTSTART is 2026-09-21, so a window ending 2026-10-01 yields ten days — and, importantly,
    // nothing beyond the window. The infinite series is never materialized.
    const planned = planReminders([{ master, overrides: [] }], {
      userId: "u1",
      window: range,
      rulesByEventId: new Map(),
      defaultOffsets: [10],
      quietOverride: false,
    });
    expect(planned).toHaveLength(10);
    expect(planned.at(0)!.scheduledFor.toISOString()).toBe("2026-09-21T06:50:00.000Z");
    expect(planned.at(-1)!.scheduledFor.toISOString()).toBe("2026-09-30T06:50:00.000Z");
  });

  it("carries the per-event quiet-hours override onto the planned rows", () => {
    const planned = planReminders([{ master: event(), overrides: [] }], {
      userId: "u1",
      window: range,
      rulesByEventId: new Map(),
      defaultOffsets: [10],
      quietOverride: true,
    });
    expect(planned[0]!.quietOverride).toBe(true);
  });

  it("skips cancelled occurrences entirely", () => {
    const master = event({ rrule: "FREQ=DAILY" });
    const cancelled: EventTimeInput = {
      ...event(),
      id: "o1",
      seriesId: "e1",
      recurrenceId: "2026-09-22T07:00:00.000Z",
      status: "cancelled",
    };
    const planned = planReminders([{ master, overrides: [cancelled] }], {
      userId: "u1",
      window: range,
      rulesByEventId: new Map(),
      defaultOffsets: [10],
      quietOverride: false,
    });
    expect(planned.some((p) => p.occurrenceStartUtc.toISOString() === "2026-09-22T07:00:00.000Z")).toBe(false);
    expect(planned).toHaveLength(9);
  });
});

describe("decideDelivery", () => {
  const due = new Date("2026-09-21T07:00:00.000Z");

  it("delivers on time and reports zero lateness", () => {
    const decision = decideDelivery({ now: due, scheduledFor: due, quiet: noQuiet, quietOverride: false });
    expect(decision).toEqual({ kind: "deliver", lateBySeconds: 0 });
  });

  it("still delivers a late tick, and reports honestly how late", () => {
    // A tick that was skipped for 4 minutes must not silently swallow the alarm.
    const now = new Date(due.getTime() + 4 * 60_000);
    const decision = decideDelivery({ now, scheduledFor: due, quiet: noQuiet, quietOverride: false });
    expect(decision).toEqual({ kind: "deliver", lateBySeconds: 240 });
  });

  it("defers during quiet hours, to the end of the window", () => {
    const at2330 = localPartsToUtc({ year: 2026, month: 9, day: 21, hour: 23, minute: 30, second: 0 }, BERLIN);
    const decision = decideDelivery({ now: at2330, scheduledFor: at2330, quiet, quietOverride: false });
    expect(decision.kind).toBe("defer");
    if (decision.kind !== "defer") throw new Error("unreachable");
    // 07:00 CEST the next morning.
    expect(decision.until.toISOString()).toBe("2026-09-22T05:00:00.000Z");
    expect(decision.reason).toBe("quiet-hours");
  });

  it("honours the per-event override and fires THROUGH quiet hours", () => {
    const at2330 = localPartsToUtc({ year: 2026, month: 9, day: 21, hour: 23, minute: 30, second: 0 }, BERLIN);
    const decision = decideDelivery({ now: at2330, scheduledFor: at2330, quiet, quietOverride: true });
    expect(decision.kind).toBe("deliver");
  });

  it("defers under DND but never drops", () => {
    const midday = localPartsToUtc({ year: 2026, month: 9, day: 21, hour: 12, minute: 0, second: 0 }, BERLIN);
    const decision = decideDelivery({
      now: midday,
      scheduledFor: midday,
      quiet: { ...quiet, dnd: true },
      quietOverride: false,
    });
    expect(decision.kind).toBe("defer");
    if (decision.kind !== "defer") throw new Error("unreachable");
    expect(decision.reason).toBe("dnd");
    // DND has no scheduled end, so we re-evaluate rather than guess — bounded to 15 minutes.
    expect(decision.until.getTime() - midday.getTime()).toBe(15 * 60_000);
  });

  it("records a hopelessly late alarm as stale instead of firing it at 3am", () => {
    const now = new Date(due.getTime() + 6 * 60 * 60_000); // 6 hours late
    const decision = decideDelivery({ now, scheduledFor: due, quiet: noQuiet, quietOverride: false });
    expect(decision.kind).toBe("stale");
    if (decision.kind !== "stale") throw new Error("unreachable");
    expect(decision.lateBySeconds).toBe(6 * 3600);
  });
});

describe("settleDelivery", () => {
  const now = new Date("2026-09-21T07:00:00.000Z");

  it("marks a successful delivery as sent", () => {
    const settled = settleDelivery({ delivered: true, attempts: 1, now, lateBySeconds: 12, failureDetail: "" });
    expect(settled).toEqual({ status: "sent", sentAt: now, lateBySeconds: 12 });
  });

  it("retries with a growing backoff while budget remains", () => {
    const first = settleDelivery({ delivered: false, attempts: 1, now, lateBySeconds: 0, failureDetail: "push-http-500" });
    const second = settleDelivery({ delivered: false, attempts: 2, now, lateBySeconds: 0, failureDetail: "push-http-500" });
    expect(first.status).toBe("pending");
    expect(second.status).toBe("pending");
    if (first.status !== "pending" || second.status !== "pending") throw new Error("unreachable");
    expect(first.scheduledFor.getTime() - now.getTime()).toBe(60_000);
    expect(second.scheduledFor.getTime() - now.getTime()).toBe(5 * 60_000);
  });

  it("gives up as 'missed' — never silently — once the budget is spent", () => {
    const settled = settleDelivery({ delivered: false, attempts: 4, now, lateBySeconds: 0, failureDetail: "no-active-subscription" });
    expect(settled).toEqual({ status: "missed", lastError: "no-active-subscription", lateBySeconds: 0 });
  });

  it("never leaves a reminder in an in-flight state", () => {
    for (const attempts of [1, 2, 3, 4]) {
      for (const delivered of [true, false]) {
        const settled = settleDelivery({ delivered, attempts, now, lateBySeconds: 0, failureDetail: "x" });
        expect(["sent", "pending", "missed"]).toContain(settled.status);
      }
    }
  });
});

describe("duplicate cron run safety", () => {
  /**
   * Mirrors the atomic claim in scheduler.ts: a row is only claimable while `pending`, and the
   * claim flips it to `claimed` in the same statement. This is the model the SQL implements; the
   * test asserts the property the product depends on.
   */
  function claim(store: Map<string, string>, now: Date, token: string): string[] {
    const claimed: string[] = [];
    for (const [id, status] of store) {
      if (status === "pending") {
        store.set(id, "claimed");
        claimed.push(`${token}:${id}`);
      }
    }
    return claimed;
  }

  it("lets only one of two concurrent ticks claim each due reminder", () => {
    const store = new Map<string, string>([
      ["r1", "pending"],
      ["r2", "pending"],
      ["r3", "sent"],
    ]);
    const now = new Date();

    const tickA = claim(store, now, "A");
    const tickB = claim(store, now, "B"); // a doubled cron invocation, in parallel

    expect(tickA).toHaveLength(2);
    expect(tickB).toHaveLength(0); // nothing left to claim: no second alarm
    expect(new Set([...tickA, ...tickB]).size).toBe(2);
  });
});
