// src/components/event/Countdown.tsx
"use client";

import { useEffect, useState } from "react";
import { formatCountdown } from "@/lib/time/format";

/**
 * The ONE place a browser timer is allowed: the in-tab countdown. It never decides whether to alarm.
 *
 * It also corrects for a wrong device clock: the server's time is passed in, and we compute an
 * offset once on mount. A phone with a skewed clock therefore still shows an honest "in 12 min",
 * which matters in an app whose whole promise is "nothing slips".
 */
export function Countdown({
  targetIso,
  serverTimeIso,
  className,
}: {
  targetIso: string;
  serverTimeIso: string;
  className?: string;
}) {
  const [now, setNow] = useState(() => new Date(serverTimeIso));

  useEffect(() => {
    const offsetMs = Date.parse(serverTimeIso) - Date.now();
    const tick = () => setNow(new Date(Date.now() + offsetMs));
    tick();
    const timer = window.setInterval(tick, 30_000);
    return () => window.clearInterval(timer);
  }, [serverTimeIso]);

  const target = new Date(targetIso);
  const { text, ariaLabel } = formatCountdown(target, now);

  return (
    <span className={className}>
      {/* Visual value is tabular; assistive tech gets the sentence. */}
      <span aria-hidden className="tabular">
        {text}
      </span>
      <span className="sr-only">{ariaLabel}</span>
    </span>
  );
}
