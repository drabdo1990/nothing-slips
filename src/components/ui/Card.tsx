// src/components/ui/Card.tsx
import { cn } from "./cn";

export function Card({
  className,
  children,
  as: Tag = "div",
}: {
  className?: string;
  children: React.ReactNode;
  as?: "div" | "section" | "article" | "li";
}) {
  return (
    <Tag className={cn("rounded-[var(--radius-card)] border border-mist bg-surface shadow-card", className)}>
      {children}
    </Tag>
  );
}

export function CardHeader({
  title,
  subtitle,
  action,
  id,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
  id?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-mist px-4 py-3">
      <div className="min-w-0">
        <h2 id={id} className="text-sm font-semibold tracking-wide text-slate uppercase">
          {title}
        </h2>
        {subtitle ? <p className="mt-1 text-sm text-slate">{subtitle}</p> : null}
      </div>
      {action}
    </div>
  );
}

/** The section heading used across Today/Agenda. `note` carries counts and status text. */
export function SectionHeading({
  children,
  note,
  id,
}: {
  children: React.ReactNode;
  note?: React.ReactNode;
  id?: string;
}) {
  return (
    <div className="mb-2 flex items-baseline justify-between gap-3 px-1">
      <h2 id={id} className="text-sm font-semibold tracking-wide text-slate uppercase">
        {children}
      </h2>
      {note ? <span className="text-xs text-slate tabular">{note}</span> : null}
    </div>
  );
}
