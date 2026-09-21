// src/components/agenda/AgendaList.tsx
//
// The flat list. Grouped by local date, with a sticky day heading, because "when is it" is the only
// question this view exists to answer.

import { DateTime } from "luxon";
import { OccurrenceCard } from "@/components/event/OccurrenceCard";
import { formatDateHeading, formatDateHeadingAria } from "@/lib/time/format";
import type { OccurrenceView } from "@/server/queries";

export function AgendaList({
  views,
  viewerTz,
  serverTimeIso,
  emptyMessage = "Nothing here yet.",
}: {
  views: OccurrenceView[];
  viewerTz: string;
  serverTimeIso: string;
  emptyMessage?: string;
}) {
  if (views.length === 0) {
    return <p className="rounded-lg border border-dashed border-mist px-4 py-8 text-center text-sm text-slate">{emptyMessage}</p>;
  }

  // Group by the date the viewer would put it on, not by UTC.
  const groups = new Map<string, OccurrenceView[]>();
  for (const view of views) {
    const date =
      view.when.kind === "allDay"
        ? view.when.startDate
        : DateTime.fromJSDate(new Date(view.when.startUtc), { zone: "utc" }).setZone(viewerTz).toISODate()!;
    const list = groups.get(date) ?? [];
    list.push(view);
    groups.set(date, list);
  }

  const dates = [...groups.keys()].sort();

  return (
    <div className="flex flex-col gap-6">
      {dates.map((date) => {
        const items = groups.get(date)!;
        return (
          <section key={date} aria-labelledby={`agenda-${date}`}>
            <h2
              id={`agenda-${date}`}
              className="sticky top-0 z-10 mb-2 flex items-baseline gap-2 bg-paper/95 px-1 py-1 backdrop-blur"
            >
              <span className="text-sm font-semibold text-ink">{formatDateHeading(date, viewerTz)}</span>
              <span className="sr-only">{formatDateHeadingAria(date)}</span>
              <span className="text-xs text-slate tabular">
                {items.length} {items.length === 1 ? "item" : "items"}
              </span>
            </h2>
            <ul className="flex flex-col gap-2">
              {items.map((view) => (
                <OccurrenceCard
                  key={view.key}
                  view={view}
                  viewerTz={viewerTz}
                  serverTimeIso={serverTimeIso}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
