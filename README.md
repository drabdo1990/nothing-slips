# Nothing Slips

A calm, dependable personal scheduler whose entire value proposition is that **nothing slips**.

You open it in the morning to see the shape of your day, add things in seconds throughout the day,
and — critically — you are warned before each commitment, whether the tab is open or closed.

Built as a mobile-first PWA on Next.js 15 (App Router), Prisma/Postgres, Luxon + RFC 5545 RRULE, and
Web Push.

---

## Quick start

```bash
npm install
cp .env.example .env.local     # then fill it in (see below)
npm run db:push                # creates the schema (Neon/Supabase: use the pooled URL)
npm run db:seed                # seed data covering the awkward timezone cases
npm run dev
```

Generate the two secrets you cannot invent:

```bash
npx web-push generate-vapid-keys   # → NEXT_PUBLIC_VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY
openssl rand -base64 32            # → AUTH_SECRET
openssl rand -hex 24               # → CRON_SECRET
```

The app **fails fast at boot** if `DATABASE_URL` or `AUTH_SECRET` is missing, rather than
misbehaving later. Push keys are optional: without them the app degrades to email + in-app alarms
instead of breaking.

### Scheduled work

`vercel.json` registers two cron jobs:

| Path | Schedule | Purpose |
|---|---|---|
| `/api/cron/tick` | every minute | materialize reminders, deliver due alarms |
| `/api/cron/sync-calendars` | every 15 min | optional Google two-way sync |

Vercel sends `Authorization: Bearer $CRON_SECRET`; the routes require it in production.

Locally, there is no cron — run the scheduler by hand:

```bash
npm run tick
```

---

## Architecture

```
app/
  page.tsx                    Today: what's now / next / overdue, plus the day's real shape
  calendar/page.tsx           day · week · month (URL-driven, so views are shareable)
  agenda/page.tsx             flat list, searchable + filterable
  event/new, event/[id]       create and edit, incl. the alarm audit trail
  settings/page.tsx           timezone, quiet hours, DND, defaults, ICS, push
  login/                      magic-link auth
  api/cron/tick               THE scheduler entrypoint
  api/reminders/active        in-app alarm feed (the browser polls; it never decides)
  api/reminders/[id]          ack/snooze, used by the service worker's notification actions
  api/push/*                  subscription lifecycle
  api/quick-add               natural-language → draft event
  api/ics, api/ics/import     export (series stay as RRULEs) and preview-then-commit import

lib/
  time/zone.ts                UTC ⇄ IANA wall clock. The ONLY place conversions happen.
  time/recurrence.ts          RRULE → occurrences (floating-local expansion, see below)
  time/rrule-edit.ts          series surgery: "this and future" via UNTIL
  time/quietHours.ts, format.ts, status.ts
  reminders/plan.ts           pure scheduling core: what to schedule, when to fire, how to settle
  reminders/scheduler.ts      the tick: materialize → reclaim → claim → deliver → settle
  notifications/              push (web-push) + email (Resend) + fan-out policy
  quickAdd/parser.ts          chrono-node for dates, our own RRULE mapping
  conflicts.ts                overlap + travel-gap detection, day shape
  ics/, sync/                 interchange and the optional Google seam
  client/                     browser-only: push subscription, offline outbox

server/
  guards.ts                   THE authorization boundary (requireUser, assertOwns*)
  queries.ts                  all reads, all scoped to the owning user
  actions/                    mutations (events, reminders, settings)
```

### The two ideas that hold it together

