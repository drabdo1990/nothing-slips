// src/lib/ics/index.ts
//
// ICS import/export. Deliberately a small, well-tested subset of RFC 5545 rather than a dependency:
// we control the semantics, and the semantics are where bugs live.
//
// Two conversions matter and both are done explicitly:
//  * Timed events      → `DTSTART:...Z` (always UTC on the wire; TZID only when importing).
//  * All-day events    → `DTSTART;VALUE=DATE:20260329` with an EXCLUSIVE DTEND. Date-only values
//    have no timezone, so they cannot shift on import or export.

import type { EventTimeInput } from "@/lib/time/recurrence";
import { localPartsToUtc } from "@/lib/time/zone";

export interface IcsEvent {
  uid: string;
  title: string;
  notes: string | null;
  location: string | null;
  allDay: boolean;
  startUtc: Date | null;
  endUtc: Date | null;
  startDate: string | null;
  endDate: string | null; // exclusive
  rrule: string | null;
  exdates: string[];
  timezone: string;
  /** Minutes-before offsets, exported as VALARMs. */
  reminderOffsets: number[];
}

/** RFC 5545 line folding: 75 octets, continuation lines start with a single space. */
function fold(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;

  const out: string[] = [];
  let current = "";
  let currentBytes = 0;

  for (const char of line) {
    const size = Buffer.byteLength(char, "utf8");
    if (currentBytes + size > 75) {
      out.push(current);
      current = ` ${char}`;
      currentBytes = 1 + size;
    } else {
      current += char;
      currentBytes += size;
    }
  }
  if (current) out.push(current);
  return out.join("\r\n");
}

function escapeText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

function unescapeText(value: string): string {
  return value
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

function toIcsUtc(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function dateToIcs(isoDate: string): string {
  return isoDate.replace(/-/g, "");
}

export function exportIcs(events: IcsEvent[], calendarName = "Nothing Slips"): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Nothing Slips//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(calendarName)}`,
  ];

  const stamp = toIcsUtc(new Date());

  for (const event of events) {
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${event.uid}`);
    lines.push(`DTSTAMP:${stamp}`);

    if (event.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${dateToIcs(event.startDate!)}`);
      // Our end date is already exclusive, which matches RFC 5545's DTEND semantics exactly.
      lines.push(`DTEND;VALUE=DATE:${dateToIcs(event.endDate ?? event.startDate!)}`);
    } else {
      lines.push(`DTSTART:${toIcsUtc(event.startUtc!)}`);
      if (event.endUtc) lines.push(`DTEND:${toIcsUtc(event.endUtc)}`);
    }

    if (event.rrule) lines.push(`RRULE:${event.rrule}`);
    for (const exdate of event.exdates) {
      lines.push(event.allDay ? `EXDATE;VALUE=DATE:${dateToIcs(exdate)}` : `EXDATE:${toIcsUtc(new Date(exdate))}`);
    }

    lines.push(`SUMMARY:${escapeText(event.title)}`);
    if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);
    if (event.notes) lines.push(`DESCRIPTION:${escapeText(event.notes)}`);

    for (const offset of event.reminderOffsets) {
      lines.push("BEGIN:VALARM");
      lines.push("ACTION:DISPLAY");
      lines.push(`TRIGGER:-PT${offset}M`);
      lines.push(`DESCRIPTION:${escapeText(event.title)}`);
      lines.push("END:VALARM");
    }

    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

// ────────────────────────────────────────────────────────────── import

interface RawProp {
  name: string;
  params: Record<string, string>;
  value: string;
}

/** Unfold then split each line into name/params/value. */
function parseLine(line: string): RawProp | null {
  const colon = line.indexOf(":");
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const [name, ...paramParts] = head.split(";");
  const params: Record<string, string> = {};
  for (const part of paramParts) {
    const eq = part.indexOf("=");
    if (eq > 0) params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: name!.toUpperCase(), params, value };
}

/** "20260329T090000Z" | "20260329T090000" | "20260329" → parts. */
function parseIcsDate(value: string): { date: string; time: string | null; utc: boolean } | null {
  const match = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!match) return null;
  const [, y, mo, d, h, mi, s, z] = match;
  return {
    date: `${y}-${mo}-${d}`,
    time: h ? `${h}:${mi}:${s}` : null,
    utc: Boolean(z),
  };
}

export interface ImportedEvent extends Omit<IcsEvent, "uid" | "reminderOffsets"> {
  uid: string | null;
}

