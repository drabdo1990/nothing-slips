// src/server/actions/settings.ts
//
// Settings + categories. Changing the timezone or quiet hours has a scheduling consequence, so after
// such a change we re-run the tick for this user only: deferred alarms get re-evaluated against the
// new window immediately instead of waiting for the next minute.

"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser } from "@/server/guards";
import { fieldErrors, settingsInputSchema } from "@/lib/validation";
import { normalizeOffsets } from "@/lib/reminders/offsets";
import { runTick } from "@/lib/reminders/scheduler";

export type ActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; errors: Record<string, string> };

export async function updateSettings(raw: unknown): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = settingsInputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: fieldErrors(parsed.error) };
  const input = parsed.data;

  const before = await prisma.user.findUniqueOrThrow({
    where: { id: user.id },
    select: { timezone: true, quietHoursEnabled: true, quietHoursStart: true, quietHoursEnd: true, dnd: true },
  });

  await prisma.user.update({
    where: { id: user.id },
    data: {
      name: input.name ?? null,
      timezone: input.timezone,
      quietHoursEnabled: input.quietHoursEnabled,
      quietHoursStart: input.quietHoursStart,
      quietHoursEnd: input.quietHoursEnd,
      dnd: input.dnd,
      defaultReminderOffsets: normalizeOffsets(input.defaultReminderOffsets),
      emailFallbackEnabled: input.emailFallbackEnabled,
    },
  });

  const schedulingChanged =
    before.timezone !== input.timezone ||
    before.quietHoursEnabled !== input.quietHoursEnabled ||
    before.quietHoursStart !== input.quietHoursStart ||
    before.quietHoursEnd !== input.quietHoursEnd ||
    before.dnd !== input.dnd;

  if (schedulingChanged) {
    // Re-evaluate deferred alarms now. Failures here must not lose the settings the user just saved.
    try {
      await runTick({ userId: user.id, origin: process.env.AUTH_URL ?? "http://localhost:3000" });
    } catch {
      // The next tick will pick these up; settings are already persisted.
    }
  }

  revalidatePath("/settings");
  revalidatePath("/");
  return { ok: true, data: undefined };
}

export async function setDoNotDisturb(dnd: boolean): Promise<ActionResult> {
  const user = await requireUser();
  await prisma.user.update({ where: { id: user.id }, data: { dnd } });
  try {
    await runTick({ userId: user.id, origin: process.env.AUTH_URL ?? "http://localhost:3000" });
  } catch {
    /* next tick */
  }
  revalidatePath("/settings");
  revalidatePath("/");
  return { ok: true, data: undefined };
}

const categorySchema = z.object({
  name: z.string().trim().min(1).max(40),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a hex colour"),
  icon: z.string().trim().max(40).default("calendar"),
});

export async function createCategory(raw: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
  const parsed = categorySchema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: fieldErrors(parsed.error) };

  try {
    const created = await prisma.category.create({
      data: { userId: user.id, ...parsed.data },
    });
    revalidatePath("/settings");
    return { ok: true, data: { id: created.id } };
  } catch {
    // Unique([userId, name]) — the only realistic failure is a duplicate name.
    return { ok: false, errors: { name: "You already have a category with that name" } };
  }
}

export async function deleteCategory(categoryId: string): Promise<ActionResult> {
  const user = await requireUser();
  // deleteMany scoped by userId: a wrong id is a no-op, never another user's row.
  await prisma.category.deleteMany({ where: { id: categoryId, userId: user.id } });
  revalidatePath("/settings");
  return { ok: true, data: undefined };
}

/**
 * A test alarm that exercises the REAL pipeline end to end: it creates a throwaway event whose
 * reminder is due immediately, then runs the tick for this user. That is the only kind of test
 * worth offering — a "test" that bypasses the scheduler would prove nothing about the scheduler.
 */
export async function sendTestAlarm(): Promise<ActionResult<{ reminderId: string }>> {
  const user = await requireUser();
  const now = new Date();

  const settings = await prisma.user.findUniqueOrThrow({
    where: { id: user.id },
    select: { timezone: true, quietHoursEnabled: true, quietHoursStart: true, quietHoursEnd: true, dnd: true },
  });

  const event = await prisma.event.create({
    data: {
      userId: user.id,
      title: "Test alarm",
      notes: "Created by the test button in Settings.",
      allDay: false,
      timezone: settings.timezone,
      startUtc: new Date(now.getTime() + 5 * 60_000),
      endUtc: new Date(now.getTime() + 20 * 60_000),
      // A test alarm must never be swallowed by quiet hours — otherwise it proves nothing.
      overrideQuietHours: true,
    },
  });

  const reminder = await prisma.reminder.create({
    data: {
      userId: user.id,
      eventId: event.id,
      occurrenceId: `evt_${event.id}`,
      occurrenceStartUtc: event.startUtc!,
      offsetMinutes: 5,
      scheduledFor: now,
      channels: ["push", "email"],
      quietOverride: true,
      status: "pending",
    },
  });

  try {
    await runTick({ userId: user.id, origin: process.env.AUTH_URL ?? "http://localhost:3000" });
  } catch {
    // The next tick will pick it up within a minute.
  }

  revalidatePath("/settings");
  return { ok: true, data: { reminderId: reminder.id } };
}
