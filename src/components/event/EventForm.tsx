// src/components/event/EventForm.tsx
"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AlertTriangle, Bell, Plus, Trash2 } from "lucide-react";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/Field";
import { cn } from "@/components/ui/cn";
import { formatOccurrenceWhen } from "@/lib/time/format";
import { fromDateTimeLocalValue, toDateTimeLocalValue } from "@/lib/time/zone";
import { OFFSET_PRESETS, humanizeOffset, parseOffset } from "@/lib/reminders/offsets";
import type { Conflict } from "@/lib/conflicts";
import type { MutationScope } from "@/lib/validation";
import { createEvent, deleteEvent, updateEvent } from "@/server/actions/events";

type Freq = "NONE" | "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

const WEEKDAY_OPTIONS = [
  { code: "MO", label: "Mon" },
  { code: "TU", label: "Tue" },
  { code: "WE", label: "Wed" },
  { code: "TH", label: "Thu" },
  { code: "FR", label: "Fri" },
  { code: "SA", label: "Sat" },
  { code: "SU", label: "Sun" },
] as const;

export interface EventFormInitial {
  eventId: string;
  occurrenceKey: string;
  /** UTC ISO for timed, YYYY-MM-DD for all-day. */
  occurrenceStart: string;
  recurring: boolean;
  defaultScope: MutationScope;
  values: {
    title: string;
    notes: string | null;
    location: string | null;
    categoryId: string | null;
    allDay: boolean;
    timezone: string;
    /** "YYYY-MM-DDTHH:mm" wall clock in `timezone`, or "" for all-day. */
    startLocal: string;
    endLocal: string;
    startDate: string;
    endDateExclusive: string;
    rrule: string | null;
    overrideQuietHours: boolean;
    travelBufferMinutes: number;
    reminderOffsets: number[];
  };
}

/** A short, honest list. The full IANA set is offered via Intl where the browser supports it. */
const COMMON_ZONES = [
  "UTC",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Madrid",
  "Europe/Warsaw",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
];

function zoneOptions(current: string): string[] {
  const zones = new Set(COMMON_ZONES);
  zones.add(current);
  try {
    const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
    if (supported) for (const zone of supported("timeZone")) zones.add(zone);
  } catch {
    /* older browser: the common list is enough */
  }
  return [...zones].sort();
}

function parseRrule(rrule: string | null): {
  freq: Freq;
  interval: number;
  byday: string[];
  until: string;
} {
  if (!rrule) return { freq: "NONE", interval: 1, byday: [], until: "" };
  const freq = (rrule.match(/FREQ=([A-Z]+)/)?.[1] ?? "WEEKLY") as Freq;
  const interval = Number(rrule.match(/INTERVAL=(\d+)/)?.[1] ?? 1);
  const byday = rrule.match(/BYDAY=([A-Z,]+)/)?.[1]?.split(",") ?? [];
  const untilRaw = rrule.match(/UNTIL=(\d{4})(\d{2})(\d{2})/);
  return {
    freq,
    interval,
    byday,
    until: untilRaw ? `${untilRaw[1]}-${untilRaw[2]}-${untilRaw[3]}` : "",
  };
}

function buildRrule(freq: Freq, interval: number, byday: string[], until: string): string | null {
  if (freq === "NONE") return null;
  const parts = [`FREQ=${freq}`];
  if (interval > 1) parts.push(`INTERVAL=${interval}`);
  if (freq === "WEEKLY" && byday.length > 0) parts.push(`BYDAY=${byday.join(",")}`);
  if (until) parts.push(`UNTIL=${until.replace(/-/g, "")}T235959Z`);
  return parts.join(";");
}

/** "2026-09-21T09:00" in a zone → UTC ISO. The single conversion point in the form. */
function localInputToUtcIso(value: string, timezone: string): string | null {
  return fromDateTimeLocalValue(value, timezone)?.toISOString() ?? null;
}

