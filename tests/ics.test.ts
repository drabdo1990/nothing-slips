// tests/ics.test.ts
//
// ICS is where timezone bugs go to hide, because the format has three ways to express the same
// instant (UTC, floating, TZID) plus a fourth (date-only). These tests pin all four.

import { describe, expect, it } from "vitest";
import { exportIcs, importIcs } from "@/lib/ics";
import { localPartsToUtc } from "@/lib/time/zone";

const BERLIN = "Europe/Berlin";

describe("importIcs", () => {
  const sample = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "UID:timed@example.com",
    "SUMMARY:Team sync",
    "LOCATION:Room 1",
    "DTSTART:20260921T090000Z",
    "DTEND:20260921T093000Z",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:zoned@example.com",
    "SUMMARY:Berlin standup",
    "DTSTART;TZID=Europe/Berlin:20260921T090000",
    "DTEND;TZID=Europe/Berlin:20260921T093000",
    "RRULE:FREQ=WEEKLY;BYDAY=MO",
    "EXDATE;TZID=Europe/Berlin:20261005T090000",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:allday@example.com",
    "SUMMARY:Public holiday",
    "DTSTART;VALUE=DATE:20261003",
    "DTEND;VALUE=DATE:20261004",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:folded@example.com",
    "SUMMARY:A very long title that has been folded across",
    "  two lines by the exporter",
    "DTSTART:20260922T120000Z",
    "DTEND:20260922T130000Z",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const events = importIcs(sample, BERLIN);

  it("reads a plain UTC event", () => {
    const event = events.find((item) => item.uid === "timed@example.com")!;
    expect(event.allDay).toBe(false);
    expect(event.startUtc!.toISOString()).toBe("2026-09-21T09:00:00.000Z");
    expect(event.endUtc!.toISOString()).toBe("2026-09-21T09:30:00.000Z");
    expect(event.location).toBe("Room 1");
  });

  it("resolves a TZID wall clock through the zone, not by string math", () => {
    const event = events.find((item) => item.uid === "zoned@example.com")!;
    // 09:00 on 21 Sep 2026 in Berlin is CEST (+02:00) → 07:00Z. This is the whole point.
    expect(event.startUtc!.toISOString()).toBe("2026-09-21T07:00:00.000Z");
    expect(event.timezone).toBe(BERLIN);
    expect(event.rrule).toBe("FREQ=WEEKLY;BYDAY=MO");
  });

  it("resolves EXDATEs in the same zone as DTSTART", () => {
    const event = events.find((item) => item.uid === "zoned@example.com")!;
    expect(event.exdates).toEqual(["2026-10-05T07:00:00.000Z"]);
  });

  it("keeps all-day events as date-only values with an exclusive end", () => {
    const event = events.find((item) => item.uid === "allday@example.com")!;
    expect(event.allDay).toBe(true);
    expect(event.startDate).toBe("2026-10-03");
    expect(event.endDate).toBe("2026-10-04");
    expect(event.startUtc).toBeNull();
  });

  it("unfolds continuation lines", () => {
    const event = events.find((item) => item.uid === "folded@example.com")!;
    // Unfolding removes the CRLF and the single leading space that marks the continuation.
    expect(event.title).toBe("A very long title that has been folded across two lines by the exporter");
  });

  it("falls back to the supplied zone for a floating (no-Z, no-TZID) time", () => {
    const floating = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:float@example.com",
      "SUMMARY:Floating",
      "DTSTART:20260921T090000",
      "DTEND:20260921T100000",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\n");
    const [event] = importIcs(floating, BERLIN);
    expect(event!.startUtc!.toISOString()).toBe(
      localPartsToUtc({ year: 2026, month: 9, day: 21, hour: 9, minute: 0, second: 0 }, BERLIN).toISOString(),
    );
  });
});

describe("exportIcs", () => {
  it("round-trips a timed event", () => {
    const start = localPartsToUtc({ year: 2026, month: 9, day: 21, hour: 9, minute: 0, second: 0 }, BERLIN);
    const ics = exportIcs([
      {
        uid: "e1@nothing-slips",
        title: "Standup",
        notes: null,
        location: "Meet",
        allDay: false,
        startUtc: start,
        endUtc: new Date(start.getTime() + 30 * 60_000),
        startDate: null,
        endDate: null,
        rrule: "FREQ=WEEKLY;BYDAY=MO",
        exdates: [],
        timezone: BERLIN,
        reminderOffsets: [10],
      },
    ]);

    expect(ics).toContain("DTSTART:20260921T070000Z");
    expect(ics).toContain("RRULE:FREQ=WEEKLY;BYDAY=MO");
    expect(ics).toContain("BEGIN:VALARM");
    expect(ics).toContain("TRIGGER:-PT10M");

    const [roundTripped] = importIcs(ics, BERLIN);
    expect(roundTripped!.startUtc!.toISOString()).toBe("2026-09-21T07:00:00.000Z");
    expect(roundTripped!.rrule).toBe("FREQ=WEEKLY;BYDAY=MO");
    expect(roundTripped!.title).toBe("Standup");
  });

  it("round-trips an all-day event without a single instant", () => {
    const ics = exportIcs([
      {
        uid: "e2@nothing-slips",
        title: "Conference",
        notes: null,
        location: null,
        allDay: true,
        startUtc: null,
        endUtc: null,
        startDate: "2026-10-03",
        endDate: "2026-10-06", // exclusive, matching DTEND semantics exactly
        rrule: null,
        exdates: [],
        timezone: BERLIN,
        reminderOffsets: [1440],
      },
    ]);

    expect(ics).toContain("DTSTART;VALUE=DATE:20261003");
    expect(ics).toContain("DTEND;VALUE=DATE:20261006");

    const [roundTripped] = importIcs(ics, BERLIN);
    expect(roundTripped!.allDay).toBe(true);
    expect(roundTripped!.startDate).toBe("2026-10-03");
    expect(roundTripped!.endDate).toBe("2026-10-06");
  });

  it("folds long lines to 75 octets and still round-trips", () => {
    const longTitle = "A".repeat(200);
    const ics = exportIcs([
      {
        uid: "e3@nothing-slips",
        title: longTitle,
        notes: null,
        location: null,
        allDay: true,
        startUtc: null,
        endUtc: null,
        startDate: "2026-10-03",
        endDate: "2026-10-04",
        rrule: null,
        exdates: [],
        timezone: BERLIN,
        reminderOffsets: [],
      },
    ]);

    for (const line of ics.split("\r\n")) {
      expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
    }
    expect(importIcs(ics, BERLIN)[0]!.title).toBe(longTitle);
  });
});
