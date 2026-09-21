// tests/conflicts.test.ts
import { describe, expect, it } from "vitest";
import { detectConflicts, shapeOfDay, type BusyBlock } from "@/lib/conflicts";

const at = (iso: string) => new Date(iso);

function block(id: string, start: string, end: string, extra: Partial<BusyBlock> = {}): BusyBlock {
  return {
    id,
    title: id,
    startUtc: at(start),
    endUtc: at(end),
    bufferBeforeMinutes: 0,
    location: null,
    ...extra,
  };
}

describe("detectConflicts", () => {
  it("finds a straightforward overlap and reports the size of it", () => {
    const conflicts = detectConflicts(block("new", "2026-09-21T09:30:00Z", "2026-09-21T10:30:00Z"), [
      block("existing", "2026-09-21T09:00:00Z", "2026-09-21T10:00:00Z"),
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.kind).toBe("overlap");
    expect(conflicts[0]!.overlapMinutes).toBe(30);
  });

  it("treats touching intervals as NOT overlapping (half-open intervals)", () => {
    const conflicts = detectConflicts(block("new", "2026-09-21T10:00:00Z", "2026-09-21T11:00:00Z"), [
      block("existing", "2026-09-21T09:00:00Z", "2026-09-21T10:00:00Z"),
    ]);
    expect(conflicts).toHaveLength(0);
  });

  it("ignores the event being edited, so saving does not conflict with itself", () => {
    const conflicts = detectConflicts(block("same", "2026-09-21T09:00:00Z", "2026-09-21T10:00:00Z"), [
      block("same", "2026-09-21T09:00:00Z", "2026-09-21T10:00:00Z"),
    ]);
    expect(conflicts).toHaveLength(0);
  });

  it("flags back-to-back with no travel time when a location is involved", () => {
    // Ends 11:00, next starts 11:05, needs 30 minutes to travel there.
    const conflicts = detectConflicts(
      block("new", "2026-09-21T10:00:00Z", "2026-09-21T11:00:00Z", {
        bufferBeforeMinutes: 30,
        location: "Berlin HQ",
      }),
      [block("next", "2026-09-21T11:05:00Z", "2026-09-21T12:00:00Z", { location: "Munich office" })],
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.kind).toBe("no-travel-time");
    expect(conflicts[0]!.gapMinutes).toBe(5);
  });

  it("does not nag about travel when there is no location", () => {
    const conflicts = detectConflicts(
      block("new", "2026-09-21T10:00:00Z", "2026-09-21T11:00:00Z", { bufferBeforeMinutes: 30 }),
      [block("next", "2026-09-21T11:05:00Z", "2026-09-21T12:00:00Z")],
    );
    expect(conflicts).toHaveLength(0);
  });

  it("puts overlaps before softer warnings", () => {
    const conflicts = detectConflicts(
      block("new", "2026-09-21T10:00:00Z", "2026-09-21T11:00:00Z", {
        bufferBeforeMinutes: 30,
        location: "Somewhere",
      }),
      [
        block("gap", "2026-09-21T11:05:00Z", "2026-09-21T12:00:00Z"),
        block("overlap", "2026-09-21T10:45:00Z", "2026-09-21T11:30:00Z"),
      ],
    );
    expect(conflicts.map((conflict) => conflict.kind)).toEqual(["overlap", "no-travel-time"]);
  });
});

describe("shapeOfDay", () => {
  const window = { startUtc: at("2026-09-21T08:00:00Z"), endUtc: at("2026-09-21T18:00:00Z") };

  it("reports committed time, free gaps and back-to-back blocks", () => {
    const shape = shapeOfDay(
      [
        block("a", "2026-09-21T09:00:00Z", "2026-09-21T10:00:00Z"),
        block("b", "2026-09-21T10:00:00Z", "2026-09-21T11:00:00Z"), // back-to-back with a
        block("c", "2026-09-21T14:00:00Z", "2026-09-21T15:00:00Z"),
      ],
      window,
    );

    expect(shape.busyMinutes).toBe(180);
    expect(shape.backToBackCount).toBe(1);
    expect(shape.free.map((slot) => slot.minutes)).toEqual([60, 180, 180]);
  });

  it("merges overlapping blocks instead of double counting", () => {
    const shape = shapeOfDay(
      [
        block("a", "2026-09-21T09:00:00Z", "2026-09-21T11:00:00Z"),
        block("b", "2026-09-21T10:00:00Z", "2026-09-21T12:00:00Z"),
      ],
      window,
    );
    expect(shape.busy).toHaveLength(1);
    expect(shape.busyMinutes).toBe(180);
  });

  it("ignores gaps shorter than the minimum, so tiny holes are not advertised as free", () => {
    const shape = shapeOfDay(
      [
        block("a", "2026-09-21T09:00:00Z", "2026-09-21T10:00:00Z"),
        block("b", "2026-09-21T10:05:00Z", "2026-09-21T11:00:00Z"),
      ],
      window,
    );
    expect(shape.free.map((slot) => slot.minutes)).toEqual([60, 420]);
  });
});
