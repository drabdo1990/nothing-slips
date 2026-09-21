// src/components/event/QuickAdd.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CornerDownLeft, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";

interface Preview {
  title: string;
  whenText: string;
  ariaLabel: string;
  recurrence: string | null;
  confidentTime: boolean;
}

interface DraftResponse {
  preview: Preview;
}

/**
 * Quick-add. Shows the interpretation BEFORE saving, because a natural-language parser that
 * silently guesses is worse than no parser at all: the user needs to see "Thursday 26 March,
 * 15:00" and be able to fix it.
 */
export function QuickAdd({ autoFocus = false }: { autoFocus?: boolean }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (text.trim().length < 2) {
      setPreview(null);
      return;
    }
    const controller = new AbortController();
    // Debounce the preview so typing does not hammer the endpoint.
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch("/api/quick-add", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
          signal: controller.signal,
        });
        if (!response.ok) return;
        const body = (await response.json()) as DraftResponse;
        setPreview(body.preview);
      } catch {
        /* aborted or offline: keep the last good preview */
      }
    }, 350);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [text]);

  async function commit() {
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/quick-add", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { errors?: Record<string, string> };
        setError(Object.values(body.errors ?? {})[0] ?? "That could not be saved.");
        return;
      }
      setSaved(preview?.title ?? "Saved");
      setText("");
      setPreview(null);
      inputRef.current?.focus();
      router.refresh();
    } catch {
      setError("You appear to be offline. Reconnect and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void commit();
      }}
      className="flex flex-col gap-2"
    >
      <div className="flex items-center gap-2">
        <label htmlFor="quick-add" className="sr-only">
          Add something in your own words
        </label>
        <input
          id="quick-add"
          ref={inputRef}
          value={text}
          autoFocus={autoFocus}
          onChange={(event) => setText(event.target.value)}
          placeholder="dentist thursday 3pm"
          aria-describedby="quick-add-hint"
          enterKeyHint="done"
          className="min-h-12 flex-1 rounded-lg border border-mist bg-surface px-3 text-base text-ink placeholder:text-slate/60 focus:border-primary-400"
        />
        <Button type="submit" disabled={busy || text.trim().length < 2} aria-label="Add">
          <CornerDownLeft aria-hidden className="size-4" />
          Add
        </Button>
      </div>

      <p id="quick-add-hint" className="sr-only">
        Type a title and when it is. For example: dentist thursday 3pm, or standup every weekday
        9am.
      </p>

      {/* Live interpretation: the parser shows its work. */}
      {preview ? (
        <div
          aria-live="polite"
          className={cn(
            "flex items-start gap-2 rounded-lg border px-3 py-2 text-sm",
            preview.confidentTime || preview.title
              ? "border-primary-200 bg-primary-50 text-ink"
              : "border-warn-500/30 bg-warn-50 text-ink",
          )}
        >
          <Sparkles aria-hidden className="mt-0.5 size-4 shrink-0 text-primary-500" />
          <p>
            <span className="font-medium">{preview.title}</span>
            {preview.whenText ? <> · {preview.whenText}</> : null}
            {preview.recurrence ? <> · repeating</> : null}
            {!preview.confidentTime ? (
              <span className="block text-xs text-warn-500">
                No time given, so this is saved as an all-day item. Open it to add a time.
              </span>
            ) : null}
            <span className="sr-only">{preview.ariaLabel}</span>
          </p>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-danger-500">
          {error}
        </p>
      ) : null}

      {saved ? (
        <p aria-live="polite" className="text-sm text-success-500">
          Added “{saved}”.
        </p>
      ) : null}
    </form>
  );
}
