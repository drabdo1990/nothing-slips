// src/components/settings/DndToggle.tsx
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Bell, BellOff } from "lucide-react";
import { cn } from "@/components/ui/cn";
import { setDoNotDisturb } from "@/server/actions/settings";

/**
 * Do not disturb, one tap from the today view — because the moment you want it is the moment you
 * are walking into a meeting, not five screens deep in settings.
 *
 * A DND toggle must never silently swallow an alarm, so the label says what actually happens.
 */
export function DndToggle({ initialDnd }: { initialDnd: boolean }) {
  const router = useRouter();
  const [dnd, setDnd] = useState(initialDnd);
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      aria-pressed={dnd}
      disabled={pending}
      onClick={() => {
        const next = !dnd;
        setDnd(next);
        startTransition(async () => {
          await setDoNotDisturb(next);
          router.refresh();
        });
      }}
      className={cn(
        "transition-quiet flex min-h-10 items-center gap-2 rounded-full border px-3 text-sm font-medium",
        dnd
          ? "border-warn-500/40 bg-warn-50 text-warn-500"
          : "border-mist bg-surface text-slate hover:border-primary-300 hover:text-ink",
      )}
    >
      {dnd ? <BellOff aria-hidden className="size-4" /> : <Bell aria-hidden className="size-4" />}
      {dnd ? "Quiet" : "Alarms on"}
      <span className="sr-only">
        {dnd
          ? "Alarms are held and will fire when you turn this off."
          : "Turn off all alarms temporarily."}
      </span>
    </button>
  );
}
