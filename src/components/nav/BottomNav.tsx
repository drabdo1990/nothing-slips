// src/components/nav/BottomNav.tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CalendarDays, ListChecks, Plus, Settings, Sun } from "lucide-react";
import { cn } from "@/components/ui/cn";

const ITEMS = [
  { href: "/", label: "Today", icon: Sun },
  { href: "/calendar", label: "Calendar", icon: CalendarDays },
  { href: "/agenda", label: "Agenda", icon: ListChecks },
  { href: "/settings", label: "Settings", icon: Settings },
] as const;

/**
 * Thumb-reachable primary navigation. The quick-add action sits in the middle because adding
 * something in seconds is the most frequent thing this app does.
 */
export function BottomNav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-mist bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur"
    >
      <ul className="mx-auto flex w-full max-w-2xl items-stretch justify-between px-2">
        {ITEMS.slice(0, 2).map((item) => (
          <NavItem key={item.href} {...item} active={isActive(pathname, item.href)} />
        ))}

        <li className="flex items-center">
          <Link
            href="/event/new"
            className="transition-quiet -mt-5 flex size-14 items-center justify-center rounded-full bg-primary-500 text-white shadow-card hover:bg-primary-600"
          >
            <Plus aria-hidden className="size-6" />
            <span className="sr-only">Add something</span>
          </Link>
        </li>

        {ITEMS.slice(2).map((item) => (
          <NavItem key={item.href} {...item} active={isActive(pathname, item.href)} />
        ))}
      </ul>
    </nav>
  );
}

function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

function NavItem({
  href,
  label,
  icon: Icon,
  active,
}: {
  href: string;
  label: string;
  icon: typeof Sun;
  active: boolean;
}) {
  return (
    <li className="flex-1">
      <Link
        href={href}
        aria-current={active ? "page" : undefined}
        className={cn(
          "transition-quiet flex min-h-14 flex-col items-center justify-center gap-1 rounded-lg px-2 text-xs font-medium",
          active ? "text-primary-600" : "text-slate hover:text-ink",
        )}
      >
        <Icon aria-hidden className="size-5" />
        {label}
      </Link>
    </li>
  );
}
