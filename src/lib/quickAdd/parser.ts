// src/lib/quickAdd/parser.ts
//
// "dentist thursday 3pm" â†’ a draft event.
//
// Two halves, deliberately separated:
//  * Natural-language DATE/TIME parsing is delegated to chrono-node. It is battle-tested and I am
//    not going to beat it with regexes.
//  * RECURRENCE is ours, because chrono knows nothing about RRULE, and because "every weekday"
//    must become RFC 5545 â€” not a boolean flag.
//
// Timezone determinism: we read chrono's *components* (`.get('hour')`), never its `Date`. The
// components are the wall clock the user spoke, and we convert them through their IANA zone
// ourselves. That makes the result independent of the server's own timezone, which is the whole
// ballgame for a scheduling app.

import * as chrono from "chrono-node";
import { addDays } from "@/lib/time/zone";
import { localPartsToUtc } from "@/lib/time/zone";
import type { LocalParts } from "@/lib/time/zone";

export interface QuickAddDraft {
  title: string;
  /** UTC ISO instants for timed events. */
  startUtc: string | null;
  endUtc: string | null;
  /** Date-only values for all-day events (no time was spoken). */
  startDate: string | null;
  endDateExclusive: string | null;
  allDay: boolean;
  rrule: string | null;
  timezone: string;
  /** False when we had to guess (no time spoken â†’ all-day, no end â†’ +1 hour). */
  confidentDate: boolean;
  confidentTime: boolean;
  /** What we removed from the title, echoed back so the UI can show "we read this asâ€¦". */
  matchedText: string;
}

const WEEKDAYS: Record<string, string> = {
  monday: "MO",
  mon: "MO",
  tuesday: "TU",
  tue: "TU",
  tues: "TU",
  wednesday: "WE",
  wed: "WE",
  thursday: "TH",
  thu: "TH",
  thurs: "TH",
  friday: "FR",
  fri: "FR",
  saturday: "SA",
  sat: "SA",
  sunday: "SU",
  sun: "SU",
};

const RECURRENCE_PATTERNS: { re: RegExp; build: (m: RegExpMatchArray, fallbackWeekday: string | null) => string }[] = [
  {
    re: /\bevery\s+weekday(s)?\b|\bweekdays\b/i,
    build: () => "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
  },
  {
    re: /\bevery\s+(\d+)\s+(day|week|month|year)s?\b/i,
    build: (m) => `FREQ=${unitToFreq(m[2]!)};INTERVAL=${Number(m[1])}`,
  },
  {
    re: /\bevery\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thurs|fri|sat|sun)\b/i,
    build: (m) => `FREQ=WEEKLY;BYDAY=${WEEKDAYS[m[1]!.toLowerCase()] ?? "MO"}`,
  },
  {
    re: /\bevery\s+(day|week|month|year)\b|\b(daily|weekly|monthly|yearly|annually)\b/i,
    build: (m, fallbackWeekday) => {
      const word = (m[1] ?? m[2] ?? "day").toLowerCase();
      const freq = unitToFreq(word);
      // "weekly on thursday" pins BYDAY; a bare "weekly" keeps the start's own weekday.
      return fallbackWeekday ? `FREQ=${freq};BYDAY=${fallbackWeekday}` : `FREQ=${freq}`;
    },
  },
];

function unitToFreq(unit: string): string {
  switch (unit.toLowerCase()) {
    case "day":
    case "daily":
      return "DAILY";
    case "week":
    case "weekly":
      return "WEEKLY";
    case "month":
    case "monthly":
      return "MONTHLY";
    default:
      return "YEARLY";
  }
}

const FILLER = /\b(at|on|from|to|by|this|next|coming|please|remind me( to)?|add|schedule|book)\b/gi;
const RECURRENCE_STRIP =
  /\b(every\s+\d+\s+(day|week|month|year)s?|every\s+weekday(s)?|weekdays|every\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thurs|fri|sat|sun)|every\s+(day|week|month|year)|daily|weekly|monthly|yearly|annually)\b/gi;

export interface QuickAddOptions {
  now: Date;
  timezone: string;
  /** Used when a time was spoken but no end (default 60 minutes, or 15 for likely standups). */
  defaultDurationMinutes?: number;
}

/** "3-4pm", "11pm to 1am", "9am until 10:30". Captures the SECOND time of an explicit range. */
const EXPLICIT_RANGE =
  /(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:to|until|till|â€“|â€”|-)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i;

