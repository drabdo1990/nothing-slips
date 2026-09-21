// app/event/[id]/page.tsx
//
// Event detail. Three things it must do:
//   1. show exactly when this occurrence is, zone-labelled
//   2. show the ALARM AUDIT TRAIL — every attempt, its channel, its result, and how late it was
//   3. let the user edit it, choosing this / this-and-future / all
//
// (2) is the reason this page exists at all. "Did it actually alarm me?" has to be answerable.

import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Bell, CircleAlert, MapPin } from "lucide-react";
import { requireUser } from "@/server/guards";
import { prisma } from "@/lib/db";
import { loadEventDetail } from "@/server/queries";
import { formatLateness, formatOccurrenceWhen } from "@/lib/time/format";
import { toDateTimeLocalValue } from "@/lib/time/zone";
import { humanizeOffset } from "@/lib/reminders/offsets";
import { Card, SectionHeading } from "@/components/ui/Card";
import { StatusPill, ReminderStatusBadge } from "@/components/ui/StatusPill";
import { EventForm, type EventFormInitial } from "@/components/event/EventForm";
import { SnoozeAckControls } from "@/components/event/SnoozeAckControls";

export const dynamic = "force-dynamic";

export default async function EventDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ occ?: string; r?: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const { occ, r } = await searchParams;

  const now = new Date();
  const detail = await loadEventDetail(user.id, id, now);
  if (!detail) notFound();

  // Prefer the occurrence named in the URL (that is what a notification deep-links to), then the
  // nearest upcoming one.
  const focus =
    (occ ? detail.occurrences.find((view) => view.key === occ) : undefined) ??
    detail.occurrences.find((view) => view.phase === "now" || view.phase === "imminent") ??
    detail.occurrences[0];

  if (!focus) notFound();

  const settings = await prisma.user.findUniqueOrThrow({
    where: { id: user.id },
    select: { timezone: true, defaultReminderOffsets: true },
  });
  const categories = await prisma.category.findMany({
    where: { userId: user.id },
    orderBy: { name: "asc" },
    select: { id: true, name: true, color: true },
  });

  // The effective row: the override when this occurrence has one, else the master.
  const event = await prisma.event.findFirstOrThrow({
    where: { id: focus.eventId, userId: user.id },
    include: { reminderRules: { orderBy: { offsetMinutes: "desc" } } },
  });

  const reminders = await prisma.reminder.findMany({
    where: { userId: user.id, occurrenceId: focus.key },
    orderBy: { scheduledFor: "asc" },
    include: { logs: { orderBy: { attemptedAt: "desc" }, take: 8 } },
  });

  const formatted = formatOccurrenceWhen(focus.when, focus.timezone, settings.timezone);
  const highlighted = r ? reminders.find((reminder) => reminder.id === r) : undefined;

  const initial: EventFormInitial = {
    eventId: event.id,
    occurrenceKey: focus.key,
    occurrenceStart: focus.when.kind === "allDay" ? focus.when.startDate : focus.when.startUtc,
    recurring: focus.rrule !== null,
    defaultScope: event.seriesId ? "this" : "series",
    values: {
      title: event.title,
      notes: event.notes,
      location: event.location,
      categoryId: event.categoryId,
      allDay: event.allDay,
      timezone: event.timezone,
      startLocal: event.startUtc ? toDateTimeLocalValue(event.startUtc, event.timezone) : "",
      endLocal: event.endUtc ? toDateTimeLocalValue(event.endUtc, event.timezone) : "",
      startDate: event.startDate ?? "",
      endDateExclusive: event.endDate ?? "",
      rrule: event.rrule,
      overrideQuietHours: event.overrideQuietHours,
      travelBufferMinutes: event.travelBufferMinutes,
      reminderOffsets: event.reminderRules.map((rule) => rule.offsetMinutes),
    },
  };

  return (
    <div className="flex flex-col gap-5">
      <Link
        href="/agenda"
        className="transition-quiet inline-flex items-center gap-1 text-sm text-slate hover:text-ink"
      >
        <ArrowLeft aria-hidden className="size-4" />
        Back
      </Link>

      <header className="flex flex-col gap-2">
        <h1 className="text-2xl leading-tight font-semibold text-ink">{focus.title}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill phase={focus.phase} />
          {focus.isOverride ? (
            <span className="rounded-full border border-mist px-2 py-0.5 text-xs text-slate">
              Edited for this occurrence only
            </span>
          ) : null}
          {focus.category ? (
            <span className="inline-flex items-center gap-1 text-xs text-slate">
              <span
                aria-hidden
                className="size-2 rounded-full"
                style={{ backgroundColor: focus.category.color }}
              />
              {focus.category.name}
            </span>
          ) : null}
        </div>

        <p className="text-lg text-ink tabular" aria-hidden>
          {formatted.text}
        </p>
        <p className="text-sm text-slate">{formatted.ariaLabel}</p>
        {formatted.crossZone ? (
          <p className="text-xs text-slate">
            Shown in your zone. The event is pinned to {focus.timezone.replace(/_/g, " ")}.
          </p>
        ) : null}

        {focus.location ? (
          <p className="flex items-center gap-2 text-sm text-slate">
            <MapPin aria-hidden className="size-4" />
            {focus.location}
          </p>
        ) : null}
      </header>

      {focus.notes ? (
        <Card className="p-4">
          <p className="text-sm whitespace-pre-wrap text-ink">{focus.notes}</p>
        </Card>
      ) : null}

      {/* ── Alarm audit trail ─────────────────────────────────────────────── */}
      <section aria-labelledby="alarms-heading">
        <SectionHeading id="alarms-heading" note={`${reminders.length} scheduled`}>
          Alarms
        </SectionHeading>

        {reminders.length === 0 ? (
          <Card className="flex items-center gap-3 border-warn-500/30 bg-warn-50 p-4">
            <CircleAlert aria-hidden className="size-5 shrink-0 text-warn-500" />
            <p className="text-sm text-ink">
              This occurrence has no alarm. Add one below so it cannot slip.
            </p>
          </Card>
        ) : (
          <ul className="flex flex-col gap-2">
            {reminders.map((reminder) => (
              <Card
                as="li"
                key={reminder.id}
                className={highlighted?.id === reminder.id ? "border-primary-400 p-3" : "p-3"}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-sm text-ink">
                    <Bell aria-hidden className="size-4 text-primary-500" />
                    <span>{humanizeOffset(reminder.offsetMinutes)}</span>
                    <span className="text-slate tabular">
                      {new Date(reminder.scheduledFor)
                        .toISOString()
                        .slice(11, 16)}{" "}
                      UTC
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <ReminderStatusBadge status={reminder.status} lateBySeconds={reminder.lateBySeconds} />
                    <SnoozeAckControls
                      reminderId={reminder.id}
                      status={reminder.status}
                      acknowledged={reminder.acknowledgedAt !== null}
                    />
                  </div>
                </div>

                {reminder.lastError ? (
                  <p className="mt-2 text-xs text-warn-500">Last result: {reminder.lastError}</p>
                ) : null}

                {reminder.logs.length > 0 ? (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-slate">
                      Delivery log ({reminder.logs.length})
                    </summary>
                    <ul className="mt-1 flex flex-col gap-1">
                      {reminder.logs.map((log) => (
                        <li key={log.id} className="text-xs text-slate tabular">
                          <time dateTime={log.attemptedAt.toISOString()}>
                            {log.attemptedAt.toISOString().replace("T", " ").slice(0, 16)}
                          </time>{" "}
                          · {log.channel} · {log.result}
                          {log.detail ? ` · ${log.detail}` : ""}
                          {log.lateBySeconds !== null && log.lateBySeconds >= 45
                            ? ` · ${formatLateness(log.lateBySeconds)}`
                            : ""}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : (
                  <p className="mt-2 text-xs text-slate">No delivery attempts recorded yet.</p>
                )}
              </Card>
            ))}
          </ul>
        )}
      </section>

      {/* ── Other occurrences ─────────────────────────────────────────────── */}
      {detail.occurrences.length > 1 ? (
        <section aria-labelledby="series-heading">
          <SectionHeading id="series-heading">
            {detail.occurrences.length} occurrences in view
          </SectionHeading>
          <ul className="flex flex-wrap gap-2">
            {detail.occurrences.slice(0, 12).map((view) => (
              <li key={view.key}>
                <Link
                  href={`/event/${view.eventId}?occ=${encodeURIComponent(view.key)}`}
                  className={`transition-quiet inline-flex items-center rounded-full border px-3 py-1 text-xs tabular ${
                    view.key === focus.key
                      ? "border-primary-500 bg-primary-50 text-primary-700"
                      : "border-mist text-slate hover:border-primary-300 hover:text-ink"
                  }`}
                >
                  {view.when.kind === "allDay"
                    ? view.when.startDate
                    : new Date(view.when.startUtc).toISOString().slice(5, 16).replace("T", " ")}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="edit-heading">
        <SectionHeading id="edit-heading">Edit</SectionHeading>
        <EventForm
          mode="edit"
          viewerTz={settings.timezone}
          categories={categories}
          defaultOffsets={settings.defaultReminderOffsets}
          initial={initial}
          cancelHref={`/event/${event.id}`}
        />
      </section>
    </div>
  );
}
