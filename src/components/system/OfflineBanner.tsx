// src/components/system/OfflineBanner.tsx
"use client";

import { useEffect, useState } from "react";
import { CloudOff } from "lucide-react";

/**
 * Offline is a first-class state, not an error: the app still opens and the alarm feed keeps
 * working from cache. We say what still works rather than only what does not.
 *
 * Starts as "online" during SSR and corrects on mount — a hydration mismatch here would be a bug in
 * the banner, not a real signal about connectivity.
 */
export function OfflineBanner() {
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  if (!offline) return null;

  return (
    <div
      role="status"
      className="sticky top-0 z-30 flex items-center gap-2 border-b border-warn-500/30 bg-warn-50 px-4 py-2 text-sm text-warn-500"
    >
      <CloudOff aria-hidden className="size-4 shrink-0" />
      <p>
        You are offline. Your schedule is still readable; changes you make are queued and sent when
        you reconnect.
      </p>
    </div>
  );
}
