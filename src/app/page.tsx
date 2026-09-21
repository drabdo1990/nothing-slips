// app/page.tsx
//
// THE today dashboard. Its one job: answer "what's now / what's next / what's overdue" in under a
// second of looking. Everything else on this page is secondary and visually quieter.

import Link from "next/link";
import { DateTime } from "luxon";
import { AlarmClock, ArrowRight, Bell, Moon, Sun } from "lucide-react";
import { requireUser } from "@/server/guards";
import { prisma } from "@/lib/db";
import { loadDay, summariseToday, type OccurrenceView } from "@/server/queries";
import { dayWindowUtc, localDateString } from "@/lib/time/zone";
import { formatDateHeadingAria, formatOccurrenceWhen, formatTime } from "@/lib/time/format";
import { shapeOfDay, type BusyBlock } from "@/lib/conflicts";
import { Card, SectionHeading } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ButtonLink } from "@/components/ui/Button";
import { OccurrenceCard } from "@/components/event/OccurrenceCard";
import { QuickAdd } from "@/components/event/QuickAdd";
import { Countdown } from "@/components/event/Countdown";
import { NotificationPermissionCard } from "@/components/alarm/NotificationPermissionCard";
import { DndToggle } from "@/components/settings/DndToggle";

export const dynamic = "force-dynamic";

function toBusyBlocks(views: OccurrenceView[]): BusyBlock[] {
  return views.map((view) => ({
    id: view.key,
    title: view.title,
    startUtc:
      view.when.kind === "allDay"
        ? dayWindowUtc(view.when.startDate, view.timezone).startUtc
        : new Date(view.when.startUtc),
    endUtc:
      view.when.kind === "allDay"
        ? dayWindowUtc(view.when.endDateExclusive, view.timezone).startUtc
        : view.when.endUtc
          ? new Date(view.when.endUtc)
          : new Date(view.when.startUtc),
    bufferBeforeMinutes: view.travelBufferMinutes,
    location: view.location,
  }));
}

