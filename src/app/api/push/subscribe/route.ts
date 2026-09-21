// app/api/push/subscribe/route.ts
//
// Registers (or refreshes) this browser's push subscription for the signed-in user.
//
// The endpoint is the browser's own secret, so upserting on it and (re)assigning it to the current
// user is correct: the DEVICE is authenticated as whoever is signed in now. That is also why this
// route is the only place a subscription can change hands — it requires a session.

import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionUser } from "@/server/guards";
import { pushSubscriptionSchema } from "@/lib/validation";
import { vapidPublicKey } from "@/lib/notifications/push";

export const dynamic = "force-dynamic";

export async function GET() {
  // Lets the client know whether push is available at all before it asks for permission.
  return NextResponse.json({ enabled: vapidPublicKey() !== null, publicKey: vapidPublicKey() });
}

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid-json" }, { status: 400 });
  }

  const parsed = pushSubscriptionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid-subscription" }, { status: 400 });
  }

  const { endpoint, keys } = parsed.data;
  const userAgent = request.headers.get("user-agent")?.slice(0, 300) ?? null;

  await prisma.pushSubscription.upsert({
    where: { endpoint },
    create: {
      userId: user.id,
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
      userAgent,
    },
    update: {
      userId: user.id,
      p256dh: keys.p256dh,
      auth: keys.auth,
      userAgent,
      // Re-subscribing on a device that was previously rejected clears the disabled flag.
      disabled: false,
      failureCount: 0,
      lastSeenAt: new Date(),
    },
  });

  return NextResponse.json({ ok: true });
}
