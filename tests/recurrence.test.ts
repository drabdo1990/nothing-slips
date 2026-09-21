// tests/recurrence.test.ts
import { describe, expect, it } from "vitest";
import {
  expandOccurrences,
  occurrenceAnchorUtc,
  occurrenceKey,
  type EventTimeInput,
} from "@/lib/time/recurrence";
import { localPartsToUtc, utcToLocalParts } from "@/lib/time/zone";

const BERLIN = "Europe/Berlin";

function timed(overrides: Partial<EventTimeInput> = {}): EventTimeInput {
  const start = localPartsToUtc({ year: 2026, month: 3, day: 26, hour: 9, minute: 0, second: 0 }, BERLIN);
  return {
    id: "evt1",
    timezone: BERLIN,
    allDay: false,
    startUtc: start,
    endUtc: new Date(start.getTime() + 30 * 60_000),
    startDate: null,
    endDate: null,
    rrule: null,
    exdates: [],
    seriesId: null,
    recurrenceId: null,
    status: "confirmed",
    ...overrides,
  };
}

const window = (from: string, to: string) => ({ fromUtc: new Date(from), toUtc: new Date(to) });

describe("single (non-recurring) events", () => {
  it("produces exactly one occurrence with a stable key", () => {
    const event = timed();
    const [occurrence, ...rest] = expandOccurrences(event, [], window("2026-03-01T00:00:00Z", "2026-04-01T00:00:00Z"));
    expect(rest).toHaveLength(0);
    expect(occurrence!.key).toBe("evt_evt1");
    expect(occurrence!.when.kind).toBe("timed");
  });

  it("is excluded when the window misses it", () => {
    const result = expandOccurrences(timed(), [], window("2026-05-01T00:00:00Z", "2026-06-01T00:00:00Z"));
    expect(result).toHaveLength(0);
  });

  it("includes an event that started before the window but is still running", () => {
    const result = expandOccurrences(timed(), [], window("2026-03-26T08:10:00Z", "2026-03-26T09:00:00Z"));
    expect(result).toHaveLength(1);
  });
});

describe("DST-crossing weekly series", () => {
  const series = timed({ rrule: "FREQ=WEEKLY;BYDAY=TH", id: "series1" });

  it("keeps the 09:00 wall clock across the spring-forward boundary", () => {
    const occurrences = expandOccurrences(
      series,
      [],
      window("2026-03-20T00:00:00Z", "2026-04-17T00:00:00Z"),
    );

    expect(occurrences.map((o) => o.when.kind === "timed" && o.when.startUtc)).toEqual([
      "2026-03-26T08:00:00.000Z", // CET  (+01:00)
      "2026-04-02T07:00:00.000Z", // CEST (+02:00) — same 09:00 local
      "2026-04-09T07:00:00.000Z",
      "2026-04-16T07:00:00.000Z",
    ]);

    // The invariant that matters: every occurrence is 09:00 in its own zone.
    for (const o of occurrences) {
      if (o.when.kind !== "timed") throw new Error("expected timed");
      expect(utcToLocalParts(new Date(o.when.startUtc), BERLIN).hour).toBe(9);
      expect(utcToLocalParts(new Date(o.when.startUtc), BERLIN).minute).toBe(0);
    }
  });

  it("gives every occurrence a distinct, stable key", () => {
    const occurrences = expandOccurrences(
      series,
      [],
      window("2026-03-20T00:00:00Z", "2026-04-17T00:00:00Z"),
    );
    const keys = occurrences.map((o) => o.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys[0]).toBe("evt_series1#2026-03-26T08:00:00.000Z");
    // Re-expanding produces byte-identical keys — this is what makes reminder creation idempotent.
    const again = expandOccurrences(series, [], window("2026-03-20T00:00:00Z", "2026-04-17T00:00:00Z"));
    expect(again.map((o) => o.key)).toEqual(keys);
  });

  it("honours COUNT", () => {
    const limited = timed({ rrule: "FREQ=WEEKLY;BYDAY=TH;COUNT=2", id: "series2" });
    const occurrences = expandOccurrences(
      limited,
      [],
      window("2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z"),
    );
    expect(occurrences).toHaveLength(2);
  });

  it("stays bounded for a daily series over a wide window", () => {
    const daily = timed({ rrule: "FREQ=DAILY", id: "series3" });
    // Window sits entirely *after* DTSTART (2026-03-26): one month in, and only one month out.
    const occurrences = expandOccurrences(
      daily,
      [],
      window("2026-04-01T00:00:00Z", "2026-05-02T00:00:00Z"),
    );
    expect(occurrences).toHaveLength(31); // one month, never the whole infinite series
  });

  it("produces nothing before DTSTART", () => {
    const daily = timed({ rrule: "FREQ=DAILY", id: "series4" });
    expect(expandOccurrences(daily, [], window("2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z"))).toHaveLength(0);
  });
});

