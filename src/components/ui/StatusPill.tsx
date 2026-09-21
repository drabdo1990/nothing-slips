// src/components/ui/StatusPill.tsx
import { PHASE_CLASSES, type EventPhase } from "@/lib/time/status";
import { cn } from "./cn";

/**
 * The status vocabulary, rendered identically everywhere. The colour is never the only signal —
 * each pill carries its label as text too, so it survives colour-blindness and greyscale.
 */
export function StatusPill({ phase, className }: { phase: EventPhase; className?: string }) {
  const styles = PHASE_CLASSES[phase];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        styles.chip,
        className,
      )}
    >
      <span aria-hidden className={cn("size-1.5 rounded-full", styles.dot)} />
      {styles.label}
    </span>
  );
}

export function ReminderStatusBadge({
  status,
  lateBySeconds,
}: {
  status: string;
  lateBySeconds?: number | null;
}) {
  const map: Record<string, { label: string; className: string }> = {
    pending: { label: "Scheduled", className: "bg-primary-50 text-primary-700 border-primary-200" },
    deferred: { label: "Deferred", className: "bg-warn-50 text-warn-500 border-warn-500/30" },
    sent: { label: "Alarmed", className: "bg-success-50 text-success-500 border-success-500/30" },
    acknowledged: { label: "Acknowledged", className: "bg-mist text-slate border-mist" },
    snoozed: { label: "Snoozed", className: "bg-primary-50 text-primary-700 border-primary-200" },
    missed: { label: "Missed", className: "bg-danger-50 text-danger-500 border-danger-500/30" },
    cancelled: { label: "Cancelled", className: "bg-mist text-slate border-mist" },
  };
  const entry = map[status] ?? { label: status, className: "bg-mist text-slate border-mist" };
  const late =
    status === "sent" && lateBySeconds && lateBySeconds >= 45
      ? ` · ${Math.round(lateBySeconds / 60)} min late`
      : "";

  return (
    <span
      className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium", entry.className)}
    >
      {entry.label}
      {late}
    </span>
  );
}
