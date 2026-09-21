// src/components/event/SnoozeAckControls.tsx
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Clock } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { acknowledgeReminder, snoozeReminder } from "@/server/actions/reminders";
import { SNOOZE_PRESETS } from "@/lib/reminders/offsets";

/**
 * Snooze / acknowledge for the detail page. Reuses the same server actions as the alarm banner, so
 * the state machine has exactly one implementation.
 */
export function SnoozeAckControls({
  reminderId,
  status,
  acknowledged,
}: {
  reminderId: string;
  status: string;
  acknowledged: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(acknowledged);

  if (done) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-success-500">
        <Check aria-hidden className="size-3.5" />
        Acknowledged
      </span>
    );
  }

  return (
    <div className="flex items-center gap-1">
      {open ? (
        <>
          {SNOOZE_PRESETS.slice(0, 3).map((minutes) => (
            <Button
              key={minutes}
              size="sm"
              variant="secondary"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  await snoozeReminder({ reminderId, minutes });
                  setOpen(false);
                  router.refresh();
                })
              }
            >
              {minutes}m
            </Button>
          ))}
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </>
      ) : (
        <>
          <Button size="sm" variant="ghost" onClick={() => setOpen(true)} disabled={pending}>
            <Clock aria-hidden className="size-3.5" />
            Snooze
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                setDone(true);
                await acknowledgeReminder(reminderId);
                router.refresh();
              })
            }
          >
            Got it
          </Button>
        </>
      )}
      <span className="sr-only">Alarm status: {status}</span>
    </div>
  );
}