export function parseQuickAdd(input: string, options: QuickAddOptions): QuickAddDraft {
  const { now, timezone } = options;
  const durationDefault = options.defaultDurationMinutes ?? 60;

  // Recurrence first, on the raw text, then strip it so it cannot confuse the date parser.
  let rrule: string | null = null;
  const weekdayFromTitle = input.match(/\b(?:on\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
  const fallbackWeekday = weekdayFromTitle ? (WEEKDAYS[weekdayFromTitle[1]!.toLowerCase()] ?? null) : null;

  for (const pattern of RECURRENCE_PATTERNS) {
    const match = input.match(pattern.re);
    if (match) {
      rrule = pattern.build(match, fallbackWeekday);
      break;
    }
  }

  const forParsing = input.replace(RECURRENCE_STRIP, " ").replace(FILLER, " ").replace(/\s+/g, " ").trim();

  // `instant` anchors relative words ("tomorrow", "thursday") and `timezone` makes chrono resolve the
  // wall clock in the USER's zone rather than the server's.
  //
  // `forwardDate` is passed as a PARSING OPTION (the third argument), not as part of the reference
  // object. It is not cosmetic: without it chrono resolves a bare weekday to a date that has already
  // passed ("friday" said on a Monday â†’ the previous Friday). An appointment is always ahead of you.
  const reference: chrono.ParsingReference = { instant: now, timezone };
  const parsingOptions: chrono.ParsingOption = { forwardDate: true };
  const results = chrono.parse(forParsing, reference, parsingOptions);
  const result = results[0];

  const title = stripMatched(forParsing, results);
  let startUtc: string | null = null;
  let endUtc: string | null = null;
  let startDate: string | null = null;
  let endDateExclusive: string | null = null;
  let allDay = false;
  let confidentDate = false;
  let confidentTime = false;

  if (result) {
    const start = result.start;
    confidentDate = true;
    confidentTime = start.isCertain("hour");

    const parts: LocalParts = {
      year: start.get("year")!,
      month: start.get("month")!,
      day: start.get("day")!,
      hour: confidentTime ? start.get("hour")! : 0,
      minute: confidentTime ? (start.get("minute") ?? 0) : 0,
      second: 0,
    };

    if (confidentTime) {
      const startInstant = localPartsToUtc(parts, timezone);
      // The range is detected on the RAW input: `forParsing` has had connectives like "to" stripped
      // out (they are noise in a title), and "11pm to 1am" needs that "to" to be recognised at all.
      endUtc = resolveEndInstant(
        input,
        parts,
        startInstant,
        result,
        reference,
        parsingOptions,
        timezone,
        durationDefault,
      ).toISOString();
      startUtc = startInstant.toISOString();
    } else {
      // No time spoken â†’ an all-day obligation. Date-only values cannot shift by timezone.
      allDay = true;
      startDate = toDateString(parts);
      endDateExclusive = addDays(startDate, 1);
    }
  }

  return {
    title: title || input.trim() || "Untitled",
    startUtc,
    endUtc,
    startDate,
    endDateExclusive,
    allDay,
    rrule,
    timezone,
    confidentDate,
    confidentTime,
    matchedText: result?.text ?? "",
  };
}

/**
 * Find the END of a spoken range.
 *
 * chrono's own range detection is unreliable for the way people actually talk ("drinks friday 11pm
 * to 1am" often yields no `result.end` at all), so an explicit "X to Y" range is resolved here: the
 * end time is parsed in isolation, then re-anchored to the START's date. That is the correct
 * semantics, and it is what makes a cross-midnight range come out positive instead of inverted.
 */
function resolveEndInstant(
  text: string,
  startParts: LocalParts,
  startInstant: Date,
  result: chrono.ParsedResult,
  reference: chrono.ParsingReference,
  parsingOptions: chrono.ParsingOption,
  timezone: string,
  durationDefault: number,
): Date {
  const range = text.match(EXPLICIT_RANGE);
  if (range?.[2]) {
    const endParsed = chrono.parse(range[2], reference, parsingOptions)[0];
    if (endParsed?.start.isCertain("hour")) {
      let endInstant = localPartsToUtc(
        {
          year: startParts.year,
          month: startParts.month,
          day: startParts.day,
          hour: endParsed.start.get("hour")!,
          minute: endParsed.start.get("minute") ?? 0,
          second: 0,
        },
        timezone,
      );
      // "11pm to 1am" ends the NEXT day.
      if (endInstant.getTime() <= startInstant.getTime()) {
        endInstant = new Date(endInstant.getTime() + 24 * 60 * 60_000);
      }
      return endInstant;
    }
  }

  // Otherwise trust chrono if it is sure, and finally fall back to a sensible default duration.
  const endParts = result.end;
  if (endParts?.isCertain("hour")) {
    const endInstant = localPartsToUtc(
      {
        year: endParts.get("year")!,
        month: endParts.get("month")!,
        day: endParts.get("day")!,
        hour: endParts.get("hour")!,
        minute: endParts.get("minute") ?? 0,
        second: 0,
      },
      timezone,
    );
    if (endInstant.getTime() > startInstant.getTime()) return endInstant;
  }

  return new Date(startInstant.getTime() + durationDefault * 60_000);
}

function toDateString(parts: LocalParts): string {
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

/** Remove the spans chrono matched, plus stray connectives, from the title. */
function stripMatched(text: string, results: chrono.ParsedResult[]): string {
  let out = text;
  for (const result of results) {
    const index = out.indexOf(result.text);
    if (index >= 0) out = out.slice(0, index) + " " + out.slice(index + result.text.length);
  }
  return out
    .replace(FILLER, " ")
    .replace(/\s+(at|on|from|to|by)$/i, "")
    .replace(/^[\s\-â€“,:]+|[\s\-â€“,:]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}
