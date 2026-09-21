// src/components/event/OccurrenceCard.tsx
//
// One row in Today / Agenda / Day view. Everything it renders was computed on the server by
// `loadOccurrenceViews`, including the phase and the zone labelling — this component makes no
// decisions about time.

import Link from "next/link";
import { MapPin, Repeat } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { StatusPill, ReminderStatusBadge } from "@/components/ui/StatusPill";
import { cn } from "@/components/ui/cn";
import { formatOccurrenceWhen } from "@/lib/time/format";
import { humanizeOffset } from "@/lib/reminders/offsets";
import { PHASE_CLASSES } from "@/lib/time/status";
import type { OccurrenceView } from "@/server/queries";
import { OccurrenceActions } from "./OccurrenceActions";
import { Countdown } from "./Countdown";

export function OccurrenceCard({
  view,
  viewerTz,
  serverTimeIso,
  compact = false,
}: {
  view: OccurrenceView;
  viewerTz: string;
  serverTimeIso: string;
  compact?: boolean;
}) {
  const formatted = formatOccurrenceWhen(view.when, view.timezone, viewerTz);
  const styles = PHASE_CLASSES[view.phase];
  const href = `/event/${view.eventId}?occ=${encodeURIComponent(view.key)}`;

  // The next alarm for this occurrence, so "scheduled" vs "alarmed" is visible at a glance.
  const reminder = view.nextReminder;
  const reminderLabel = reminder
    ? view.done
      ? "Acknowledged"
      : humanizeOffset(reminder.offsetMinutes)
    : null;

  const countdownTarget =
    view.when.kind === "timed" && (view.phase === "imminent" || view.phase === "now")
      ? view.when.startUtc
      : null;

  return (
    <Card
      as="li"
      className={cn(
        "transition-quiet list-none p-3 hover:border-primary-300",
        view.phase === "overdue" && !view.done && "border-danger-500/40",
        view.done && "opacity-70",
      )}
    >
      <div className="flex items-start gap-3">
        {/* The phase rail: a colour AND a width, so it reads without colour. */}
        <span aria-hidden className={cn("mt-1 w-1 self-stretch rounded-full", styles.dot)} />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            {view.when.kind === "allDay" ? (
              <span className="text-sm font-semibold text-ink">All day</span>
            ) : (
              <time dateTime={view.when.startUtc} className="text-sm font-semibold text-ink tabular">
                {formatted.text}
              </time>
            )}
            {countdownTarget ? (
              <Countdown
                targetIso={countdownTarget}
                serverTimeIso={serverTimeIso}
                className={cn("text-xs font-medium", styles.text)}
              />
            ) : null}
          </div>

          <h3 className={cn("mt-1 text-base leading-snug font-medium text-ink", view.done && "line-through")}>
            <Link href={href} className="transition-quiet hover:text-primary-600">
              {view.title}
            </Link>
          </h3>

          {/* The zone is labelled whenever it differs from the viewer's — never silently converted. */}
          {formatted.crossZone ? (
            <p className="mt-0.5 text-xs text-slate">{formatted.ariaLabel}</p>
          ) : (
            <span className="sr-only">{formatted.ariaLabel}</span>
          )}

          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-slate">
            <StatusPill phase={view.phase} />
            {view.category ? (
              <span className="inline-flex items-center gap-1">
                <span
                  aria-hidden
                  className="size-2 rounded-full"
                  style={{ backgroundColor: view.category.color }}
                />
                {view.category.name}
              </span>
            ) : null}
            {view.rrule ? (
              <span className="inline-flex items-center gap-1">
                <Repeat aria-hidden className="size-3" />
                Repeats
              </span>
            ) : null}
            {view.location ? (
              <span className="inline-flex min-w-0 items-center gap-1">
                <MapPin aria-hidden className="size-3 shrink-0" />
                <span className="truncate">{view.location}</span>
              </span>
            ) : null}
          </div>

          {!compact && reminder && reminderLabel ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="text-xs text-slate">Reminder {reminderLabel.toLowerCase()}</span>
              <ReminderStatusBadge status={reminder.status} lateBySeconds={reminder.lateBySeconds} />
            </div>
          ) : null}
        </div>

        <OccurrenceActions
          occurrenceKey={view.key}
          eventId={view.eventId}
          recurring={view.rrule !== null}
        />
      </div>
    </Card>
  );
}
