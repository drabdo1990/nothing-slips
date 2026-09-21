// app/settings/page.tsx

import { requireUser } from "@/server/guards";
import { prisma } from "@/lib/db";
import { Card, SectionHeading } from "@/components/ui/Card";
import { SettingsForm } from "@/components/settings/SettingsForm";
import { CategoryManager, IcsTools, PushSettings } from "@/components/settings/SettingsTools";
import { formatQuietHours } from "@/lib/time/quietHours";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  const user = await requireUser();

  const settings = await prisma.user.findUniqueOrThrow({
    where: { id: user.id },
    select: {
      name: true,
      email: true,
      timezone: true,
      quietHoursEnabled: true,
      quietHoursStart: true,
      quietHoursEnd: true,
      dnd: true,
      defaultReminderOffsets: true,
      emailFallbackEnabled: true,
    },
  });

  const categories = await prisma.category.findMany({
    where: { userId: user.id },
    orderBy: { name: "asc" },
    select: { id: true, name: true, color: true },
  });

  // A short, honest health line: how many alarms are queued, and did any fail recently?
  const [pending, missed] = await Promise.all([
    prisma.reminder.count({
      where: { userId: user.id, status: { in: ["pending", "deferred"] } },
    }),
    prisma.reminder.count({
      where: { userId: user.id, status: "missed", scheduledFor: { gte: new Date(Date.now() - 7 * 86_400_000) } },
    }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold text-ink">Settings</h1>

      <Card className="p-4">
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <dt className="text-xs text-slate">Alarms queued</dt>
            <dd className="text-base font-medium text-ink tabular">{pending}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate">Missed this week</dt>
            <dd
              className={`text-base font-medium tabular ${missed > 0 ? "text-danger-500" : "text-ink"}`}
            >
              {missed}
            </dd>
          </div>
        </dl>
        <p className="mt-3 border-t border-mist pt-3 text-xs text-slate">
          Quiet hours: {formatQuietHours(settings)}. Reminders are checked server-side every minute.
        </p>
      </Card>

      <section aria-labelledby="alerts-heading">
        <SectionHeading id="alerts-heading">Alarms on this device</SectionHeading>
        <Card className="p-4">
          <PushSettings />
        </Card>
      </section>

      <SettingsForm
        initial={{
          name: settings.name ?? "",
          timezone: settings.timezone,
          quietHoursEnabled: settings.quietHoursEnabled,
          quietHoursStart: settings.quietHoursStart,
          quietHoursEnd: settings.quietHoursEnd,
          dnd: settings.dnd,
          defaultReminderOffsets: settings.defaultReminderOffsets,
          emailFallbackEnabled: settings.emailFallbackEnabled,
        }}
      />

      <section aria-labelledby="categories-heading">
        <SectionHeading id="categories-heading">Categories</SectionHeading>
        <Card className="p-4">
          <CategoryManager categories={categories} />
        </Card>
      </section>

      <section aria-labelledby="data-heading">
        <SectionHeading id="data-heading">Your data</SectionHeading>
        <Card className="flex flex-col gap-3 p-4">
          <p className="text-sm text-slate">
            Export everything as an .ics file for any other calendar, or import from one. Recurring
            items keep their rules in both directions.
          </p>
          <IcsTools />
          <p className="border-t border-mist pt-3 text-xs text-slate">
            Signed in as {settings.email}. Your calendar is private to this account, and every read
            and write is checked against it.
          </p>
        </Card>
      </section>
    </div>
  );
}
