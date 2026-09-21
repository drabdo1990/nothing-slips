// tests/time.test.ts
import { describe, expect, it } from "vitest";
import {
  addDays,
  dayWindowUtc,
  diffDays,
  isoWeekday,
  localDateString,
  localPartsToUtc,
  utcToLocalParts,
  weekWindowUtc,
  zoneAbbreviation,
} from "@/lib/time/zone";
import { isQuietAt, quietHoursEndUtc } from "@/lib/time/quietHours";
import { formatOccurrenceWhen } from "@/lib/time/format";
import { humanizeOffset, parseOffset, scheduledFor } from "@/lib/reminders/offsets";

const BERLIN = "Europe/Berlin";
const NEW_YORK = "America/New_York";

describe("zone conversion", () => {
  it("converts a Berlin wall clock to UTC before and after the spring DST change", () => {
    // 2026-03-29 is the European spring-forward date (CET +1 → CEST +2).
    const before = localPartsToUtc(
      { year: 2026, month: 3, day: 26, hour: 9, minute: 0, second: 0 },
      BERLIN,
    );
    const after = localPartsToUtc(
      { year: 2026, month: 4, day: 2, hour: 9, minute: 0, second: 0 },
      BERLIN,
    );

    expect(before.toISOString()).toBe("2026-03-26T08:00:00.000Z"); // +01:00
    expect(after.toISOString()).toBe("2026-04-02T07:00:00.000Z"); // +02:00

    // …and the wall clock round-trips to 09:00 in both cases.
    expect(utcToLocalParts(before, BERLIN).hour).toBe(9);
    expect(utcToLocalParts(after, BERLIN).hour).toBe(9);
  });

  it("resolves the fall-back ambiguity deterministically (earlier offset wins)", () => {
    // 2026-10-25 is the European fall-back date; 02:30 happens twice.
    const ambiguous = localPartsToUtc(
      { year: 2026, month: 10, day: 25, hour: 2, minute: 30, second: 0 },
      BERLIN,
    );
    // Earlier offset = CEST (+2) => 00:30Z. Documented behaviour, not an accident.
    expect(ambiguous.toISOString()).toBe("2026-10-25T00:30:00.000Z");
  });

  it("keeps day windows correct on a DST-shortened day", () => {
    // 29 March 2026 has only 23 hours in Berlin.
    const { startUtc, endUtc } = dayWindowUtc("2026-03-29", BERLIN);
    expect(startUtc.toISOString()).toBe("2026-03-28T23:00:00.000Z");
    expect(endUtc.toISOString()).toBe("2026-03-29T22:00:00.000Z");
    expect((endUtc.getTime() - startUtc.getTime()) / 3_600_000).toBe(23);
  });

  it("does calendar arithmetic without touching timezones", () => {
    expect(addDays("2026-03-28", 2)).toBe("2026-03-30");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(diffDays("2026-03-28", "2026-03-30")).toBe(2);
    expect(isoWeekday("2026-03-26")).toBe(4); // Thursday
  });

  it("builds a Monday-anchored week", () => {
    const week = weekWindowUtc("2026-09-21", BERLIN); // a Monday
    expect(week.days[0]).toBe("2026-09-21");
    expect(week.days[6]).toBe("2026-09-27");
    expect(localDateString(week.startUtc, BERLIN)).toBe("2026-09-21");
  });
});

