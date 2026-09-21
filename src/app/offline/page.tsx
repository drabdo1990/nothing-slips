// app/offline/page.tsx

import { CloudOff } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { ButtonLink } from "@/components/ui/Button";

export const metadata = { title: "Offline" };

/**
 * The offline fallback the service worker serves for a navigation it cannot fulfil.
 * It states plainly what still works, because "cannot reach the server" is not the same as
 * "your schedule is gone".
 */
export default function OfflinePage() {
  return (
    <div className="flex min-h-[70dvh] flex-col justify-center">
      <Card className="p-6 text-center">
        <CloudOff aria-hidden className="mx-auto size-8 text-warn-500" />
        <h1 className="mt-3 text-xl font-semibold text-ink">You are offline</h1>
        <p className="mt-2 text-sm text-slate">
          We could not reach the server. Pages you have already opened are still available, and any
          changes you make are queued and sent when you reconnect.
        </p>
        <p className="mt-3 text-sm text-slate">
          Alarms you have already received are on your device. New ones will arrive as soon as you are
          back online.
        </p>
        <div className="mt-4">
          <ButtonLink href="/" variant="secondary" size="sm">
            Try the today view
          </ButtonLink>
        </div>
      </Card>
    </div>
  );
}
