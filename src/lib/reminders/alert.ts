// src/lib/reminders/alert.ts
//
// The shape of an in-app alarm. Shared by the API route that produces it and the client components
// that render it — defined once so the two can never drift.

export interface ActiveAlert {
  reminderId: string;
  occurrenceKey: string;
  eventId: string;
  title: string;
  /** Compact visual time range, zone-labelled when it differs. */
  body: string;
  /** Full sentence for assistive tech. */
  ariaLabel: string;
  url: string;
  offsetLabel: string;
  status: string;
  dueAt: string;
  lateBySeconds: number | null;
  canSnooze: boolean;
}

export interface ActiveAlertsResponse {
  alerts: ActiveAlert[];
  /** The server's clock, so the client can render an honest countdown without trusting the device. */
  serverTime: string;
  timezone: string;
}
