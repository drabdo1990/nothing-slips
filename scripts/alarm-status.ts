// scripts/alarm-status.ts
//
// "Did it actually alarm me?" — answered from data, on the command line.
//
// Run: npm run alarms
// Optional: npm run alarms -- --user you@example.com --limit 25
//
// Prints the reminder ledger with its audit trail, and calls out anything that needs attention
// (missed, retrying, or deferred). This is the CLI counterpart to the audit panel on the event page.

import { PrismaClient, type ReminderStatus } from "@prisma/client";

const prisma = new PrismaClient();

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const limit = Number(arg("limit") ?? 20);
const email = arg("user");

const STATUS_ORDER: ReminderStatus[] = [
  "missed",
  "pending",
  "deferred",
  "claimed",
  "sent",
  "snoozed",
  "acknowledged",
  "cancelled",
];

async function main() {
  const user = email
    ? await prisma.user.findUnique({ where: { email }, select: { id: true, email: true, timezone: true } })
    : await prisma.user.findFirst({ select: { id: true, email: true, timezone: true } });

  if (!user) {
    console.error("No user found. Run `npm run db:seed` first.");
    process.exit(1);
  }

  const now = new Date();
  console.log(`\nAlarm ledger for ${user.email}  (${user.timezone}, now ${now.toISOString()})\n`);

  // ---- counts by status --------------------------------------------------
  const grouped = await prisma.reminder.groupBy({
    by: ["status"],
    where: { userId: user.id },
    _count: { _all: true },
  });

  const counts = new Map(grouped.map((g) => [g.status, g._count._all]));
  const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
  console.log(`  ${total} reminders total`);
  for (const status of STATUS_ORDER) {
    const count = counts.get(status);
    if (count) console.log(`    ${status.padEnd(14)} ${count}`);
  }

  // ---- anything needing attention ---------------------------------------
  const problems = await prisma.reminder.findMany({
    where: { userId: user.id, status: { in: ["missed", "pending", "deferred"] }, lastError: { not: null } },
    include: { event: { select: { title: true } }, logs: { orderBy: { attemptedAt: "desc" }, take: 3 } },
    orderBy: { scheduledFor: "desc" },
    take: 10,
  });

  if (problems.length > 0) {
    console.log("\n  Needs attention:");
    for (const reminder of problems) {
      console.log(
        `    [${reminder.status}] ${reminder.event.title} ` +
          `(offset ${reminder.offsetMinutes}m, due ${reminder.scheduledFor.toISOString()}, attempts ${reminder.attempts})`,
      );
      console.log(`        lastError: ${reminder.lastError}`);
      for (const log of reminder.logs) {
        console.log(`        log: ${log.channel} ${log.result} — ${log.detail ?? "no detail"}`);
      }
    }
  }

  // ---- recent ledger -----------------------------------------------------
  const recent = await prisma.reminder.findMany({
    where: { userId: user.id },
    include: {
      event: { select: { title: true } },
      logs: { orderBy: { attemptedAt: "desc" }, take: 1 },
    },
    orderBy: { scheduledFor: "desc" },
    take: limit,
  });

  console.log(`\n  Most recent ${recent.length}:`);
  console.log(
    `    ${"due (UTC)".padEnd(17)}${"offset".padEnd(8)}${"status".padEnd(14)}${"late".padEnd(9)}${"try".padEnd(4)}event`,
  );
  console.log("    " + "-".repeat(96));

  for (const reminder of recent) {
    // Lateness is only meaningful once it actually fired (or is late right now).
    const reference = reminder.sentAt ?? (reminder.status === "pending" ? now : null);
    const lateSeconds = reference ? Math.round((reference.getTime() - reminder.scheduledFor.getTime()) / 1000) : null;
    const late = lateSeconds !== null && lateSeconds >= 45 ? `${Math.round(lateSeconds / 60)}m` : "-";
    const lastLog = reminder.logs[0];
    const note = reminder.status === "sent" && lastLog ? `  (${lastLog.channel})` : "";

    console.log(
      "    " +
        reminder.scheduledFor.toISOString().slice(0, 16).replace("T", " ").padEnd(17) +
        `${reminder.offsetMinutes}m`.padEnd(8) +
        reminder.status.padEnd(14) +
        late.padEnd(9) +
        String(reminder.attempts).padEnd(4) +
        reminder.event.title.slice(0, 34) +
        note,
    );
  }

  console.log("");
  await prisma.$disconnect();
}

main().catch(async (error: unknown) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
