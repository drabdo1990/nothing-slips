// app/api/reminders/[id]/route.ts
//
// The HTTP face of the reminder state machine, used by the service worker's notification actions
// (which cannot call a server action directly) and by the offline outbox on the client.
//
// Ownership is checked inside the actions themselves, so a forged id cannot touch another calendar.

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/server/guards";
import { acknowledgeReminder, snoozeReminder } from "@/server/actions/reminders";

export const dynamic = "force-dynamic";

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("ack") }),
  z.object({ action: z.literal("snooze"), minutes: z.number().int().min(1).max(24 * 60) }),
]);

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await context.params;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid-body" }, { status: 400 });

  if (parsed.data.action === "ack") {
    const result = await acknowledgeReminder(id);
    return NextResponse.json(result, { status: result.ok ? 200 : 404 });
  }

  const result = await snoozeReminder({ reminderId: id, minutes: parsed.data.minutes });
  return NextResponse.json(result, { status: result.ok ? 200 : 404 });
}
