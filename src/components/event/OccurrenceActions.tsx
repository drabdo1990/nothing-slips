// src/components/event/OccurrenceActions.tsx
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, MoreHorizontal, Repeat } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { markOccurrenceDone } from "@/server/actions/reminders";

/**
 * Inline row actions. Only "Done" is one tap; destructive things (delete) live on the detail page
 * behind a confirmation, because a mis-tap on a busy morning should never delete an appointment.
 */
export function OccurrenceActions({
  occurrenceKey,
  eventId,
  recurring,
}: {
  occurrenceKey: string;
  eventId: string;
  recurring: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [done, setDone] = useState(false);

  return (
    <div className="flex items-center gap-1">
      {recurring ? (
        <>
          <Repeat aria-hidden className="size-3.5 text-slate" />
          <span className="sr-only">Repeats</span>
        </>
      ) : null}
      <Button
        size="sm"
        variant={done ? "secondary" : "ghost"}
        aria-label={done ? "Marked done" : "Mark this occurrence done"}
        disabled={pending || done}
        onClick={() => {
          setDone(true);
          startTransition(async () => {
            await markOccurrenceDone({ occurrenceKey, eventId });
            router.refresh();
          });
        }}
        className={cn("px-2")}
      >
        <Check aria-hidden className={cn("size-4", done && "text-success-500")} />
        <span className="sr-only sm:not-sr-only sm:inline">{done ? "Done" : "Mark done"}</span>
      </Button>
    </div>
  );
}

export function MoreLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      aria-label={label}
      className="transition-quiet rounded-lg p-2 text-slate hover:bg-mist/60 hover:text-ink"
    >
      <MoreHorizontal aria-hidden className="size-4" />
    </a>
  );
}
