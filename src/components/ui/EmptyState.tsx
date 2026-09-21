// src/components/ui/EmptyState.tsx
import type { LucideIcon } from "lucide-react";
import { cn } from "./cn";

/**
 * Empty states say what to do next, not just that there is nothing here. A scheduler that shows a
 * blank screen on a free day has wasted the one moment the user was paying attention.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  tone = "neutral",
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
  tone?: "neutral" | "warn" | "danger";
}) {
  const toneClass =
    tone === "warn" ? "text-warn-500" : tone === "danger" ? "text-danger-500" : "text-primary-400";

  return (
    <div className="flex flex-col items-center gap-2 rounded-[var(--radius-card)] border border-dashed border-mist px-6 py-10 text-center">
      <Icon aria-hidden className={cn("size-7", toneClass)} />
      <p className="text-base font-medium text-ink">{title}</p>
      {description ? <p className="max-w-sm text-sm text-slate">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
