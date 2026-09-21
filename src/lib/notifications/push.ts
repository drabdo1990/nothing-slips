// src/lib/notifications/push.ts
//
// Web Push (VAPID) — the primary channel because it is the only one that works with the tab closed.
// This module knows nothing about reminders or the database; it sends bytes and classifies failures.

import webpush from "web-push";
import { env, pushConfigured } from "@/lib/env";

export interface PushSubscriptionRecord {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** The payload the service worker renders. Keeping this small keeps the push reliable. */
export interface PushPayload {
  title: string;
  body: string;
  /** Collapse key: a duplicate delivery for the same occurrence+offset replaces, never stacks. */
  tag: string;
  /** Deep link into the event, handled by the SW's notificationclick handler. */
  url: string;
  /** Alarms are the one place the UI is allowed to be assertive. */
  requireInteraction: boolean;
  data: {
    reminderId: string;
    occurrenceId: string;
    eventId: string;
    /** Lets the SW show a "Snooze" action without a round-trip. */
    canSnooze: boolean;
  };
}

export type PushResult =
  | { ok: true; channel: "push"; subscriptionId: string }
  | { ok: false; channel: "push"; subscriptionId: string; gone: boolean; error: string };

let configured = false;

function ensureConfigured(): void {
  if (configured || !pushConfigured()) return;
  webpush.setVapidDetails(
    env.VAPID_SUBJECT,
    env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!,
    env.VAPID_PRIVATE_KEY!,
  );
  configured = true;
}

export async function sendPush(
  subscription: PushSubscriptionRecord,
  payload: PushPayload,
): Promise<PushResult> {
  if (!pushConfigured()) {
    return { ok: false, channel: "push", subscriptionId: subscription.id, gone: false, error: "push-not-configured" };
  }
  ensureConfigured();

  try {
    await webpush.sendNotification(
      {
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      },
      JSON.stringify(payload),
      { TTL: 60 * 60 }, // an alarm that arrives an hour late is not an alarm
    );
    return { ok: true, channel: "push", subscriptionId: subscription.id };
  } catch (error) {
    // 404/410 mean the browser threw the subscription away: disable it rather than retry forever.
    const statusCode = (error as { statusCode?: number }).statusCode;
    const gone = statusCode === 404 || statusCode === 410;
    return {
      ok: false,
      channel: "push",
      subscriptionId: subscription.id,
      gone,
      error: statusCode ? `push-http-${statusCode}` : "push-transport-error",
    };
  }
}

/** Client-side helper contract: the browser only ever subscribes with its own keys. */
export function vapidPublicKey(): string | null {
  return env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? null;
}
