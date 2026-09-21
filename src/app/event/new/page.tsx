// app/event/new/page.tsx

import { requireUser } from "@/server/guards";
import { prisma } from "@/lib/db";
import { EventForm } from "@/components/event/EventForm";
import { QuickAdd } from "@/components/event/QuickAdd";
import { Card } from "@/components/ui/Card";

export const dynamic = "force-dynamic";
export const metadata = { title: "New event" };

export default async function NewEventPage() {
  const user = await requireUser();
  const settings = await prisma.user.findUniqueOrThrow({
    where: { id: user.id },
    select: { timezone: true, defaultReminderOffsets: true },
  });
  const categories = await prisma.category.findMany({
    where: { userId: user.id },
    orderBy: { name: "asc" },
    select: { id: true, name: true, color: true },
  });

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold text-ink">Add something</h1>

      <Card className="p-4">
        <h2 className="mb-2 text-sm font-semibold tracking-wide text-slate uppercase">
          In your own words
        </h2>
        <QuickAdd autoFocus />
      </Card>

      <p className="px-1 text-sm text-slate">…or fill it in.</p>

      <EventForm
        mode="create"
        viewerTz={settings.timezone}
        categories={categories}
        defaultOffsets={settings.defaultReminderOffsets}
        cancelHref="/"
      />
    </div>
  );
}