export function importIcs(text: string, fallbackTimezone: string): ImportedEvent[] {
  // Unfold: a CRLF (or LF) followed by a single space or tab continues the previous line.
  const unfolded = text.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").split(/\r?\n/);

  const events: ImportedEvent[] = [];
  let current: Record<string, RawProp[]> | null = null;

  for (const line of unfolded) {
    const trimmed = line.trim();
    if (trimmed === "BEGIN:VEVENT") {
      current = {};
      continue;
    }
    if (trimmed === "END:VEVENT") {
      if (current) events.push(buildImported(current, fallbackTimezone));
      current = null;
      continue;
    }
    if (!current) continue;

    const prop = parseLine(trimmed);
    if (!prop) continue;

    // EXDATE legitimately repeats; every other property keeps its first occurrence.
    if (prop.name === "EXDATE") {
      (current.EXDATE ??= []).push(prop);
      continue;
    }
    if (current[prop.name]) continue;
    current[prop.name] = [prop];
  }

  return events;
}

function buildImported(props: Record<string, RawProp[]>, fallbackTimezone: string): ImportedEvent {
  const first = (name: string) => props[name]?.[0];

  const dtstart = first("DTSTART");
  const dtend = first("DTEND");
  const start = dtstart ? parseIcsDate(dtstart.value) : null;
  const end = dtend ? parseIcsDate(dtend.value) : null;

  const isDateOnly = dtstart?.params.VALUE === "DATE" || (start !== null && start.time === null);
  const tzid = dtstart?.params.TZID;
  const timezone = tzid && tzid !== "UTC" ? tzid : fallbackTimezone;

  const rruleRaw = first("RRULE")?.value ?? null;

  // EXDATEs share the timezone semantics of DTSTART, so they must be resolved the same way.
  const rawExdates = (props.EXDATE ?? []).flatMap((prop) =>
    prop.value
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  );

  const resolveExdates = (allDay: boolean): string[] =>
    rawExdates.flatMap((raw) => {
      const parsed = parseIcsDate(raw);
      if (!parsed) return [];
      if (allDay || !parsed.time) return [parsed.date];
      return [toInstant(parsed, timezone).toISOString()];
    });

  if (isDateOnly && start) {
    const exclusiveEnd = end?.date ?? start.date;
    return {
      uid: first("UID")?.value ?? null,
      title: unescapeText(first("SUMMARY")?.value ?? "Untitled"),
      notes: first("DESCRIPTION") ? unescapeText(first("DESCRIPTION")!.value) : null,
      location: first("LOCATION") ? unescapeText(first("LOCATION")!.value) : null,
      allDay: true,
      startUtc: null,
      endUtc: null,
      startDate: start.date,
      // Guard against exporters that emit an inclusive DTEND on all-day events.
      endDate: exclusiveEnd > start.date ? exclusiveEnd : addOneDayStatic(start.date),
      rrule: rruleRaw,
      exdates: resolveExdates(true),
      timezone,
    };
  }

  const startInstant = start ? toInstant(start, timezone) : null;
  const endInstant = end ? toInstant(end, timezone) : null;

  return {
    uid: first("UID")?.value ?? null,
    title: unescapeText(first("SUMMARY")?.value ?? "Untitled"),
    notes: first("DESCRIPTION") ? unescapeText(first("DESCRIPTION")!.value) : null,
    location: first("LOCATION") ? unescapeText(first("LOCATION")!.value) : null,
    allDay: false,
    startUtc: startInstant,
    endUtc: endInstant ?? (startInstant ? new Date(startInstant.getTime() + 60 * 60_000) : null),
    startDate: null,
    endDate: null,
    rrule: rruleRaw,
    exdates: resolveExdates(false),
    timezone,
  };
}

function addOneDayStatic(dateISO: string): string {
  const [y, m, d] = dateISO.split("-").map(Number);
  const next = new Date(Date.UTC(y!, m! - 1, d! + 1));
  return next.toISOString().slice(0, 10);
}

/**
 * Resolve a parsed ICS datetime to an instant.
 * A value with `Z` is already UTC. A bare value plus TZID is a wall clock in that zone — resolved
 * through Luxon, never by string math. A bare value with no TZID falls back to the importer's zone.
 */
function toInstant(
  parsed: { date: string; time: string | null; utc: boolean },
  timezone: string,
): Date {
  const time = parsed.time ?? "00:00:00";
  if (parsed.utc) {
    return new Date(`${parsed.date}T${time}Z`);
  }
  const [hour, minute, second] = time.split(":").map(Number);
  const [year, month, day] = parsed.date.split("-").map(Number);
  return localPartsToUtc(
    { year: year!, month: month!, day: day!, hour: hour!, minute: minute!, second: second! },
    timezone,
  );
}

export function icsEventFromRow(
  row: EventTimeInput & { title: string; notes: string | null; location: string | null },
  reminderOffsets: number[],
): IcsEvent {
  return {
    uid: `${row.id}@nothing-slips`,
    title: row.title,
    notes: row.notes,
    location: row.location,
    allDay: row.allDay,
    startUtc: row.startUtc,
    endUtc: row.endUtc,
    startDate: row.startDate,
    endDate: row.endDate,
    rrule: row.rrule,
    exdates: row.exdates,
    timezone: row.timezone,
    reminderOffsets,
  };
}
