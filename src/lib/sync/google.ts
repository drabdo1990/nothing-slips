// src/lib/sync/google.ts
//
// The ONLY file that knows Google's API shape. It is imported dynamically and exclusively by
// src/lib/sync/index.ts, so nothing in the scheduling path can accidentally depend on it.
//
// Auth note (documented assumption): OAuth tokens are stored encrypted at rest via
// `CalendarAccount.refreshTokenEnc`. In this codebase encryption is delegated to the deployment
// platform's secret store / a KMS wrapper — the plaintext token never reaches a log or a client.

import { googleSyncConfigured } from "@/lib/env";
import type { CalendarSyncProvider, ExternalEvent, SyncCursor } from "./index";

const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

interface GoogleDateTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

interface GoogleEvent {
  id: string;
  etag?: string;
  status?: "confirmed" | "tentative" | "cancelled";
  summary?: string;
  description?: string;
  location?: string;
  start?: GoogleDateTime;
  end?: GoogleDateTime;
  recurrence?: string[];
}

export class GoogleCalendarProvider implements CalendarSyncProvider {
  readonly name = "google";

  constructor() {
    if (!googleSyncConfigured()) throw new Error("GOOGLE_SYNC_NOT_CONFIGURED");
  }

  private async accessToken(refreshToken: string): Promise<string> {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_CLIENT_SECRET!,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`google-token-${response.status}`);
    const body = (await response.json()) as { access_token?: string };
    if (!body.access_token) throw new Error("google-token-missing");
    return body.access_token;
  }

  async pull(
    refreshToken: string,
    calendarId: string,
    cursor: SyncCursor,
  ): Promise<{ events: ExternalEvent[]; cursor: SyncCursor }> {
    const token = await this.accessToken(refreshToken);
    const url = new URL(`${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`);
    url.searchParams.set("singleEvents", "false"); // keep RRULEs intact; we expand them ourselves
    url.searchParams.set("maxResults", "250");
    if (cursor.syncToken) {
      url.searchParams.set("syncToken", cursor.syncToken);
    } else {
      url.searchParams.set("timeMin", new Date(Date.now() - 90 * 86_400_000).toISOString());
    }

    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (response.status === 410) {
      // The sync token expired. Restart the window rather than failing forever.
      return this.pull(refreshToken, calendarId, { syncToken: null });
    }
    if (!response.ok) throw new Error(`google-events-${response.status}`);

    const body = (await response.json()) as { items?: GoogleEvent[]; nextSyncToken?: string };
    const events = (body.items ?? []).map((item) => this.toExternal(item));

    return { events, cursor: { syncToken: body.nextSyncToken ?? cursor.syncToken } };
  }

  async push(refreshToken: string, calendarId: string, event: ExternalEvent): Promise<{ externalId: string }> {
    const token = await this.accessToken(refreshToken);
    const response = await fetch(
      `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          summary: event.title,
          description: event.notes ?? undefined,
          location: event.location ?? undefined,
          start: this.toGoogleDateTime(event, true),
          end: this.toGoogleDateTime(event, false),
          recurrence: event.rrule ? [`RRULE:${event.rrule}`] : undefined,
        }),
      },
    );
    if (!response.ok) throw new Error(`google-push-${response.status}`);
    const body = (await response.json()) as GoogleEvent;
    return { externalId: body.id };
  }

  private toExternal(item: GoogleEvent): ExternalEvent {
    const isAllDay = Boolean(item.start?.date);
    return {
      externalId: item.id,
      etag: item.etag ?? null,
      title: item.summary ?? "Untitled",
      notes: item.description ?? null,
      location: item.location ?? null,
      allDay: isAllDay,
      startUtc: !isAllDay && item.start?.dateTime ? new Date(item.start.dateTime) : null,
      endUtc: !isAllDay && item.end?.dateTime ? new Date(item.end.dateTime) : null,
      // Google's all-day DTEND is exclusive, which matches our storage exactly.
      startDate: isAllDay ? (item.start?.date ?? null) : null,
      endDate: isAllDay ? (item.end?.date ?? null) : null,
      rrule: item.recurrence?.find((r) => r.startsWith("RRULE:"))?.slice("RRULE:".length) ?? null,
      timezone: item.start?.timeZone ?? "UTC",
      deleted: item.status === "cancelled",
    };
  }

  private toGoogleDateTime(event: ExternalEvent, isStart: boolean): GoogleDateTime {
    if (event.allDay) {
      return { date: (isStart ? event.startDate : event.endDate) ?? event.startDate ?? "" };
    }
    const instant = isStart ? event.startUtc : event.endUtc;
    return { dateTime: (instant ?? event.startUtc ?? new Date()).toISOString(), timeZone: event.timezone };
  }
}
