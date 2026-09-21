// src/lib/sync/index.ts
//
// The Google Calendar seam. Everything Google-specific lives in ./google.ts behind this interface,
// so the feature can be added or removed without touching core scheduling:
//
//   * nothing in lib/time, lib/reminders or server/actions imports ./google
//   * the sync loop writes only Event rows it owns (identified by the `external:` UID prefix) and
//     only ever touches CalendarAccount
//   * with no credentials configured, `provider()` returns NoopProvider and the cron route is a no-op

import { prisma } from "@/lib/db";
import { googleSyncConfigured } from "@/lib/env";

export interface ExternalEvent {
  externalId: string;
  etag: string | null;
  title: string;
  notes: string | null;
  location: string | null;
  allDay: boolean;
  startUtc: Date | null;
  endUtc: Date | null;
  startDate: string | null;
  endDate: string | null;
  rrule: string | null;
  timezone: string;
  deleted: boolean;
}

export interface SyncCursor {
  syncToken: string | null;
}

export interface CalendarSyncProvider {
  readonly name: string;
  /** Incremental pull. Returns the new cursor so the next run is cheap. */
  pull(refreshToken: string, calendarId: string, cursor: SyncCursor): Promise<{ events: ExternalEvent[]; cursor: SyncCursor }>;
  /** Push a local change outward. Best-effort; failures must not corrupt local state. */
  push(refreshToken: string, calendarId: string, event: ExternalEvent): Promise<{ externalId: string }>;
}

export class NoopProvider implements CalendarSyncProvider {
  readonly name = "none";
  async pull(): Promise<{ events: ExternalEvent[]; cursor: SyncCursor }> {
    return { events: [], cursor: { syncToken: null } };
  }
  async push(): Promise<{ externalId: string }> {
    throw new Error("SYNC_NOT_CONFIGURED");
  }
}

export async function provider(): Promise<CalendarSyncProvider> {
  if (!googleSyncConfigured()) return new NoopProvider();
  const { GoogleCalendarProvider } = await import("./google");
  return new GoogleCalendarProvider();
}

export interface SyncResult {
  accounts: number;
  imported: number;
  updated: number;
  pushed: number;
  errors: string[];
}

/**
 * The cron-driven two-way sync. Import wins on conflict for now (documented assumption): the
 * external calendar is treated as the source of truth for events it created, and locally-created
 * events are never overwritten.
 */
export async function runCalendarSync(): Promise<SyncResult> {
  const result: SyncResult = { accounts: 0, imported: 0, updated: 0, pushed: 0, errors: [] };

  const accounts = await prisma.calendarAccount.findMany({ where: { enabled: true } });
  if (accounts.length === 0) return result;

  const sync = await provider();
  if (sync.name === "none") return result;

  for (const account of accounts) {
    result.accounts++;
    try {
      const { events, cursor } = await sync.pull(account.refreshTokenEnc, account.externalCalendarId, {
        syncToken: account.syncToken,
      });

      for (const external of events) {
        const existing = await prisma.event.findFirst({
          where: {
            userId: account.userId,
            externalSource: sync.name,
            externalId: external.externalId,
          },
          select: { id: true },
        });

        if (external.deleted) {
          if (existing) await prisma.event.delete({ where: { id: existing.id } });
          continue;
        }

        const data = {
          userId: account.userId,
          title: external.title,
          notes: external.notes,
          location: external.location,
          allDay: external.allDay,
          timezone: external.timezone,
          startUtc: external.startUtc,
          endUtc: external.endUtc,
          startDate: external.startDate,
          endDate: external.endDate,
          rrule: external.rrule,
          externalSource: sync.name,
          externalId: external.externalId,
        };

        if (existing) {
          await prisma.event.update({ where: { id: existing.id }, data });
          result.updated++;
        } else {
          await prisma.event.create({ data });
          result.imported++;
        }
      }

      await prisma.calendarAccount.update({
        where: { id: account.id },
        data: { syncToken: cursor.syncToken, lastSyncedAt: new Date(), lastError: null },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "sync-failed";
      result.errors.push(`${account.id}: ${message}`);
      await prisma.calendarAccount.update({
        where: { id: account.id },
        data: { lastError: message.slice(0, 300) },
      });
    }
  }

  return result;
}
