// src/components/ui/Button.tsx
import Link from "next/link";
import { cn } from "./cn";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-primary-500 text-white hover:bg-primary-600 active:bg-primary-700",
  secondary: "bg-surface text-ink border border-mist hover:border-primary-300 hover:bg-primary-50",
  ghost: "text-slate hover:bg-mist/60 hover:text-ink",
  danger: "bg-danger-500 text-white hover:brightness-95",
};

// Minimum 44px touch target: this app is used on a phone, between meetings.
const SIZES: Record<Size, string> = {
  sm: "min-h-9 px-3 text-sm",
  md: "min-h-11 px-4 text-sm",
  lg: "min-h-12 px-6 text-base",
};

const BASE =
  "transition-quiet inline-flex items-center justify-center gap-2 rounded-lg font-medium " +
  "disabled:cursor-not-allowed disabled:opacity-50";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export function Button({ variant = "primary", size = "md", className, ...props }: ButtonProps) {
  return <button {...props} className={cn(BASE, VARIANTS[variant], SIZES[size], className)} />;
}

export interface ButtonLinkProps {
  href: string;
  variant?: Variant;
  size?: Size;
  className?: string;
  children: React.ReactNode;
  "aria-label"?: string;
}

export function ButtonLink({ href, variant = "primary", size = "md", className, children, ...rest }: ButtonLinkProps) {
  return (
    <Link href={href} className={cn(BASE, VARIANTS[variant], SIZES[size], className)} {...rest}>
      {children}
    </Link>
  );
}
