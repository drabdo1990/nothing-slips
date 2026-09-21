// src/components/ui/Field.tsx
//
// Form primitives. Every control is wrapped in a real <label>, and errors are wired through
// aria-describedby + aria-invalid so a screen reader announces them.

import { cn } from "./cn";

function describedBy(id: string, hint?: string, error?: string): string | undefined {
  const ids = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean);
  return ids.length > 0 ? ids.join(" ") : undefined;
}

export function Field({
  label,
  id,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  id: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <label htmlFor={id} className="text-sm font-medium text-ink">
        {label}
      </label>
      {children}
      {hint && !error ? (
        <p id={`${id}-hint`} className="text-xs text-slate">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-xs font-medium text-danger-500">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const CONTROL =
  "min-h-11 w-full rounded-lg border bg-surface px-3 text-base text-ink placeholder:text-slate/60 " +
  "transition-quiet focus:border-primary-400 disabled:opacity-60";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  id: string;
  hint?: string;
  error?: string;
}

export function Input({ id, hint, error, className, ...props }: InputProps) {
  return (
    <input
      id={id}
      aria-invalid={error ? true : undefined}
      aria-describedby={describedBy(id, hint, error)}
      className={cn(CONTROL, error ? "border-danger-500" : "border-mist", className)}
      {...props}
    />
  );
}

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  id: string;
  hint?: string;
  error?: string;
}

export function Textarea({ id, hint, error, className, ...props }: TextareaProps) {
  return (
    <textarea
      id={id}
      aria-invalid={error ? true : undefined}
      aria-describedby={describedBy(id, hint, error)}
      className={cn(CONTROL, "min-h-24 py-2", error ? "border-danger-500" : "border-mist", className)}
      {...props}
    />
  );
}

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  id: string;
  hint?: string;
  error?: string;
}

export function Select({ id, hint, error, className, children, ...props }: SelectProps) {
  return (
    <select
      id={id}
      aria-invalid={error ? true : undefined}
      aria-describedby={describedBy(id, hint, error)}
      className={cn(CONTROL, "appearance-none pr-8", error ? "border-danger-500" : "border-mist", className)}
      {...props}
    >
      {children}
    </select>
  );
}

export function Checkbox({
  id,
  label,
  hint,
  ...props
}: { id: string; label: string; hint?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="flex items-start gap-3">
      <input
        id={id}
        type="checkbox"
        aria-describedby={hint ? `${id}-hint` : undefined}
        className="mt-1 size-5 shrink-0 rounded border-mist accent-primary-500"
        {...props}
      />
      <div>
        <label htmlFor={id} className="text-sm font-medium text-ink">
          {label}
        </label>
        {hint ? (
          <p id={`${id}-hint`} className="text-xs text-slate">
            {hint}
          </p>
        ) : null}
      </div>
    </div>
  );
}
