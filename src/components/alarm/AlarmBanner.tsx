// src/components/alarm/AlarmBanner.tsx
//
// The one place the design language is allowed to be assertive. Everything else in the app is calm;
// an alarm has to be unmissable. It is the ONLY component that animates.
//
// Accessibility: role="alert" + aria-live="assertive" so it interrupts a screen reader, and each
// alarm carries a full sentence rather than a bare time.

import { AlarmClock, BellRing, Clock } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { SNOOZE_PRESETS } from "@/lib/reminders/offsets";
import type { ActiveAlert } from "@/lib/reminders/alert";

export function AlarmBanner({
  alert,
  onSnooze,
  onAcknowledge,
  onOpen,
  busy,
}: {
  alert: ActiveAlert;
  onSnooze: (minutes: number) => void;
  onAcknowledge: () => void;
  onOpen: () => void;
  busy: boolean;
}) {
  const late = alert.lateBySeconds !== null && alert.lateBySeconds >= 45;
  const missed = alert.status === "deferred";

  return (
    <div
      role="alert"
      aria-live="assertive"
      className={cn(
        "alarm-enter rounded-[var(--radius-card)] border-2 p-4 shadow-card",
        late ? "border-warn-500 bg-warn-50" : "border-primary-500 bg-primary-50",
      )}
    >
      <div className="flex items-start gap-3">
        <BellRing
          aria-hidden
          className={cn("mt-0.5 size-6 shrink-0", late ? "text-warn-500" : "text-primary-600")}
        />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold tracking-wide text-slate uppercase">{alert.offsetLabel}</p>
          <h2 className="mt-0.5 text-lg leading-tight font-semibold text-ink">{alert.title}</h2>

          {/* The visible string is tabular; the sentence is what assistive tech reads. */}
          <p className="mt-1 text-base text-ink tabular" aria-hidden>
            {alert.body}
          </p>
          <span className="sr-only">
            {alert.ariaLabel}
            {late ? `, delivered ${Math.round(alert.lateBySeconds! / 60)} minutes late` : ""}
          </span>

          {late ? (
            <p className="mt-1 flex items-center gap-1 text-xs font-medium text-warn-500">
              <Clock aria-hidden className="size-3.5" />
              The scheduler was behind — delivered {Math.round(alert.lateBySeconds! / 60)} min late.
            </p>
          ) : null}

          {missed ? (
            <p className="mt-1 flex items-center gap-1 text-xs font-medium text-warn-500">
              <AlarmClock aria-hidden className="size-3.5" />
              Held during quiet hours. It is due now.
            </p>
          ) : null}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={onAcknowledge} disabled={busy}>
          Got it
        </Button>
        {SNOOZE_PRESETS.slice(0, 3).map((minutes) => (
          <Button
            key={minutes}
            size="sm"
            variant="secondary"
            onClick={() => onSnooze(minutes)}
            disabled={busy}
          >
            Snooze {minutes}m
          </Button>
        ))}
        <Button size="sm" variant="ghost" onClick={onOpen} disabled={busy}>
          Open
        </Button>
      </div>
    </div>
  );
}
