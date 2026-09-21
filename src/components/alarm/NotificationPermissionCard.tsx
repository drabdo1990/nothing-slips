// src/components/alarm/NotificationPermissionCard.tsx
"use client";

import { useEffect, useState } from "react";
import { BellOff, BellRing, Mail, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { getPushState, subscribeToPush, type PushState } from "@/lib/client/push";

/**
 * The permission prompt, placed where the user understands WHY.
 *
 * Every denial path is handled explicitly:
 *  * blocked  → explain that only browser settings can undo it, and that email is still on
 *  * unconfigured → the deployment has no push keys; say so instead of showing a dead button
 *  * unsupported → iOS Safari before install; tell the user to add to Home Screen
 */
export function NotificationPermissionCard({ emailFallbackEnabled }: { emailFallbackEnabled: boolean }) {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void getPushState().then(setState);
  }, []);

  // Render nothing until we know — a flash of "turn on alarms" for someone already subscribed is
  // the kind of small wrongness that erodes trust in an alarm app.
  if (state === null || state === "subscribed") return null;

  if (state === "unconfigured") {
    return (
      <Card className="p-4">
        <div className="flex items-start gap-3">
          <Mail aria-hidden className="mt-0.5 size-5 shrink-0 text-slate" />
          <div>
            <p className="text-sm font-medium text-ink">Alarms are delivered by email</p>
            <p className="mt-0.5 text-sm text-slate">
              Push notifications are not configured on this deployment, so reminders are emailed
              instead.
            </p>
          </div>
        </div>
      </Card>
    );
  }

  if (state === "unsupported") {
    return (
      <Card className="p-4">
        <div className="flex items-start gap-3">
          <ShieldAlert aria-hidden className="mt-0.5 size-5 shrink-0 text-slate" />
          <div>
            <p className="text-sm font-medium text-ink">This browser cannot show alarms</p>
            <p className="mt-0.5 text-sm text-slate">
              On iPhone, add this app to your Home Screen from the Share menu, then open it from
              there. Alarms will appear in the app while it is open in the meantime.
            </p>
          </div>
        </div>
      </Card>
    );
  }

  if (state === "blocked") {
    return (
      <Card className="border-danger-500/30 bg-danger-50 p-4">
        <div className="flex items-start gap-3">
          <BellOff aria-hidden className="mt-0.5 size-5 shrink-0 text-danger-500" />
          <div>
            <p className="text-sm font-medium text-ink">Notifications are blocked</p>
            <p className="mt-0.5 text-sm text-slate">
              Your browser is blocking alarms for this site, so they cannot reach you when the tab is
              closed.
              {emailFallbackEnabled
                ? " We are emailing them instead — you can turn on notifications again from the padlock icon in your address bar."
                : " Turn them back on from the padlock icon in your address bar to be warned in time."}
            </p>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card className="border-primary-200 bg-primary-50 p-4">
      <div className="flex items-start gap-3">
        <BellRing aria-hidden className="mt-0.5 size-5 shrink-0 text-primary-600" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink">Turn on alarms for this device</p>
          <p className="mt-0.5 text-sm text-slate">
            So you are warned before each commitment, even when this tab is closed. We only ever send
            reminders you created.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <Button
              size="sm"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                const result = await subscribeToPush();
                setState(result.state);
                setMessage(
                  result.ok
                    ? "Alarms are on for this device."
                    : result.reason === "permission"
                      ? "No problem — nothing changed."
                      : "That did not work. In-app and email alarms still apply.",
                );
                setBusy(false);
              }}
            >
              {busy ? "Asking…" : "Turn on alarms"}
            </Button>
            <p aria-live="polite" className="text-xs text-slate">
              {message}
            </p>
          </div>
        </div>
      </div>
    </Card>
  );
}
