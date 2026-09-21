// prisma/seed.ts
//
// Seed data that deliberately covers the awkward cases, because those are the ones that break in
// production: a DST-crossing series, an all-day block, a cross-timezone meeting, a per-occurrence
// override, an EXDATE, and a reminder that is already overdue.
//
// Run with: npm run db:seed

import { PrismaClient } from "@prisma/client";
import { DateTime } from "luxon";

const prisma = new PrismaClient();

const BERLIN = "Europe/Berlin";
const NEW_YORK = "America/New_York";

function zoned(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  zone: string,
): Date {
  return DateTime.fromObject({ year, month, day, hour, minute }, { zone }).toUTC().toJSDate();
}

/**
 * The next Thursday at 09:00 Berlin. Used so the seeded series always has a FUTURE occurrence,
 * whatever day the seed is run — otherwise a demo would immediately look empty.
 */
function nextWeekdayAt(weekday: number, hour: number, zone: string): Date {
  const now = DateTime.now().setZone(zone);
  const candidate = now.set({ hour, minute: 0, second: 0, millisecond: 0 });
  const delta = (weekday - candidate.weekday + 7) % 7;
  return candidate.plus({ days: delta === 0 && now.hour >= hour ? 7 : delta }).toUTC().toJSDate();
}

async function main() {
  const email = process.env.SEED_EMAIL ?? "you@example.com";

  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: {
      email,
      name: "Sam",
      timezone: BERLIN,
      quietHoursEnabled: true,
      quietHoursStart: "22:00",
      quietHoursEnd: "07:00",
      defaultReminderOffsets: [60, 10],
      emailFallbackEnabled: true,
    },
  });

  const categories = await Promise.all(
    [
      { name: "Work", color: "#3e6b8c", icon: "briefcase" },
      { name: "Health", color: "#2e7d5b", icon: "heart-pulse" },
      { name: "Personal", color: "#6c8f7e", icon: "user" },
    ].map((category) =>
      prisma.category.upsert({
        where: { userId_name: { userId: user.id, name: category.name } },
        update: {},
        create: { userId: user.id, ...category },
      }),
    ),
  );

  const [work, health] = categories;

  // Idempotent-ish seeding: clear this user's events and their reminders, then rebuild.
  await prisma.event.deleteMany({ where: { userId: user.id } });

  // ── 1. A recurring series that CROSSES the spring DST boundary ────────────
  // The first occurrence sits before the transition and later ones after it, so the wall clock must
  // stay 09:00 while the UTC instant shifts from 08:00Z to 07:00Z. This is the single most valuable
  // row in the seed.
  const seriesStart = nextWeekdayAt(4, 9, BERLIN); // Thursday 09:00 Berlin
  const standup = await prisma.event.create({
    data: {
      userId: user.id,
      title: "Weekly team standup",
      notes: "Recurring. The 09:00 wall clock must survive the DST change.",
      location: "Meet link",
      categoryId: work!.id,
      allDay: false,
      timezone: BERLIN,
      startUtc: seriesStart,
      endUtc: new Date(seriesStart.getTime() + 30 * 60_000),
      rrule: "FREQ=WEEKLY;BYDAY=TH",
      overrideQuietHours: false,
      travelBufferMinutes: 0,
    },
  });

  // ── 2. Multiple reminders on one event (1 day, 1 hour, 10 minutes) ────────
  await prisma.reminderRule.createMany({
    data: [
      { userId: user.id, eventId: standup.id, offsetMinutes: 1440, channels: ["push", "email"] },
      { userId: user.id, eventId: standup.id, offsetMinutes: 60, channels: ["push"] },
      { userId: user.id, eventId: standup.id, offsetMinutes: 10, channels: ["push"] },
    ],
    skipDuplicates: true,
  });

  // ── 3. A per-occurrence override: one week moves to 14:00 ─────────────────
  const secondOccurrence = DateTime.fromJSDate(seriesStart)
    .setZone(BERLIN)
    .plus({ weeks: 1 })
    .toUTC()
    .toJSDate();
  const movedStart = DateTime.fromJSDate(seriesStart)
    .setZone(BERLIN)
    .plus({ weeks: 1 })
    .set({ hour: 14, minute: 0 })
    .toUTC()
    .toJSDate();

  await prisma.event.create({
    data: {
      userId: user.id,
      seriesId: standup.id,
      recurrenceId: secondOccurrence.toISOString(),
      title: "Weekly team standup (moved to the afternoon)",
      categoryId: work!.id,
      allDay: false,
      timezone: BERLIN,
      startUtc: movedStart,
      endUtc: new Date(movedStart.getTime() + 30 * 60_000),
    },
  });

  // ── 4. An EXDATE: one occurrence cancelled outright ──────────────────────
  const skippedOccurrence = DateTime.fromJSDate(seriesStart)
    .setZone(BERLIN)
    .plus({ weeks: 2 })
    .toUTC()
    .toJSDate();
  await prisma.event.update({
    where: { id: standup.id },
    data: { exdates: [skippedOccurrence.toISOString()] },
  });

  // ── 5. A MULTI-DAY ALL-DAY block, deliberately spanning a DST change ─────
  // Date-only storage means the end date cannot creep by an hour.
  const dstWindowStart = DateTime.now().setZone(BERLIN).plus({ months: 1 }).startOf("week");
  await prisma.event.create({
    data: {
      userId: user.id,
      title: "Conference (all day, 3 days)",
      notes: "All-day blocks are date-only. They must never shift by timezone.",
      location: "Berlin Congress Center",
      categoryId: work!.id,
      allDay: true,
      timezone: BERLIN,
      startDate: dstWindowStart.toISODate()!,
      endDate: dstWindowStart.plus({ days: 3 }).toISODate()!, // exclusive
      reminderRules: {
        create: [
          { userId: user.id, offsetMinutes: 1440, channels: ["push", "email"] },
          { userId: user.id, offsetMinutes: 60, channels: ["push"] },
        ],
      },
    },
  });

  // ── 6. A cross-timezone meeting: pinned to New York, viewed from Berlin ──
  const nyStart = nextWeekdayAt(2, 10, NEW_YORK); // Wednesday 10:00 in New York
  await prisma.event.create({
    data: {
      userId: user.id,
      title: "Call with the New York office",
      notes: "Pinned to America/New_York: the 10:00 wall clock there is the contract.",
      categoryId: work!.id,
      allDay: false,
      timezone: NEW_YORK,
      startUtc: nyStart,
      endUtc: new Date(nyStart.getTime() + 45 * 60_000),
      travelBufferMinutes: 0,
      reminderRules: {
        create: [{ userId: user.id, offsetMinutes: 15, channels: ["push", "email"] }],
      },
    },
  });

  // ── 7. A dentist appointment with a travel buffer ────────────────────────
  const dentist = nextWeekdayAt(2, 15, BERLIN);
  await prisma.event.create({
    data: {
      userId: user.id,
      title: "Dentist",
      location: "Praxis am Park",
      categoryId: health!.id,
      allDay: false,
      timezone: BERLIN,
      startUtc: dentist,
      endUtc: new Date(dentist.getTime() + 45 * 60_000),
      travelBufferMinutes: 30,
      overrideQuietHours: false,
      reminderRules: {
        create: [{ userId: user.id, offsetMinutes: 1440, channels: ["push", "email"] }],
      },
    },
  });

  // ── 8. An event with quiet hours OVERRIDDEN — genuinely unmissable ───────
  const flight = DateTime.now().setZone(BERLIN).plus({ days: 9 }).set({ hour: 5, minute: 40 });
  await prisma.event.create({
    data: {
      userId: user.id,
      title: "Flight to Lisbon",
      location: "BER airport, Terminal 1",
      categoryId: work!.id,
      allDay: false,
      timezone: BERLIN,
      startUtc: flight.toUTC().toJSDate(),
      endUtc: flight.plus({ hours: 3 }).toUTC().toJSDate(),
      overrideQuietHours: true, // 05:40 is inside quiet hours. This one fires anyway.
      travelBufferMinutes: 120,
      reminderRules: {
        create: [
          { userId: user.id, offsetMinutes: 1440, channels: ["push", "email"] },
          { userId: user.id, offsetMinutes: 120, channels: ["push", "email"] },
        ],
      },
    },
  });

  // ── 9. Materialize the alarm queue, then plant an OVERDUE one ────────────
  const { materializeReminders } = await import("../src/lib/reminders/scheduler");
  const materialized = await materializeReminders({
    now: new Date(),
    windowDays: 45,
    lookbackDays: 30,
    userId: user.id,
  });

  // A reminder that should already have fired: the tick will pick it up, deliver it late, and say
  // how late. This is how you verify the "a missed tick still delivers" promise by hand.
  const overdueEvent = await prisma.event.create({
    data: {
      userId: user.id,
      title: "Overdue — the alarm that should already have fired",
      notes: "Seeded 20 minutes in the past so a single tick demonstrates late delivery.",
      categoryId: categories[2]!.id,
      allDay: false,
      timezone: BERLIN,
      startUtc: new Date(Date.now() - 10 * 60_000),
      endUtc: new Date(Date.now() + 20 * 60_000),
      overrideQuietHours: true,
    },
  });
  await prisma.reminder.create({
    data: {
      userId: user.id,
      eventId: overdueEvent.id,
      occurrenceId: `evt_${overdueEvent.id}`,
      occurrenceStartUtc: overdueEvent.startUtc!,
      offsetMinutes: 20,
      scheduledFor: new Date(Date.now() - 20 * 60_000),
      channels: ["push", "email"],
      quietOverride: true,
      status: "pending",
    },
  });

  const counts = {
    events: await prisma.event.count({ where: { userId: user.id } }),
    rules: await prisma.reminderRule.count({ where: { userId: user.id } }),
    reminders: await prisma.reminder.count({ where: { userId: user.id } }),
  };

  console.log("Seeded for", email);
  console.log("  materialized by the scheduler:", materialized.created);
  console.table(counts);
  console.log(
    "\nNext: run `npm run tick` to deliver the overdue alarm (it will report how late it was).",
  );
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
