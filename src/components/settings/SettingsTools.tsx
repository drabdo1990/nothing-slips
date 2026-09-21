// src/components/settings/SettingsTools.tsx
"use client";

// Push state, the test alarm, categories, and ICS import/export. Grouped because they are all
// "operational" rather than preference settings.

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { BellRing, Download, Upload } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Field, Input } from "@/components/ui/Field";
import { getPushState, subscribeToPush, unsubscribeFromPush, type PushState } from "@/lib/client/push";
import { createCategory, deleteCategory, sendTestAlarm } from "@/server/actions/settings";

export function PushSettings() {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void getPushState().then(setState);
  }, []);

  const labels: Record<PushState, string> = {
    unsupported: "This browser cannot receive push notifications.",
    unconfigured: "Push is not configured on this deployment. Email fallback is used instead.",
    blocked: "Notifications are blocked in your browser settings.",
    subscribed: "Alarms are on for this device.",
    available: "Alarms are not on for this device yet.",
  };

  return (
    <div className="flex flex-col gap-3" id="notifications">
      <p className="text-sm text-slate">{state ? labels[state] : "Checking…"}</p>

      {state === "available" || state === "subscribed" ? (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={busy || state === "subscribed"}
            onClick={async () => {
              setBusy(true);
              const result = await subscribeToPush();
              setState(result.state);
              setMessage(result.ok ? "Alarms are on for this device." : "That did not work.");
              setBusy(false);
            }}
          >
            <BellRing aria-hidden className="size-4" />
            Turn on alarms
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || state !== "subscribed"}
            onClick={async () => {
              setBusy(true);
              const result = await unsubscribeFromPush();
              setState(result.state);
              setMessage("Alarms are off for this device.");
              setBusy(false);
            }}
          >
            Turn off for this device
          </Button>
        </div>
      ) : null}

      {state === "blocked" ? (
        <p className="text-sm text-warn-500">
          Open your browser&apos;s site settings for this address and allow notifications to turn
          them back on.
        </p>
      ) : null}

      <div>
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void sendTestAlarm().then((result) => {
              setMessage(
                result.ok
                  ? "Test alarm sent — it goes through exactly the same pipeline as a real one."
                  : "Could not send a test alarm right now.",
              );
              setBusy(false);
            });
          }}
        >
          Send a test alarm
        </Button>
        <p className="mt-2 text-xs text-slate" aria-live="polite">
          {message}
        </p>
      </div>
    </div>
  );
}

export function CategoryManager({
  categories,
}: {
  categories: { id: string; name: string; color: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [color, setColor] = useState("#3e6b8c");
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-wrap gap-2">
        {categories.length === 0 ? (
          <li className="text-sm text-slate">No categories yet.</li>
        ) : null}
        {categories.map((category) => (
          <li key={category.id}>
            <span className="inline-flex items-center gap-2 rounded-full border border-mist px-3 py-1 text-sm">
              <span aria-hidden className="size-2.5 rounded-full" style={{ backgroundColor: category.color }} />
              {category.name}
              <button
                type="button"
                disabled={pending}
                aria-label={`Delete the ${category.name} category`}
                onClick={() =>
                  startTransition(async () => {
                    await deleteCategory(category.id);
                    router.refresh();
                  })
                }
                className="transition-quiet text-slate hover:text-danger-500"
              >
                ×
              </button>
            </span>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-end gap-2">
        <Field label="New category" id="category-name" error={error ?? undefined} className="flex-1">
          <Input id="category-name" value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="Colour" id="category-color">
          <input
            id="category-color"
            type="color"
            value={color}
            onChange={(event) => setColor(event.target.value)}
            className="min-h-11 w-16 rounded-lg border border-mist bg-surface"
          />
        </Field>
        <Button
          type="button"
          variant="secondary"
          disabled={pending || name.trim().length === 0}
          onClick={() =>
            startTransition(async () => {
              const result = await createCategory({ name, color, icon: "calendar" });
              if (!result.ok) {
                setError(Object.values(result.errors)[0] ?? "Could not add that");
                return;
              }
              setError(null);
              setName("");
              router.refresh();
            })
          }
        >
          Add
        </Button>
      </div>
    </div>
  );
}

export function IcsTools() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <a
          href="/api/ics"
          className="transition-quiet inline-flex min-h-9 items-center gap-2 rounded-lg border border-mist px-3 text-sm text-ink hover:border-primary-300"
        >
          <Download aria-hidden className="size-4" />
          Export .ics
        </a>

        <Button size="sm" variant="secondary" onClick={() => fileRef.current?.click()} disabled={busy}>
          <Upload aria-hidden className="size-4" />
          Import .ics
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="text/calendar,.ics"
          className="sr-only"
          onChange={async (event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            setBusy(true);
            setMessage(null);
            try {
              const ics = await file.text();

              // Preview first: importing a calendar silently is how trust is lost.
              const previewResponse = await fetch("/api/ics/import", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ ics, commit: false }),
              });
              const preview = (await previewResponse.json()) as { count?: number };
              const count = preview.count ?? 0;
              if (count === 0) {
                setMessage("That file had no events we could read.");
                return;
              }

              const confirmed = window.confirm(
                `Import ${count} event${count === 1 ? "" : "s"}? They are added alongside what you already have.`,
              );
              if (!confirmed) {
                setMessage("Nothing was imported.");
                return;
              }

              const commitResponse = await fetch("/api/ics/import", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ ics, commit: true }),
              });
              const result = (await commitResponse.json()) as { count?: number };
              setMessage(`Imported ${result.count ?? 0} events.`);
              router.refresh();
            } catch {
              setMessage("That file could not be read.");
            } finally {
              setBusy(false);
              if (fileRef.current) fileRef.current.value = "";
            }
          }}
        />
      </div>

      <p aria-live="polite" className="text-xs text-slate">
        {message}
      </p>
    </div>
  );
}