**1. Floating-local RRULE expansion.** An RRULE describes a *wall clock* ("every Thursday at
09:00"), not an instant. Expanding it in UTC would silently turn a 09:00 Berlin meeting into 10:00
after the spring DST change. So `recurrence.ts` expands in a fake-UTC frame whose components are the
series' own wall clock, then converts each result through Luxon per date. `rrule-edit.ts` writes
`UNTIL` in that same frame. `tests/recurrence.test.ts` and `tests/rrule-edit.test.ts` pin this down.

**2. The alarm is a row with state, never an inference.** A reminder moves
`pending → claimed → sent → acknowledged | snoozed | missed`, with `deferred` for quiet hours and
`cancelled` for edits. Idempotency is structural:

- `@@unique([occurrenceId, offsetMinutes, scheduledFor])` + `createMany({ skipDuplicates: true })`
  means a re-run of the materializer inserts nothing.
- Claiming uses `UPDATE … FOR UPDATE SKIP LOCKED`, so two overlapping ticks split the work rather
  than duplicating it, and a crashed tick's lease is reclaimed after 120s.
- Delivery is at-least-once; a duplicate push collapses in the OS via the payload `tag`.
- Every attempt is written to `NotificationLog` with channel, result and lateness.

`setTimeout` appears in exactly one place — the in-tab countdown. It never decides whether to alarm.

---

## Verify the hard promises yourself

```bash
npm run db:seed     # plants an overdue reminder and prints what the scheduler materialized
npm run tick        # delivers it, reporting how late it was
npm run tick        # run again: delivers NOTHING (nothing left to claim)

npx vitest run      # 84 tests: DST, all-day, EXDATE, overrides, idempotency, quiet hours, ICS
```

Seed data deliberately includes a series crossing the spring DST boundary, a multi-day all-day
block, a meeting pinned to `America/New_York` viewed from Berlin, a per-occurrence override, an
EXDATE, a quiet-hours override, and one already-overdue alarm.

---

## Design language

*Calm, clear, dependable, quiet, precise.* Tokens live in one place: `src/app/globals.css` under
`@theme`. Nothing in the app hardcodes a hex value.

- **Primary** steel-blue `#3E6B8C`, **secondary** sage `#6C8F7E`, neutrals ink/slate/mist/paper.
- **Status** upcoming `#3E6B8C` · imminent `#B47B1E` · now `#2E7D5B` · overdue `#B4453A` ·
  done `#93A2B1` — always paired with a text label, so colour is never the only signal.
- **Numerals are tabular** everywhere (`time, .tabular`), because times are data.
- **Motion** is 150–250ms and subtle. The alarm banner is the single assertive animation in the app;
  an app people mute is a failed app.
- Every countdown ships a screen-reader sentence alongside the visual value, and the zone is
  labelled whenever it differs from the viewer's.

---

## Deliberate assumptions

Stated so they are easy to revisit:

1. **Auth is Auth.js v5 + magic link via Resend** — one email vendor for both sign-in and alarm
   fallback, one deliverability story.
2. **Scheduling is Vercel Cron + a stateful `Reminder` table**, not Inngest/QStash. Postgres is
   already there, the idempotency guarantee falls out of a unique constraint, and it costs nothing.
   The seam is `/api/cron/tick`, so swapping in a real queue means changing one caller.
3. **Reminders are materialized 45 days ahead, not infinitely.** `reminderRules` are the template;
   `reminders` are the work. Occurrences are never written to the database in bulk.
4. **Quick-add treats a date with no spoken time as all-day** and says so in the preview, rather
   than inventing a time. `forwardDate` is on: an appointment is always ahead of you.
5. **A very late alarm (>3h) is recorded as `missed` rather than fired**, with the lateness logged.
   Firing at 3am for a 9am meeting is noise, and the log still answers "did it alarm me?".
6. **Conflicts warn, they do not block.** People double-book on purpose.
7. **Push subscriptions are reassigned on sign-in** (the endpoint is the device's own secret, and
   the device is authenticated as whoever is signed in now).
8. **Google Calendar sync is a stub behind `CalendarSyncProvider`.** `NoopProvider` is the default;
   nothing in `lib/time`, `lib/reminders` or `server/actions` imports it, and sync writes only
   `Event.externalSource`/`externalId` plus `CalendarAccount`. Delete the folder and the feature is
   gone cleanly.