export function EventForm({
  mode,
  viewerTz,
  categories,
  defaultOffsets,
  initial,
  cancelHref,
}: {
  mode: "create" | "edit";
  viewerTz: string;
  categories: { id: string; name: string; color: string }[];
  defaultOffsets: number[];
  initial?: EventFormInitial;
  cancelHref: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [scope, setScope] = useState<MutationScope>(initial?.defaultScope ?? "series");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const seed = initial?.values;
  const [title, setTitle] = useState(seed?.title ?? "");
  const [allDay, setAllDay] = useState(seed?.allDay ?? false);
  const [timezone, setTimezone] = useState(seed?.timezone ?? viewerTz);
  const [startLocal, setStartLocal] = useState(seed?.startLocal ?? "");
  const [endLocal, setEndLocal] = useState(seed?.endLocal ?? "");
  const [startDate, setStartDate] = useState(seed?.startDate ?? "");
  const [endDateExclusive, setEndDateExclusive] = useState(seed?.endDateExclusive ?? "");
  const [location, setLocation] = useState(seed?.location ?? "");
  const [notes, setNotes] = useState(seed?.notes ?? "");
  const [categoryId, setCategoryId] = useState(seed?.categoryId ?? "");
  const [overrideQuietHours, setOverrideQuietHours] = useState(seed?.overrideQuietHours ?? false);
  const [travelBufferMinutes, setTravelBufferMinutes] = useState(seed?.travelBufferMinutes ?? 0);
  const [offsets, setOffsets] = useState<number[]>(seed?.reminderOffsets ?? defaultOffsets);
  const [customOffset, setCustomOffset] = useState("");

  const parsed = useMemo(() => parseRrule(seed?.rrule ?? null), [seed?.rrule]);
  const [freq, setFreq] = useState<Freq>(parsed.freq);
  const [interval, setInterval] = useState(parsed.interval);
  const [byday, setByday] = useState<string[]>(parsed.byday);
  const [until, setUntil] = useState(parsed.until);

  const zones = useMemo(() => zoneOptions(timezone), [timezone]);
  const rrule = buildRrule(freq, interval, byday, until);

  // A live, screen-reader-friendly echo of what will be saved.
  const echo = useMemo(() => {
    if (!allDay) {
      const startIso = localInputToUtcIso(startLocal, timezone);
      const endIso = localInputToUtcIso(endLocal, timezone);
      if (!startIso) return null;
      return formatOccurrenceWhen({ kind: "timed", startUtc: startIso, endUtc: endIso }, timezone, viewerTz);
    }
    if (!startDate) return null;
    return formatOccurrenceWhen(
      { kind: "allDay", startDate, endDateExclusive: endDateExclusive || nextDay(startDate) },
      timezone,
      viewerTz,
    );
  }, [allDay, startLocal, endLocal, startDate, endDateExclusive, timezone, viewerTz]);

  function payload() {
    return {
      title,
      notes: notes || null,
      location: location || null,
      categoryId: categoryId || null,
      allDay,
      timezone,
      startUtc: allDay ? null : localInputToUtcIso(startLocal, timezone),
      endUtc: allDay ? null : localInputToUtcIso(endLocal, timezone),
      startDate: allDay ? startDate : null,
      endDate: allDay ? (endDateExclusive || nextDay(startDate)) : null,
      rrule,
      overrideQuietHours,
      travelBufferMinutes,
      reminders: offsets.map((offsetMinutes) => ({ offsetMinutes, channels: ["push", "email"] })),
    };
  }

  function submit() {
    setErrors({});
    setConflicts([]);

    startTransition(async () => {
      const result =
        mode === "create"
          ? await createEvent(payload())
          : await updateEvent({
              eventId: initial!.eventId,
              occurrenceStart: initial!.occurrenceStart,
              scope,
              values: payload(),
            });

      if (!result.ok) {
        setErrors(result.errors);
        return;
      }
      if ("conflicts" in result.data && result.data.conflicts.length > 0) {
        setConflicts(result.data.conflicts);
        if (mode === "create" && "id" in result.data) setSavedId(result.data.id as string);
        return;
      }

      router.push(cancelHref);
      router.refresh();
    });
  }

  function remove() {
    startTransition(async () => {
      const result = await deleteEvent({
        eventId: initial!.eventId,
        occurrenceStart: initial!.occurrenceStart,
        scope,
      });
      if (!result.ok) {
        setErrors(result.errors);
        return;
      }
      router.push("/agenda");
      router.refresh();
    });
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {Object.keys(errors).length > 0 ? (
        <div role="alert" className="rounded-lg border border-danger-500/40 bg-danger-50 p-3 text-sm text-danger-500">
          <p className="font-medium">Some details need fixing</p>
          <ul className="mt-1 list-inside list-disc">
            {Object.entries(errors).map(([key, message]) => (
              <li key={key}>{message}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {conflicts.length > 0 ? (
        <div role="status" className="rounded-lg border border-warn-500/40 bg-warn-50 p-3 text-sm text-ink">
          <p className="flex items-center gap-2 font-medium text-warn-500">
            <AlertTriangle aria-hidden className="size-4" />
            Saved — but it collides with something else.
          </p>
          <ul className="mt-1 list-inside list-disc text-slate">
            {conflicts.map((conflict) => (
              <li key={conflict.withId}>
                {conflict.kind === "overlap"
                  ? `Overlaps another event by ${conflict.overlapMinutes} min`
                  : `Only ${conflict.gapMinutes} min to travel`}
              </li>
            ))}
          </ul>
          <div className="mt-2 flex gap-2">
            <ButtonLink
              size="sm"
              variant="secondary"
              href={`/event/${savedId ?? initial?.eventId ?? ""}`}
            >
              View it
            </ButtonLink>
            <Button size="sm" variant="ghost" type="button" onClick={() => router.push(cancelHref)}>
              Dismiss
            </Button>
          </div>
        </div>
      ) : null}

      <Card className="flex flex-col gap-4 p-4">
        <Field label="What is it?" id="title" error={errors.title}>
          <Input
            id="title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Dentist"
            autoComplete="off"
            required
          />
        </Field>

        <Checkbox
          id="all-day"
          label="All day"
          hint="All-day items are stored as dates, so they never shift by timezone."
          checked={allDay}
          onChange={(event) => setAllDay(event.target.checked)}
        />

        <Field
          label="Timezone"
          id="timezone"
          hint="The wall clock this event is pinned to. Your schedule is shown in your own zone."
        >
          <Select id="timezone" value={timezone} onChange={(event) => setTimezone(event.target.value)}>
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </Select>
        </Field>

        {allDay ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Starts" id="start-date" error={errors.startDate}>
              <Input
                id="start-date"
                type="date"
                value={startDate}
                onChange={(event) => setStartDate(event.target.value)}
              />
            </Field>
            <Field
              label="Ends"
              id="end-date"
              hint="Exclusive — an event ending on the 3rd finishes before it."
              error={errors.endDate}
            >
              <Input
                id="end-date"
                type="date"
                value={endDateExclusive || (startDate ? nextDay(startDate) : "")}
                onChange={(event) => setEndDateExclusive(event.target.value)}
              />
            </Field>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Starts" id="start-local" error={errors.startUtc}>
              <Input
                id="start-local"
                type="datetime-local"
                value={startLocal}
                onChange={(event) => setStartLocal(event.target.value)}
              />
            </Field>
            <Field label="Ends" id="end-local" error={errors.endUtc}>
              <Input
                id="end-local"
                type="datetime-local"
                value={endLocal}
                onChange={(event) => setEndLocal(event.target.value)}
              />
            </Field>
          </div>
        )}

        {echo ? (
          <p className="text-sm text-slate">
            Saves as <span className="tabular text-ink">{echo.text}</span>
            <span className="block text-xs">{echo.ariaLabel}</span>
          </p>
        ) : null}
      </Card>

      <Card className="flex flex-col gap-4 p-4">
        <h2 className="text-sm font-semibold tracking-wide text-slate uppercase">Repeats</h2>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Frequency" id="freq">
            <Select id="freq" value={freq} onChange={(event) => setFreq(event.target.value as Freq)}>
              <option value="NONE">Does not repeat</option>
              <option value="DAILY">Daily</option>
              <option value="WEEKLY">Weekly</option>
              <option value="MONTHLY">Monthly</option>
              <option value="YEARLY">Yearly</option>
            </Select>
          </Field>

          {freq !== "NONE" ? (
            <Field label="Every" id="interval" hint="e.g. 2 = every other week">
              <Input
                id="interval"
                type="number"
                min={1}
                max={52}
                value={interval}
                onChange={(event) => setInterval(Math.max(1, Number(event.target.value) || 1))}
              />
            </Field>
          ) : null}
        </div>

        {freq === "WEEKLY" ? (
          <fieldset>
            <legend className="text-sm font-medium text-ink">On these days</legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {WEEKDAY_OPTIONS.map((day) => {
                const active = byday.includes(day.code);
                return (
                  <label
                    key={day.code}
                    className={cn(
                      "transition-quiet inline-flex min-h-9 cursor-pointer items-center rounded-full border px-3 text-sm",
                      active
                        ? "border-primary-500 bg-primary-50 text-primary-700"
                        : "border-mist text-slate hover:border-primary-300",
                    )}
                  >
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={active}
                      onChange={(event) =>
                        setByday((current) =>
                          event.target.checked
                            ? [...current, day.code]
                            : current.filter((code) => code !== day.code),
                        )
                      }
                    />
                    {day.label}
                  </label>
                );
              })}
            </div>
          </fieldset>
        ) : null}

        {freq !== "NONE" ? (
          <Field label="Until (optional)" id="until" hint="Leave empty to repeat indefinitely">
            <Input id="until" type="date" value={until} onChange={(event) => setUntil(event.target.value)} />
          </Field>
        ) : null}

        {rrule ? (
          <p className="text-xs text-slate">
            Stored as an RFC 5545 rule: <code className="tabular">{rrule}</code>
          </p>
        ) : null}

        {/* Scope is only meaningful when editing one occurrence of a series. */}
        {mode === "edit" && initial?.recurring ? (
          <fieldset className="rounded-lg border border-mist p-3">
            <legend className="px-1 text-sm font-medium text-ink">Which occurrences?</legend>
            <div className="flex flex-col gap-2">
              {(
                [
                  { value: "this", label: "This occurrence only" },
                  { value: "thisAndFuture", label: "This and all future occurrences" },
                  { value: "series", label: "The whole series" },
                ] as const
              ).map((option) => (
                <label key={option.value} className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="scope"
                    value={option.value}
                    checked={scope === option.value}
                    onChange={() => setScope(option.value)}
                    className="size-4 accent-primary-500"
                  />
                  {option.label}
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}
      </Card>

      <Card className="flex flex-col gap-4 p-4">
        <h2 className="text-sm font-semibold tracking-wide text-slate uppercase">Reminders</h2>

        <ul className="flex flex-col gap-2">
          {offsets.length === 0 ? (
            <li className="text-sm text-slate">No reminders. You will not be warned about this one.</li>
          ) : null}
          {offsets.map((offset) => (
            <li
              key={offset}
              className="flex items-center justify-between gap-3 rounded-lg border border-mist px-3 py-2"
            >
              <span className="flex items-center gap-2 text-sm text-ink">
                <Bell aria-hidden className="size-4 text-primary-500" />
                {humanizeOffset(offset)}
              </span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={`Remove the ${humanizeOffset(offset)} reminder`}
                onClick={() => setOffsets((current) => current.filter((value) => value !== offset))}
              >
                <Trash2 aria-hidden className="size-4" />
              </Button>
            </li>
          ))}
        </ul>

        <div className="flex flex-wrap items-end gap-2">
          <Field label="Add a reminder" id="offset-preset" className="flex-1">
            <Select
              id="offset-preset"
              value=""
              onChange={(event) => {
                const value = Number(event.target.value);
                if (!Number.isNaN(value) && value >= 0) {
                  setOffsets((current) => [...new Set([...current, value])].sort((a, b) => b - a));
                }
              }}
            >
              <option value="">Choose…</option>
              {OFFSET_PRESETS.filter((preset) => !offsets.includes(preset.minutes)).map((preset) => (
                <option key={preset.minutes} value={preset.minutes}>
                  {preset.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Or type one" id="offset-custom" hint="1d, 2h, 30m">
            <Input
              id="offset-custom"
              value={customOffset}
              onChange={(event) => setCustomOffset(event.target.value)}
              placeholder="1d"
            />
          </Field>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              const parsedOffset = parseOffset(customOffset);
              if (parsedOffset === null) return;
              setOffsets((current) => [...new Set([...current, parsedOffset])].sort((a, b) => b - a));
              setCustomOffset("");
            }}
          >
            <Plus aria-hidden className="size-4" />
            Add
          </Button>
        </div>

        <Checkbox
          id="override-quiet"
          label="Alarm even during quiet hours"
          hint="Use for things that genuinely cannot be missed."
          checked={overrideQuietHours}
          onChange={(event) => setOverrideQuietHours(event.target.checked)}
        />
      </Card>

      <Card className="flex flex-col gap-4 p-4">
        <Field label="Location" id="location">
          <Input
            id="location"
            value={location}
            onChange={(event) => setLocation(event.target.value)}
            placeholder="Where?"
            autoComplete="off"
          />
        </Field>

        <Field label="Travel buffer (minutes)" id="buffer" hint="Time you need before this to get there">
          <Input
            id="buffer"
            type="number"
            min={0}
            max={240}
            step={5}
            value={travelBufferMinutes}
            onChange={(event) => setTravelBufferMinutes(Math.max(0, Number(event.target.value) || 0))}
          />
        </Field>

        <Field label="Category" id="category">
          <Select id="category" value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
            <option value="">None</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Notes" id="notes">
          <Textarea id="notes" value={notes} onChange={(event) => setNotes(event.target.value)} />
        </Field>
      </Card>

      <div className="sticky bottom-16 flex flex-wrap items-center justify-end gap-2 rounded-xl border border-mist bg-surface/95 p-3 backdrop-blur">
        <ButtonLink href={cancelHref} variant="ghost">
          Cancel
        </ButtonLink>

        {mode === "edit" ? (
          confirmDelete ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-danger-500">
                {initial?.recurring ? `Delete ${scope === "this" ? "this occurrence" : scope === "thisAndFuture" ? "this and future" : "the series"}?` : "Delete this?"}
              </span>
              <Button type="button" variant="danger" size="sm" onClick={remove} disabled={pending}>
                Yes, delete
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
                Keep
              </Button>
            </div>
          ) : (
            <Button type="button" variant="ghost" onClick={() => setConfirmDelete(true)}>
              <Trash2 aria-hidden className="size-4" />
              Delete
            </Button>
          )
        ) : null}

        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : mode === "create" ? "Add it" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}

function nextDay(dateISO: string): string {
  const [y, m, d] = dateISO.split("-").map(Number);
  if (!y || !m || !d) return dateISO;
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}