describe("quiet hours", () => {
  const user = {
    timezone: BERLIN,
    quietHoursEnabled: true,
    quietHoursStart: "22:00",
    quietHoursEnd: "07:00",
    dnd: false,
  };

  it("wraps midnight", () => {
    const at2330 = localPartsToUtc({ year: 2026, month: 6, day: 10, hour: 23, minute: 30, second: 0 }, BERLIN);
    const at1200 = localPartsToUtc({ year: 2026, month: 6, day: 10, hour: 12, minute: 0, second: 0 }, BERLIN);
    const at0630 = localPartsToUtc({ year: 2026, month: 6, day: 10, hour: 6, minute: 30, second: 0 }, BERLIN);

    expect(isQuietAt(user, at2330)).toBe(true);
    expect(isQuietAt(user, at1200)).toBe(false);
    expect(isQuietAt(user, at0630)).toBe(true);
  });

  it("defers to the correct end instant, and the DST change inside the window is handled", () => {
    // Night of 28→29 March 2026: the window is one hour shorter than usual.
    const at0100 = localPartsToUtc({ year: 2026, month: 3, day: 29, hour: 1, minute: 0, second: 0 }, BERLIN);
    const end = quietHoursEndUtc(user, at0100);
    expect(end).not.toBeNull();
    expect(localDateString(end!, BERLIN)).toBe("2026-03-29");
    expect(utcToLocalParts(end!, BERLIN).hour).toBe(7);
    // 07:00 CEST on 29 March = 05:00Z, not 06:00Z — the missing hour is honoured.
    expect(end!.toISOString()).toBe("2026-03-29T05:00:00.000Z");
  });

  it("treats DND as an unconditional mute with no scheduled end", () => {
    const at1200 = localPartsToUtc({ year: 2026, month: 6, day: 10, hour: 12, minute: 0, second: 0 }, BERLIN);
    expect(isQuietAt({ ...user, dnd: true }, at1200)).toBe(true);
  });

  it("ignores a degenerate window where start equals end", () => {
    const at1200 = localPartsToUtc({ year: 2026, month: 6, day: 10, hour: 12, minute: 0, second: 0 }, BERLIN);
    expect(isQuietAt({ ...user, quietHoursStart: "09:00", quietHoursEnd: "09:00" }, at1200)).toBe(false);
  });
});

describe("reminder offsets", () => {
  it("parses what people type", () => {
    expect(parseOffset("1d")).toBe(1440);
    expect(parseOffset("2h")).toBe(120);
    expect(parseOffset("30m")).toBe(30);
    expect(parseOffset("45")).toBe(45);
    expect(parseOffset("1d 2h")).toBe(1560);
    expect(parseOffset("nonsense")).toBeNull();
  });

  it("humanizes", () => {
    expect(humanizeOffset(1440)).toBe("1 day before");
    expect(humanizeOffset(10)).toBe("10 min before");
    expect(humanizeOffset(0)).toBe("At start time");
  });

  it("subtracts the offset on the real timeline (duration maths, not wall-clock maths)", () => {
    const anchor = new Date("2026-03-29T07:00:00.000Z"); // 09:00 CEST
    expect(scheduledFor(anchor, 1440).toISOString()).toBe("2026-03-28T07:00:00.000Z");
  });
});

describe("time formatting", () => {
  it("labels the zone when the viewer's zone differs from the event's", () => {
    const start = localPartsToUtc({ year: 2026, month: 6, day: 15, hour: 10, minute: 0, second: 0 }, NEW_YORK);
    const formatted = formatOccurrenceWhen(
      { kind: "timed", startUtc: start.toISOString(), endUtc: null },
      NEW_YORK,
      BERLIN,
    );

    expect(formatted.crossZone).toBe(true);
    expect(formatted.text).toContain("16:00"); // 10:00 EDT = 16:00 CEST
    expect(formatted.text).toContain("New York"); // the original zone is named
    expect(formatted.ariaLabel).toContain("your time");
  });

  it("never labels a zone when none differs", () => {
    const start = localPartsToUtc({ year: 2026, month: 6, day: 15, hour: 9, minute: 0, second: 0 }, BERLIN);
    const formatted = formatOccurrenceWhen(
      { kind: "timed", startUtc: start.toISOString(), endUtc: null },
      BERLIN,
      BERLIN,
    );
    expect(formatted.crossZone).toBe(false);
    expect(formatted.text).toBe("09:00");
  });

  it("renders all-day events as dates, with no zone at all", () => {
    const formatted = formatOccurrenceWhen(
      { kind: "allDay", startDate: "2026-03-29", endDateExclusive: "2026-03-30" },
      BERLIN,
      NEW_YORK,
    );
    expect(formatted.text).toBe("All day");
    expect(formatted.crossZone).toBe(false);
  });

  it("formats multi-day all-day events as a range", () => {
    const formatted = formatOccurrenceWhen(
      { kind: "allDay", startDate: "2026-07-01", endDateExclusive: "2026-07-04" },
      BERLIN,
      BERLIN,
    );
    expect(formatted.text).toBe("1 Jul – 3 Jul");
  });

  it("reports the zone abbreviation", () => {
    expect(zoneAbbreviation(BERLIN, new Date("2026-06-15T00:00:00Z"))).toBe("GMT+2");
  });
});