describe("exceptions and overrides", () => {
  const series = timed({ rrule: "FREQ=WEEKLY;BYDAY=TH", id: "series1" });
  const range = window("2026-03-20T00:00:00Z", "2026-04-17T00:00:00Z");

  it("removes an EXDATE occurrence entirely", () => {
    const withExdate = { ...series, exdates: ["2026-04-02T07:00:00.000Z"] };
    const occurrences = expandOccurrences(withExdate, [], range);
    expect(occurrences.map((o) => o.originalStart)).not.toContain("2026-04-02T07:00:00.000Z");
    expect(occurrences).toHaveLength(3);
  });

  it("applies a per-occurrence override to one occurrence only", () => {
    const movedStart = localPartsToUtc(
      { year: 2026, month: 4, day: 2, hour: 14, minute: 0, second: 0 },
      BERLIN,
    );
    const override: EventTimeInput = {
      ...timed(),
      id: "override1",
      seriesId: "series1",
      recurrenceId: "2026-04-02T07:00:00.000Z",
      startUtc: movedStart,
      endUtc: new Date(movedStart.getTime() + 60 * 60_000),
    };

    const occurrences = expandOccurrences(series, [override], range);
    const changed = occurrences.find((o) => o.originalStart === "2026-04-02T07:00:00.000Z");

    expect(changed!.isOverride).toBe(true);
    expect(changed!.effectiveEventId).toBe("override1");
    // The series is untouched for every other week.
    expect(occurrences.filter((o) => o.isOverride)).toHaveLength(1);
    expect(occurrences).toHaveLength(4);
  });

  it("supports 'this and future' by splitting the series (new master + EXDATE tail)", () => {
    // "This and future" is expressed as: cap the old series with UNTIL, then create a new master.
    // Here we assert the mechanism the action layer uses: UNTIL removes the tail from the old rule.
    const capped: EventTimeInput = {
      ...series,
      rrule: "FREQ=WEEKLY;BYDAY=TH;UNTIL=20260401T235959Z",
    };
    const occurrences = expandOccurrences(capped, [], range);
    expect(occurrences.map((o) => o.originalStart)).toEqual([
      "2026-03-26T08:00:00.000Z",
      // 2026-04-02 is excluded by UNTIL (exclusive end, so it stops before that Thursday)
    ]);
  });

  it("cancels a single occurrence without deleting the series", () => {
    const cancelled: EventTimeInput = {
      ...timed(),
      id: "override2",
      seriesId: "series1",
      recurrenceId: "2026-04-09T07:00:00.000Z",
      status: "cancelled",
    };
    const occurrences = expandOccurrences(series, [cancelled], range);
    expect(occurrences.map((o) => o.originalStart)).not.toContain("2026-04-09T07:00:00.000Z");
    expect(occurrences).toHaveLength(3);
  });

  it("includes an override that was MOVED into the window from outside it", () => {
    const narrow = window("2026-05-01T00:00:00Z", "2026-06-01T00:00:00Z");
    const movedIn = localPartsToUtc(
      { year: 2026, month: 5, day: 14, hour: 9, minute: 0, second: 0 },
      BERLIN,
    );
    const override: EventTimeInput = {
      ...timed(),
      id: "override3",
      seriesId: "series1",
      recurrenceId: "2026-04-09T07:00:00.000Z", // original lies outside `narrow`
      startUtc: movedIn,
      endUtc: new Date(movedIn.getTime() + 30 * 60_000),
    };
    const occurrences = expandOccurrences(series, [override], narrow);
    expect(occurrences.map((o) => o.effectiveEventId)).toContain("override3");
  });
});

describe("all-day events", () => {
  const allDay: EventTimeInput = {
    ...timed(),
    allDay: true,
    startUtc: null,
    endUtc: null,
    startDate: "2026-03-29",
    endDate: "2026-03-30",
    rrule: null,
  };

  it("never shifts, even on a DST transition day", () => {
    const [occurrence] = expandOccurrences(allDay, [], window("2026-03-01T00:00:00Z", "2026-04-01T00:00:00Z"));
    expect(occurrence!.when).toEqual({
      kind: "allDay",
      startDate: "2026-03-29",
      endDateExclusive: "2026-03-30",
    });
  });

  it("expands a recurring all-day series as calendar dates", () => {
    const weekly = { ...allDay, rrule: "FREQ=WEEKLY;BYDAY=SU", startDate: "2026-03-29", endDate: "2026-03-30" };
    const occurrences = expandOccurrences(weekly, [], window("2026-03-01T00:00:00Z", "2026-05-01T00:00:00Z"));
    expect(occurrences.map((o) => o.when.kind === "allDay" && o.when.startDate)).toEqual([
      "2026-03-29",
      "2026-04-05",
      "2026-04-12",
      "2026-04-19",
      "2026-04-26",
    ]);
  });

  it("anchors reminders at local midnight in the event's own zone", () => {
    const [occurrence] = expandOccurrences(allDay, [], window("2026-03-01T00:00:00Z", "2026-04-01T00:00:00Z"));
    // 29 March 2026 is the DST day: local midnight Berlin = 23:00Z on the 28th.
    expect(occurrenceAnchorUtc(occurrence!, BERLIN).toISOString()).toBe("2026-03-28T23:00:00.000Z");
  });
});

describe("occurrence keys", () => {
  it("is stable and distinguishes a whole series from an occurrence", () => {
    expect(occurrenceKey("e1", null)).toBe("evt_e1");
    expect(occurrenceKey("e1", "2026-03-26T08:00:00.000Z")).toBe("evt_e1#2026-03-26T08:00:00.000Z");
  });
});
