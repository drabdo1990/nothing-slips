// src/components/calendar/CalendarToolbar.tsx
"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/components/ui/cn";

const VIEWS = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
] as const;

export type CalendarViewName = (typeof VIEWS)[number]["value"];

/** Navigation is URL state, so a view is shareable, bookmarkable and back-button-correct. */
export function CalendarToolbar({
  view,
  anchorISO,
  previousISO,
  nextISO,
  todayISO,
  title,
}: {
  view: CalendarViewName;
  anchorISO: string;
  previousISO: string;
  nextISO: string;
  todayISO: string;
  title: string;
}) {
  const router = useRouter();
  const params = useSearchParams();

  const hrefFor = (nextView: string, date: string) => {
    const search = new URLSearchParams(params.toString());
    search.set("view", nextView);
    search.set("date", date);
    return `/calendar?${search.toString()}`;
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <Link
            href={hrefFor(view, previousISO)}
            aria-label={`Previous ${view}`}
            className="transition-quiet rounded-lg border border-mist p-2 text-slate hover:border-primary-300 hover:text-ink"
          >
            <ChevronLeft aria-hidden className="size-4" />
          </Link>
          <Link
            href={hrefFor(view, nextISO)}
            aria-label={`Next ${view}`}
            className="transition-quiet rounded-lg border border-mist p-2 text-slate hover:border-primary-300 hover:text-ink"
          >
            <ChevronRight aria-hidden className="size-4" />
          </Link>
          <Link href={hrefFor(view, todayISO)} className="transition-quiet ml-1 text-sm text-primary-600 hover:underline">
            Today
          </Link>
        </div>

        <p aria-live="polite" className="text-sm font-medium text-ink">
          {title}
        </p>
      </div>

      <div
        role="tablist"
        aria-label="Calendar view"
        className="flex gap-1 rounded-lg border border-mist bg-surface p-1"
      >
        {VIEWS.map((option) => (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={view === option.value}
            onClick={() => router.push(hrefFor(option.value, anchorISO))}
            className={cn(
              "transition-quiet min-h-9 flex-1 rounded-md text-sm font-medium",
              view === option.value ? "bg-primary-500 text-white" : "text-slate hover:text-ink",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
