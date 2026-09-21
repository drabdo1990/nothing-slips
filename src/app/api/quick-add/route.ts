// app/api/quick-add/route.ts
//
// "dentist thursday 3pm" → a saved event. Returns what we understood so the UI can show the
// interpretation and let the user correct it, rather than silently guessing.

import { NextResponse, type NextRequest } from "next/server";
import { quickAddSchema, fieldErrors } from "@/lib/validation";
import { getSessionUser } from "@/server/guards";
import { prisma } from "@/lib/db";
import { parseQuickAdd } from "@/lib/quickAdd/parser";
import { formatOccurrenceWhen } from "@/lib/time/format";
import { createEventFromQuickAdd } from "@/server/actions/events";

export const dynamic = "force-dynamic";

/** Preview only — nothing is written. Used as the user types. */
export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => null);
  const parsed = quickAddSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ errors: fieldErrors(parsed.error) }, { status: 400 });

  const settings = await prisma.user.findUniqueOrThrow({
    where: { id: user.id },
    select: { timezone: true },
  });

  const timezone = parsed.data.timezone ?? settings.timezone;
  const draft = parseQuickAdd(parsed.data.text, { now: new Date(), timezone });
  const when = draft.allDay
    ? { kind: "allDay" as const, startDate: draft.startDate!, endDateExclusive: draft.endDateExclusive! }
    : { kind: "timed" as const, startUtc: draft.startUtc!, endUtc: draft.endUtc };
  const formatted = formatOccurrenceWhen(when, timezone, settings.timezone);

  return NextResponse.json({
    draft,
    preview: {
      title: draft.title,
      whenText: formatted.text,
      ariaLabel: formatted.ariaLabel,
      recurrence: draft.rrule,
      confidentTime: draft.confidentTime,
    },
  });
}

/** Commit. */
export async function PUT(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => null);
  const parsed = quickAddSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ errors: fieldErrors(parsed.error) }, { status: 400 });

  const result = await createEventFromQuickAdd(parsed.data.text);
  if (!result.ok) return NextResponse.json({ errors: result.errors }, { status: 400 });
  return NextResponse.json(result.data);
}
