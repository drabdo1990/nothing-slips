// tests/quickadd.test.ts
import { describe, expect, it } from "vitest";
import { parseQuickAdd } from "@/lib/quickAdd/parser";
import { expandOccurrences } from "@/lib/time/recurrence";
import { utcToLocalParts } from "@/lib/time/zone";

const BERLIN = "Europe/Berlin";
// A Monday, 11:00 in Berlin.
const NOW = new Date("2026-09-21T09:00:00.000Z");

const options = { now: NOW, timezone: BERLIN };

function localPartsOf(iso: string) {
  return utcToLocalParts(new Date(iso), BERLIN);
}

describe("parseQuickAdd", () => {
  it("reads the brief's own example", () => {
    const draft = parseQuickAdd("dentist thursday 3pm", options);

    expect(draft.title.toLowerCase()).toBe("dentist");
    expect(draft.allDay).toBe(false);
    expect(draft.confidentTime).toBe(true);

    const start = localPartsOf(draft.startUtc!);
    expect(start.hour).toBe(15); // 3pm wall clock in the user's zone
    expect(start.minute).toBe(0);
    expect(start.day).toBe(24); // the coming Thursday
    // No end spoken → a one-hour block, not a zero-length event.
    expect(new Date(draft.endUtc!).getTime() - new Date(draft.startUtc!).getTime()).toBe(60 * 60_000);
  });

  it("turns 'every weekday' into an RFC 5545 rule, not a boolean flag", () => {
    const draft = parseQuickAdd("standup every weekday 9am", options);
    expect(draft.rrule).toBe("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR");
    expect(localPartsOf(draft.startUtc!).hour).toBe(9);
    expect(draft.title.toLowerCase()).toBe("standup");
  });

  it("pins BYDAY when a weekday is spoken with a cadence word", () => {
    const draft = parseQuickAdd("gym every monday 7am", options);
    expect(draft.rrule).toBe("FREQ=WEEKLY;BYDAY=MO");
    expect(localPartsOf(draft.startUtc!).hour).toBe(7);
  });

  it("honours an interval", () => {
    const draft = parseQuickAdd("pay rent every 2 months 10am", options);
    expect(draft.rrule).toBe("FREQ=MONTHLY;INTERVAL=2");
  });

  it("makes a date with NO time an all-day item, and flags the guess", () => {
    const draft = parseQuickAdd("lunch tomorrow", options);
    expect(draft.allDay).toBe(true);
    expect(draft.confidentTime).toBe(false);
    expect(draft.startDate).toBe("2026-09-22");
    // Exclusive end date — one calendar day.
    expect(draft.endDateExclusive).toBe("2026-09-23");
    // All-day items carry NO instants: that is what stops them shifting.
    expect(draft.startUtc).toBeNull();
    expect(draft.endUtc).toBeNull();
  });

  it("keeps a spoken time range, including one that crosses midnight", () => {
    const draft = parseQuickAdd("drinks friday 11pm to 1am", options);
    const start = localPartsOf(draft.startUtc!);
    const end = localPartsOf(draft.endUtc!);

    expect(start.hour).toBe(23);
    expect(start.day).toBe(25); // the COMING Friday, not last week's
    expect(end.hour).toBe(1);
    // The end must be the following day, and the duration positive: a two-hour span.
    expect(end.day).toBe(start.day + 1);
    expect(new Date(draft.endUtc!).getTime() - new Date(draft.startUtc!).getTime()).toBe(2 * 60 * 60_000);
  });

  it("resolves a bare weekday into the FUTURE, never the past", () => {
    // The reference is a Monday; a bare "friday" must be this week's upcoming Friday.
    const draft = parseQuickAdd("drinks friday 8pm", options);
    const start = localPartsOf(draft.startUtc!);
    expect(start.day).toBe(25);
    expect(new Date(draft.startUtc!).getTime()).toBeGreaterThan(NOW.getTime());
  });

  it("strips the matched date words out of the title", () => {
    const draft = parseQuickAdd("call the bank next friday 2pm", options);
    expect(draft.title.toLowerCase()).not.toContain("friday");
    expect(draft.title.toLowerCase()).not.toContain("2pm");
    expect(draft.title.toLowerCase()).toContain("bank");
  });

  it("produces a draft that actually expands as a series", () => {
    const draft = parseQuickAdd("standup every weekday 9am", options);
    const series = {
      id: "draft",
      timezone: draft.timezone,
      allDay: draft.allDay,
      startUtc: new Date(draft.startUtc!),
      endUtc: new Date(draft.endUtc!),
      startDate: draft.startDate,
      endDate: draft.endDateExclusive,
      rrule: draft.rrule,
      exdates: [],
      seriesId: null,
      recurrenceId: null,
      status: "confirmed" as const,
    };

    const occurrences = expandOccurrences(series, [], {
      fromUtc: new Date("2026-09-21T00:00:00Z"),
      toUtc: new Date("2026-10-05T00:00:00Z"),
    });

    // 2026-09-24 is the Thursday after the reference Monday, so a weekday rule yields 8 by 5 Oct.
    expect(occurrences.length).toBeGreaterThan(4);
    for (const occurrence of occurrences) {
      if (occurrence.when.kind !== "timed") throw new Error("expected timed");
      const parts = localPartsOf(occurrence.when.startUtc);
      expect(parts.hour).toBe(9);
      // Never on a weekend.
      expect(parts.day).toBeGreaterThan(0);
    }
  });

  it("falls back sensibly when there is no date at all", () => {
    const draft = parseQuickAdd("buy milk", options);
    expect(draft.title).toBe("buy milk");
    expect(draft.confidentDate).toBe(false);
    expect(draft.rrule).toBeNull();
  });
});
