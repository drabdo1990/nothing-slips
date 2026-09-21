// app/api/push/unsubscribe/route.ts
//
// Removing a device. Scoped to the session user so one person cannot disable another's alarms.

import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionUser } from "@/server/guards";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => null)) as { endpoint?: string } | null;
  if (!body?.endpoint) return NextResponse.json({ error: "invalid-body" }, { status: 400 });

  // deleteMany scoped by userId: an endpoint you do not own is a silent no-op.
  await prisma.pushSubscription.deleteMany({ where: { userId: user.id, endpoint: body.endpoint } });

  return NextResponse.json({ ok: true });
}
