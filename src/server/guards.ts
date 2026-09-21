// src/server/guards.ts
//
// THE authorization boundary. Every read and every write of someone's calendar goes through here.
// There is no "trust the client" path: the userId always comes from the session, never from input.

import { redirect } from "next/navigation";
import { auth } from "./auth";
import { prisma } from "@/lib/db";

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
}

export async function requireUser(): Promise<SessionUser> {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) redirect("/login");

  const user = await prisma.user.findUnique({
    where: { id },
    select: { id: true, email: true, name: true },
  });
  // Session exists but the user row is gone (deleted account): treat as signed out.
  if (!user) redirect("/login");
  return user;
}

/** Same guarantee for route handlers, but returns null instead of redirecting. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) return null;
  return prisma.user.findUnique({
    where: { id },
    select: { id: true, email: true, name: true },
  });
}

/**
 * Ownership assertion used by every event/reminder mutation.
 * A mismatch is treated as "not found" — we do not confirm the existence of another user's rows.
 */
export async function assertOwnsEvent(userId: string, eventId: string): Promise<void> {
  const row = await prisma.event.findFirst({
    where: { id: eventId, userId },
    select: { id: true },
  });
  if (!row) throw new Error("EVENT_NOT_FOUND");
}

export async function assertOwnsReminder(userId: string, reminderId: string): Promise<void> {
  const row = await prisma.reminder.findFirst({
    where: { id: reminderId, userId },
    select: { id: true },
  });
  if (!row) throw new Error("REMINDER_NOT_FOUND");
}
