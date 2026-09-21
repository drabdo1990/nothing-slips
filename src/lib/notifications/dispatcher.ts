// src/lib/notifications/dispatcher.ts
//
// Fan-out across channels for one due reminder, plus the audit trail.
// Policy: push is primary (works with the tab closed); email is the fallback; in-app is handled by
// the client polling reminder STATE, never by a browser timer.

import type { PushSubscriptionRecord } from "./push";
import { sendPush, type PushPayload } from "./push";
import { sendAlarmEmail } from "./email";
import { humanizeOffset } from "@/lib/reminders/offsets";
import { formatOccurrenceWhen } from "@/lib/time/format";
import { whenForReminder } from "@/lib/reminders/occurrence";
import type { EventTimeInput } from "@/lib/time/recurrence";
import { zoneLabel } from "@/lib/time/zone";

export interface DeliveryTarget {
  reminderId: string;
  occurrenceId: string;
  eventId: string;
  offsetMinutes: number;
  channels: string[];
  lateBySeconds: number | null;
  occurrenceStartUtc: Date;
}

export interface DeliveryEvent extends EventTimeInput {
  title: string;
  location: string | null;
  notes: string | null;
}

export interface DeliveryUser {
  id: string;
  email: string;
  timezone: string;
  emailFallbackEnabled: boolean;
}

export interface DeliveryInput {
  reminder: DeliveryTarget;
  event: DeliveryEvent;
  user: DeliveryUser;
  subscriptions: PushSubscriptionRecord[];
  origin: string;
}

export interface ChannelAttempt {
  channel: "push" | "email";
  ok: boolean;
  detail: string;
}

export interface DeliveryOutcome {
  delivered: boolean;
  via: "push" | "email" | null;
  attempts: ChannelAttempt[];
  /** Subscriptions the push service rejected permanently (404/410). */
  disableSubscriptionIds: string[];
}

/**
 * Deliver one reminder. Returns a full accounting so the caller can write NotificationLog rows and
 * settle the reminder's state. Never throws: a delivery failure is data, not an exception.
 */
export async function deliverReminder(input: DeliveryInput): Promise<DeliveryOutcome> {
  const { reminder, event, user, subscriptions, origin } = input;
  const when = whenForReminder(reminder, event);

  // Rendered once, in the recipient's zone, zone-labelled when it differs from the event's.
  const formatted = formatOccurrenceWhen(when, event.timezone, user.timezone);
  const offsetLabel = humanizeOffset(reminder.offsetMinutes);
  const lateLabel =
    reminder.lateBySeconds && reminder.lateBySeconds >= 45
      ? ` · ${Math.round(reminder.lateBySeconds / 60)} min late`
      : "";
  const crossZoneNote =
    event.timezone !== user.timezone ? ` (${zoneLabel(event.timezone)})` : "";

  const url = `${origin}/event/${event.id}?r=${reminder.reminderId}`;
  const attempts: ChannelAttempt[] = [];
  const disableSubscriptionIds: string[] = [];
  let via: "push" | "email" | null = null;

  // ── push ───────────────────────────────────────────────────────────────────
  if (reminder.channels.includes("push") && subscriptions.length > 0) {
    const payload: PushPayload = {
      title: `${offsetLabel.replace(" before", " until")}: ${event.title}`,
      body: `${formatted.text}${crossZoneNote}${lateLabel}${event.location ? ` · ${event.location}` : ""}`,
      // Collapse key: occurrence + offset. A retried delivery replaces the previous notification
      // instead of stacking a second alarm on the lock screen.
      tag: `${reminder.occurrenceId}:${reminder.offsetMinutes}`,
      url,
      requireInteraction: true,
      data: {
        reminderId: reminder.reminderId,
        occurrenceId: reminder.occurrenceId,
        eventId: event.id,
        canSnooze: true,
      },
    };

    const results = await Promise.all(subscriptions.map((s) => sendPush(s, payload)));
    let anyOk = false;
    for (const result of results) {
      if (result.ok) {
        anyOk = true;
      } else {
        attempts.push({ channel: "push", ok: false, detail: result.error });
        if (result.gone) disableSubscriptionIds.push(result.subscriptionId);
      }
    }
    if (anyOk) {
      attempts.push({ channel: "push", ok: true, detail: `delivered to ${results.filter((r) => r.ok).length} device(s)` });
      via = "push";
    }
  } else if (reminder.channels.includes("push")) {
    attempts.push({ channel: "push", ok: false, detail: "no-active-subscription" });
  }

  // ── email fallback ─────────────────────────────────────────────────────────
  const emailEligible =
    via === null && user.emailFallbackEnabled && reminder.channels.includes("email");

  if (emailEligible) {
    const result = await sendAlarmEmail({
      to: user.email,
      eventTitle: event.title,
      whenText: `${formatted.text}${crossZoneNote}`,
      whenAria: formatted.ariaLabel,
      offsetLabel,
      location: event.location,
      notes: event.notes,
      lateBySeconds: reminder.lateBySeconds,
      eventUrl: url,
      unsubscribeUrl: `${origin}/settings#notifications`,
    });
    attempts.push({ channel: "email", ok: result.ok, detail: result.ok ? "delivered" : result.error });
    if (result.ok) via = "email";
  }

  return { delivered: via !== null, via, attempts, disableSubscriptionIds };
}

/** The push payload shown by the service worker for an in-app-only fallback. */
export function buildInAppAlert(input: DeliveryInput): {
  title: string;
  body: string;
  url: string;
  lateBySeconds: number | null;
} {
  const when = whenForReminder(input.reminder, input.event);
  const formatted = formatOccurrenceWhen(when, input.event.timezone, input.user.timezone);
  return {
    title: `${humanizeOffset(input.reminder.offsetMinutes)}: ${input.event.title}`,
    body: formatted.text,
    url: `/event/${input.event.id}?r=${input.reminder.reminderId}`,
    lateBySeconds: input.reminder.lateBySeconds,
  };
}
