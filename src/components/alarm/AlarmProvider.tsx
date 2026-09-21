// src/components/alarm/AlarmProvider.tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlarmBanner } from "./AlarmBanner";
import { enqueue, subscribeToReconnect } from "@/lib/client/outbox";
import type { ActiveAlert, ActiveAlertsResponse } from "@/lib/reminders/alert";

/**
 * In-app alarms when the tab is open.
 *
 * ARCHITECTURE NOTE — the single most important decision in this file:
 *   Nothing here decides WHEN to alarm. It polls the server for reminders whose rows have come due
 *   and are unresolved, and renders them. `setTimeout` is used for nothing but the poll interval.
 *   That is why an alarm survives a refresh, a second tab, a sleeping laptop, and a device clock
 *   that is wrong: the truth lives in the database, not in a browser timer.
 *
 * Polling is cheap here (a single indexed query returning at most five rows) and honest. A
 * WebSocket or SSE would be nicer, and can be dropped in behind this same interface later.
 */
const POLL_INTERVAL_MS = 30_000;

export function AlarmProvider() {
  const router = useRouter();
  const [alerts, setAlerts] = useState<ActiveAlert[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const inFlight = useRef(false);

  const poll = useCallback(async () => {
    if (inFlight.current || sessionExpired) return;
    inFlight.current = true;
    try {
      const response = await fetch("/api/reminders/active", { cache: "no-store" });
      // 401 simply means "not signed in" (e.g. the login page) — stop asking, do not show an error.
      if (response.status === 401) {
        setSessionExpired(true);
        return;
      }
      if (!response.ok) return;
      const body = (await response.json()) as ActiveAlertsResponse;
      setAlerts(body.alerts);
    } catch {
      // Offline: keep whatever is on screen. The banner already tells the user we are offline.
    } finally {
      inFlight.current = false;
    }
  }, [sessionExpired]);

  useEffect(() => {
    void poll();
    const timer = window.setInterval(poll, POLL_INTERVAL_MS);

    // Re-check the moment the tab becomes visible again: a laptop that just woke should not wait
    // up to 30 seconds to tell you that you are late.
    const onVisibility = () => {
      if (document.visibilityState === "visible") void poll();
    };
    document.addEventListener("visibilitychange", onVisibility);

    const unsubscribe = subscribeToReconnect(() => void poll());

    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      unsubscribe();
    };
  }, [poll]);

  const act = useCallback(
    async (alert: ActiveAlert, body: { action: "ack" } | { action: "snooze"; minutes: number }) => {
      setBusyId(alert.reminderId);
      const url = `/api/reminders/${alert.reminderId}`;

      // Optimistic: an alarm should vanish the instant you acknowledge it.
      setAlerts((current) => current.filter((item) => item.reminderId !== alert.reminderId));

      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!response.ok && response.status !== 404) throw new Error("failed");
      } catch {
        // Offline: queue the write instead of losing it, and tell the user.
        enqueue(url, body);
      } finally {
        setBusyId(null);
        router.refresh();
        void poll();
      }
    },
    [poll, router],
  );

  if (alerts.length === 0) return null;

  return (
    <div className="fixed inset-x-0 top-0 z-50 mx-auto flex w-full max-w-2xl flex-col gap-2 p-3">
      {alerts.map((alert) => (
        <AlarmBanner
          key={alert.reminderId}
          alert={alert}
          busy={busyId === alert.reminderId}
          onAcknowledge={() => void act(alert, { action: "ack" })}
          onSnooze={(minutes) => void act(alert, { action: "snooze", minutes })}
          onOpen={() => {
            router.push(alert.url);
            setAlerts((current) => current.filter((item) => item.reminderId !== alert.reminderId));
          }}
        />
      ))}
    </div>
  );
}
