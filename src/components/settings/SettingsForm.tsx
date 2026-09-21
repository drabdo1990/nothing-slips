// src/components/settings/SettingsForm.tsx
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Plus } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Checkbox, Field, Input, Select } from "@/components/ui/Field";
import { OFFSET_PRESETS, humanizeOffset, parseOffset } from "@/lib/reminders/offsets";
import { updateSettings } from "@/server/actions/settings";

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

export function SettingsForm({
  initial,
}: {
  initial: {
    name: string;
    timezone: string;
    quietHoursEnabled: boolean;
    quietHoursStart: string;
    quietHoursEnd: string;
    dnd: boolean;
    defaultReminderOffsets: number[];
    emailFallbackEnabled: boolean;
  };
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [form, setForm] = useState(initial);
  const [customOffset, setCustomOffset] = useState("");

  const zones = [...new Set([...COMMON_ZONES, initial.timezone])].sort();

  function update<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    setSaved(false);
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setErrors({});
        startTransition(async () => {
          const result = await updateSettings(form);
          if (!result.ok) {
            setErrors(result.errors);
            return;
          }
          setSaved(true);
          router.refresh();
        });
      }}
    >
      {Object.keys(errors).length > 0 ? (
        <div role="alert" className="rounded-lg border border-danger-500/40 bg-danger-50 p-3 text-sm text-danger-500">
          {Object.values(errors).map((message) => (
            <p key={message}>{message}</p>
          ))}
        </div>
      ) : null}

      <Card className="flex flex-col gap-4 p-4">
        <h2 className="text-sm font-semibold tracking-wide text-slate uppercase">You</h2>

        <Field label="Name" id="settings-name" error={errors.name}>
          <Input
            id="settings-name"
            value={form.name}
            onChange={(event) => update("name", event.target.value)}
            autoComplete="name"
          />
        </Field>

        <Field
          label="Your timezone"
          id="settings-tz"
          hint="Every alarm and every countdown is computed against this. Change it when you move."
          error={errors.timezone}
        >
          <Select
            id="settings-tz"
            value={form.timezone}
            onChange={(event) => update("timezone", event.target.value)}
          >
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </Select>
        </Field>
      </Card>

      <Card className="flex flex-col gap-4 p-4">
        <h2 className="text-sm font-semibold tracking-wide text-slate uppercase">Quiet hours</h2>
        <p className="text-sm text-slate">
          Alarms inside this window are <strong>held, not dropped</strong>. They fire as soon as the
          window ends. Individual events can override this.
        </p>

        <Checkbox
          id="quiet-enabled"
          label="Enable quiet hours"
          checked={form.quietHoursEnabled}
          onChange={(event) => update("quietHoursEnabled", event.target.checked)}
        />

        {form.quietHoursEnabled ? (
          <div className="grid grid-cols-2 gap-4">
            <Field label="From" id="quiet-start" error={errors.quietHoursStart}>
              <Input
                id="quiet-start"
                type="time"
                value={form.quietHoursStart}
                onChange={(event) => update("quietHoursStart", event.target.value)}
              />
            </Field>
            <Field label="To" id="quiet-end" error={errors.quietHoursEnd}>
              <Input
                id="quiet-end"
                type="time"
                value={form.quietHoursEnd}
                onChange={(event) => update("quietHoursEnd", event.target.value)}
              />
            </Field>
          </div>
        ) : null}

        <Checkbox
          id="dnd"
          label="Do not disturb"
          hint="Held until you turn it off and re-evaluated every minute."
          checked={form.dnd}
          onChange={(event) => update("dnd", event.target.checked)}
        />
      </Card>

      <Card className="flex flex-col gap-4 p-4">
        <h2 className="text-sm font-semibold tracking-wide text-slate uppercase">
          Default reminders for new items
        </h2>

        <ul className="flex flex-wrap gap-2">
          {form.defaultReminderOffsets.map((offset) => (
            <li key={offset}>
              <button
                type="button"
                onClick={() =>
                  update(
                    "defaultReminderOffsets",
                    form.defaultReminderOffsets.filter((value) => value !== offset),
                  )
                }
                className="transition-quiet inline-flex min-h-8 items-center gap-1 rounded-full border border-primary-200 bg-primary-50 px-3 text-xs text-primary-700 hover:border-danger-500 hover:text-danger-500"
              >
                {humanizeOffset(offset)}
                <span aria-hidden>×</span>
                <span className="sr-only">Remove</span>
              </button>
            </li>
          ))}
          {form.defaultReminderOffsets.length === 0 ? (
            <li className="text-sm text-warn-500">
              No default reminder — new items will not warn you unless you add one.
            </li>
          ) : null}
        </ul>

        <div className="flex flex-wrap items-end gap-2">
          <Field label="Add" id="default-offset-select" className="flex-1">
            <Select
              id="default-offset-select"
              value=""
              onChange={(event) => {
                const value = Number(event.target.value);
                if (!Number.isNaN(value) && value >= 0 && !form.defaultReminderOffsets.includes(value)) {
                  update(
                    "defaultReminderOffsets",
                    [...form.defaultReminderOffsets, value].sort((a, b) => b - a),
                  );
                }
              }}
            >
              <option value="">Choose a preset…</option>
              {OFFSET_PRESETS.filter((preset) => !form.defaultReminderOffsets.includes(preset.minutes)).map(
                (preset) => (
                  <option key={preset.minutes} value={preset.minutes}>
                    {preset.label}
                  </option>
                ),
              )}
            </Select>
          </Field>

          <Field label="Or type" id="default-offset-custom" hint="1d, 2h, 30m">
            <Input
              id="default-offset-custom"
              value={customOffset}
              onChange={(event) => setCustomOffset(event.target.value)}
            />
          </Field>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              const parsed = parseOffset(customOffset);
              if (parsed === null) return;
              update(
                "defaultReminderOffsets",
                [...new Set([...form.defaultReminderOffsets, parsed])].sort((a, b) => b - a),
              );
              setCustomOffset("");
            }}
          >
            <Plus aria-hidden className="size-4" />
            Add
          </Button>
        </div>
      </Card>

      <Card className="flex flex-col gap-4 p-4">
        <h2 className="text-sm font-semibold tracking-wide text-slate uppercase">Fallback</h2>
        <Checkbox
          id="email-fallback"
          label="Email me if push cannot reach this device"
          hint="Used when notifications are blocked, or when no device is subscribed."
          checked={form.emailFallbackEnabled}
          onChange={(event) => update("emailFallbackEnabled", event.target.checked)}
        />
      </Card>

      <div className="sticky bottom-16 flex items-center justify-end gap-3 rounded-xl border border-mist bg-surface/95 p-3 backdrop-blur">
        {saved ? (
          <span className="flex items-center gap-1 text-sm text-success-500">
            <Check aria-hidden className="size-4" />
            Saved
          </span>
        ) : null}
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save settings"}
        </Button>
      </div>
    </form>
  );
}