export default async function TodayPage() {
  const user = await requireUser();
  const settings = await prisma.user.findUniqueOrThrow({
    where: { id: user.id },
    select: {
      timezone: true,
      dnd: true,
      quietHoursEnabled: true,
      quietHoursStart: true,
      quietHoursEnd: true,
      emailFallbackEnabled: true,
    },
  });

  const now = new Date();
  const serverTimeIso = now.toISOString();
  const todayISO = localDateString(now, settings.timezone);
  const views = await loadDay(user.id, todayISO, settings.timezone, now);
  const summary = summariseToday(views);

  const { startUtc: dayStart, endUtc: dayEnd } = dayWindowUtc(todayISO, settings.timezone);
  const shape = shapeOfDay(toBusyBlocks(summary.all), { startUtc: dayStart, endUtc: dayEnd });

  const nextStartsAt =
    summary.next && summary.next.when.kind === "timed" ? summary.next.when.startUtc : null;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm text-slate">
            {settings.timezone === "UTC" ? "UTC" : settings.timezone.replace(/_/g, " ")}
          </p>
          <h1 className="text-2xl font-semibold text-ink">
            {formatDateHeadingToday(todayISO, settings.timezone)}
          </h1>
          <p className="sr-only">{formatDateHeadingAria(todayISO)}</p>
        </div>
        <DndToggle initialDnd={settings.dnd} />
      </header>

      <NotificationPermissionCard emailFallbackEnabled={settings.emailFallbackEnabled} />

      <QuickAdd />

      {/* ── What's now ───────────────────────────────────────────────────── */}
      {summary.now_occurrences.length > 0 ? (
        <section aria-labelledby="now-heading">
          <SectionHeading id="now-heading">Happening now</SectionHeading>
          <ul className="flex flex-col gap-2">
            {summary.now_occurrences.map((view) => (
              <OccurrenceCard
                key={view.key}
                view={view}
                viewerTz={settings.timezone}
                serverTimeIso={serverTimeIso}
              />
            ))}
          </ul>
        </section>
      ) : null}

      {/* ── What's overdue ───────────────────────────────────────────────── */}
      {summary.overdue.length > 0 ? (
        <section aria-labelledby="overdue-heading">
          <SectionHeading
            id="overdue-heading"
            note={`${summary.overdue.length} ${summary.overdue.length === 1 ? "item" : "items"}`}
          >
            Needs a decision
          </SectionHeading>
          <ul className="flex flex-col gap-2">
            {summary.overdue.map((view) => (
              <OccurrenceCard
                key={view.key}
                view={view}
                viewerTz={settings.timezone}
                serverTimeIso={serverTimeIso}
              />
            ))}
          </ul>
        </section>
      ) : null}

      {/* ── What's next: the hero ────────────────────────────────────────── */}
      <section aria-labelledby="next-heading">
        <SectionHeading id="next-heading">Next up</SectionHeading>

        {summary.next ? (
          <Card className="p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-lg leading-snug font-semibold text-ink">
                  <Link
                    href={`/event/${summary.next.eventId}`}
                    className="transition-quiet hover:text-primary-600"
                  >
                    {summary.next.title}
                  </Link>
                </h3>
                <p className="mt-1 text-base text-ink tabular">
                  {formatOccurrenceWhen(summary.next.when, summary.next.timezone, settings.timezone).text}
                </p>
                {nextStartsAt ? (
                  <p className="mt-1 text-sm text-primary-600">
                    <Countdown targetIso={nextStartsAt} serverTimeIso={serverTimeIso} />
                    <span className="sr-only"> until it starts</span>
                  </p>
                ) : null}
                {summary.next.location ? (
                  <p className="mt-1 text-sm text-slate">{summary.next.location}</p>
                ) : null}
              </div>
              <ArrowRight aria-hidden className="mt-1 size-5 shrink-0 text-slate" />
            </div>

            {summary.next.nextReminder ? (
              <p className="mt-3 flex items-center gap-2 border-t border-mist pt-3 text-xs text-slate">
                <Bell aria-hidden className="size-3.5" />
                Reminder at{" "}
                <span className="tabular">
                  {formatTime(summary.next.nextReminder.scheduledFor, settings.timezone)}
                </span>
                {summary.next.nextReminder.status === "deferred" ? " (held for quiet hours)" : ""}
              </p>
            ) : null}
          </Card>
        ) : summary.now_occurrences.length === 0 && summary.overdue.length === 0 ? (
          <EmptyState
            icon={Sun}
            title="Nothing left today"
            description="The rest of the day is yours. Add something if it comes up."
            action={<ButtonLink href="/agenda" variant="secondary" size="sm">Look ahead</ButtonLink>}
          />
        ) : (
          <EmptyState
            icon={Sun}
            title="That is everything"
            description="No further commitments today."
          />
        )}
      </section>

      {/* ── The rest of the day ──────────────────────────────────────────── */}
      {summary.rest.length > 0 ? (
        <section aria-labelledby="rest-heading">
          <SectionHeading id="rest-heading">Later today</SectionHeading>
          <ul className="flex flex-col gap-2">
            {summary.rest.map((view) => (
              <OccurrenceCard
                key={view.key}
                view={view}
                viewerTz={settings.timezone}
                serverTimeIso={serverTimeIso}
                compact
              />
            ))}
          </ul>
        </section>
      ) : null}

      {/* ── The day's real shape ─────────────────────────────────────────── */}
      {summary.all.length > 0 ? (
        <section aria-labelledby="shape-heading">
          <SectionHeading id="shape-heading">The shape of today</SectionHeading>
          <Card className="p-4">
            <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <Stat label="Committed" value={`${Math.floor(shape.busyMinutes / 60)}h ${shape.busyMinutes % 60}m`} />
              <Stat
                label="Free"
                value={`${Math.floor(
                  (shape.free.reduce((total, slot) => total + slot.minutes, 0)) / 60,
                )}h ${shape.free.reduce((total, slot) => total + slot.minutes, 0) % 60}m`}
              />
              <Stat label="Back-to-back" value={String(shape.backToBackCount)} />
              <Stat label="Items" value={String(summary.all.length)} />
            </dl>

            {shape.free.length > 0 ? (
              <div className="mt-3 border-t border-mist pt-3">
                <p className="text-xs font-medium text-slate">You are free</p>
                <ul className="mt-1 flex flex-wrap gap-2">
                  {shape.free.slice(0, 4).map((slot) => (
                    <li key={slot.startUtc.toISOString()} className="text-xs text-ink tabular">
                      {formatTime(slot.startUtc, settings.timezone)}–
                      {formatTime(slot.endUtc, settings.timezone)}
                      <span className="text-slate"> ({slot.minutes}m)</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </Card>
        </section>
      ) : null}

      {!settings.quietHoursEnabled && !settings.dnd ? (
        <p className="flex items-center gap-2 px-1 text-xs text-slate">
          <Moon aria-hidden className="size-3.5" />
          Quiet hours are off, so alarms can arrive at any time.
          <Link href="/settings" className="text-primary-600 hover:underline">
            Set them
          </Link>
        </p>
      ) : null}

      <p className="flex items-center gap-2 px-1 text-xs text-slate">
        <AlarmClock aria-hidden className="size-3.5" />
        Alarms are checked by the server every minute — closing this tab does not stop them.
      </p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-slate">{label}</dt>
      <dd className="text-base font-medium text-ink tabular">{value}</dd>
    </div>
  );
}

/** "Thursday 21 September" in the viewer's zone. */
function formatDateHeadingToday(dateISO: string, tz: string): string {
  return DateTime.fromISO(dateISO, { zone: tz }).toFormat("cccc d LLLL");
}
