// app/agenda/page.tsx
//
// The flat list: everything upcoming, or everything matching a filter. Grouped by local date so the
// only question it answers ("when is it?") is immediate.

import Link from "next/link";
import { CalendarSearch, Search } from "lucide-react";
import { requireUser } from "@/server/guards";
import { prisma } from "@/lib/db";
import { loadOccurrenceViews } from "@/server/queries";
import { AgendaList } from "@/components/agenda/AgendaList";
import { EmptyState } from "@/components/ui/EmptyState";

export const dynamic = "force-dynamic";

export default async function AgendaPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; category?: string; range?: string }>;
}) {
  const user = await requireUser();
  const params = await searchParams;

  const settings = await prisma.user.findUniqueOrThrow({
    where: { id: user.id },
    select: { timezone: true },
  });
  const now = new Date();
  const tz = settings.timezone;

  const rangeDays = params.range === "year" ? 365 : params.range === "week" ? 7 : 60;

  // Past items are included briefly so "what did I miss" is answerable, not just "what is coming".
  const from = new Date(now.getTime() - 14 * 86_400_000);
  const to = new Date(now.getTime() + rangeDays * 86_400_000);

  const all = await loadOccurrenceViews(user.id, { fromUtc: from, toUtc: to }, now);

  const query = params.q?.trim().toLowerCase() ?? "";
  const views = all.filter((view) => {
    if (params.category && view.category?.id !== params.category) return false;
    if (!query) return true;
    return (
      view.title.toLowerCase().includes(query) ||
      (view.location ?? "").toLowerCase().includes(query) ||
      (view.notes ?? "").toLowerCase().includes(query)
    );
  });

  const categories = await prisma.category.findMany({
    where: { userId: user.id },
    orderBy: { name: "asc" },
  });

  const serverTimeIso = now.toISOString();

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold text-ink">Agenda</h1>
      <p className="-mt-3 text-sm text-slate">
        {query || params.category ? "Filtered" : `Next ${rangeDays} days, and the last two weeks`}
      </p>

      <form method="get" className="flex flex-wrap items-end gap-2">
        <div className="flex flex-1 flex-col gap-1">
          <label htmlFor="agenda-q" className="text-sm font-medium text-ink">
            Search
          </label>
          <div className="relative">
            <Search aria-hidden className="absolute top-3.5 left-3 size-4 text-slate" />
            <input
              id="agenda-q"
              name="q"
              defaultValue={params.q ?? ""}
              placeholder="Title, place or note"
              className="min-h-11 w-full rounded-lg border border-mist bg-surface pr-3 pl-9 text-base text-ink placeholder:text-slate/60 focus:border-primary-400"
            />
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="agenda-category" className="text-sm font-medium text-ink">
            Category
          </label>
          <select
            id="agenda-category"
            name="category"
            defaultValue={params.category ?? ""}
            className="min-h-11 rounded-lg border border-mist bg-surface px-3 text-base text-ink"
          >
            <option value="">All</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="agenda-range" className="text-sm font-medium text-ink">
            Range
          </label>
          <select
            id="agenda-range"
            name="range"
            defaultValue={params.range ?? "60"}
            className="min-h-11 rounded-lg border border-mist bg-surface px-3 text-base text-ink"
          >
            <option value="week">Next 7 days</option>
            <option value="60">Next 60 days</option>
            <option value="year">Next year</option>
          </select>
        </div>

        <button
          type="submit"
          className="transition-quiet min-h-11 rounded-lg bg-primary-500 px-4 text-sm font-medium text-white hover:bg-primary-600"
        >
          Apply
        </button>
        {(query || params.category) ? (
          <Link href="/agenda" className="px-2 py-2 text-sm text-primary-600 hover:underline">
            Clear
          </Link>
        ) : null}
      </form>

      {views.length === 0 ? (
        <EmptyState
          icon={CalendarSearch}
          title={query || params.category ? "Nothing matches that" : "Nothing scheduled"}
          description={
            query || params.category
              ? "Try a different word, or clear the filters."
              : "Your agenda is clear for the next while."
          }
          action={
            query || params.category ? (
              <Link href="/agenda" className="text-sm text-primary-600 hover:underline">
                Clear filters
              </Link>
            ) : null
          }
        />
      ) : (
        <AgendaList views={views} viewerTz={tz} serverTimeIso={serverTimeIso} />
      )}
    </div>
  );
}
