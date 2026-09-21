// tests/rrule-edit.test.ts
//
// "This and future" is the highest-risk edit in the app: get UNTIL's frame wrong and you either
// lose an occurrence or alarm twice for it. These tests pin the frame down.

import { describe, expect, it } from "vitest";
import { capSeriesUntil, isBoundedRule, stripTerminators } from "@/lib/time/rrule-edit";
import { expandOccurrences, type EventTimeInput } from "@/lib/time/recurrence";
import { localPartsToUtc } from "@/lib/time/zone";

const BERLIN = "Europe/Berlin";

function weeklyBerlin(): EventTimeInput {
  const start = localPartsToUtc({ year: 2026, month: 9, day: 21, hour: 9, minute: 0, second: 0 }, BERLIN);
  return {
    id: "series1",
    timezone: BERLIN,
    allDay: false,
    startUtc: start,
    endUtc: new Date(start.getTime() + 30 * 60_000),
    startDate: null,
    endDate: null,
    rrule: "FREQ=WEEKLY;BYDAY=MO",
    exdates: [],
    seriesId: null,
    recurrenceId: null,
    status: "confirmed",
  };
}

const range = { fromUtc: new Date("2026-09-01T00:00:00Z"), toUtc: new Date("2026-11-01T00:00:00Z") };

describe("capSeriesUntil", () => {
  it("excludes the boundary occurrence and keeps everything before it", () => {
    const series = weeklyBerlin();
    // 2026-09-21 (Mon), 09:00 CEST = 07:00Z. Cap so 2026-10-05 is the first week NOT in this series.
    const boundary = localPartsToUtc({ year: 2026, month: 10, day: 5, hour: 9, minute: 0, second: 0 }, BERLIN);
    const capped = { ...series, rrule: capSeriesUntil(series.rrule!, { allDay: false, startUtc: boundary, startDate: null, timezone: BERLIN }) };

    const occurrences = expandOccurrences(capped, [], range);
    expect(occurrences.map((o) => o.originalStart)).toEqual([
      "2026-09-21T07:00:00.000Z",
      "2026-09-28T07:00:00.000Z", // still CEST
    ]);
    expect(occurrences.map((o) => o.originalStart)).not.toContain(boundary.toISOString());
  });

  it("works across a DST boundary, because UNTIL is written in the series' wall clock", () => {
    const series = weeklyBerlin();
    // Berlin falls back on 2026-10-25. Cap mid-November, where 09:00 is CET (08:00Z).
    const boundary = localPartsToUtc({ year: 2026, month: 11, day: 16, hour: 9, minute: 0, second: 0 }, BERLIN);
    const capped = { ...series, rrule: capSeriesUntil(series.rrule!, { allDay: false, startUtc: boundary, startDate: null, timezone: BERLIN }) };

    // The window must reach past the boundary or we would be testing the window, not the cap.
    const occurrences = expandOccurrences(capped, [], {
      fromUtc: new Date("2026-09-01T00:00:00Z"),
      toUtc: new Date("2026-12-01T00:00:00Z"),
    });
    const last = occurrences.at(-1)!;
    // 2026-11-09 is the last Monday before the boundary, and it is CET (08:00Z) — the DST change
    // inside the series does not shift the wall clock.
    expect(last.originalStart).toBe("2026-11-09T08:00:00.000Z");
    expect(occurrences.map((o) => o.originalStart)).not.toContain(boundary.toISOString());
  });

  it("caps an all-day series without off-by-one drift", () => {
    const allDay: EventTimeInput = {
      ...weeklyBerlin(),
      allDay: true,
      startUtc: null,
      endUtc: null,
      startDate: "2026-09-21",
      endDate: "2026-09-22",
    };
    const capped = {
      ...allDay,
      rrule: capSeriesUntil(allDay.rrule!, {
        allDay: true,
        startUtc: null,
        startDate: "2026-10-05",
        timezone: BERLIN,
      }),
    };
    const occurrences = expandOccurrences(capped, [], range);
    expect(occurrences.map((o) => o.when.kind === "allDay" && o.when.startDate)).toEqual([
      "2026-09-21",
      "2026-09-28",
    ]);
  });

  it("replaces an existing terminator rather than stacking one", () => {
    expect(stripTerminators("FREQ=WEEKLY;BYDAY=MO;UNTIL=20260101T000000Z;COUNT=5")).toBe(
      "FREQ=WEEKLY;BYDAY=MO",
    );
    const recapped = capSeriesUntil("FREQ=WEEKLY;BYDAY=MO;COUNT=5", {
      allDay: false,
      startUtc: localPartsToUtc({ year: 2026, month: 10, day: 5, hour: 9, minute: 0, second: 0 }, BERLIN),
      startDate: null,
      timezone: BERLIN,
    });
    expect(recapped.startsWith("FREQ=WEEKLY;BYDAY=MO;UNTIL=")).toBe(true);
    expect(recapped).not.toContain("COUNT");
  });

  it("detects terminating rules", () => {
    expect(isBoundedRule("FREQ=WEEKLY;BYDAY=MO")).toBe(false);
    expect(isBoundedRule("FREQ=WEEKLY;BYDAY=MO;COUNT=3")).toBe(true);
  });
});
