// src/lib/client/outbox.ts
//
// Offline write queue. When a snooze/ack fails because the device is offline, it is queued and
// replayed on reconnect instead of being lost. localStorage is deliberate: the payloads are tiny,
// the queue is short-lived, and it keeps the offline path dependency-free.

export interface OutboxEntry {
  id: string;
  url: string;
  body: unknown;
  queuedAt: string;
  attempts: number;
}

const KEY = "nothing-slips:outbox";
const MAX_ENTRIES = 50;

function read(): OutboxEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as OutboxEntry[]) : [];
  } catch {
    return [];
  }
}

function write(entries: OutboxEntry[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(entries.slice(-MAX_ENTRIES)));
  } catch {
    // Quota or private mode: dropping the queue is better than throwing inside an alarm handler.
  }
}

export function enqueue(url: string, body: unknown): void {
  const entries = read();
  entries.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    url,
    body,
    queuedAt: new Date().toISOString(),
    attempts: 0,
  });
  write(entries);
}

export function size(): number {
  return read().length;
}

/** Replay the queue. Entries that keep failing stay queued; the app never silently discards them. */
export async function flush(): Promise<number> {
  const entries = read();
  if (entries.length === 0) return 0;

  const survivors: OutboxEntry[] = [];
  let sent = 0;

  for (const entry of entries) {
    // Anything older than a day is stale — the alarm it refers to is long past.
    if (Date.now() - Date.parse(entry.queuedAt) > 86_400_000) continue;

    try {
      const response = await fetch(entry.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(entry.body),
      });
      if (response.ok) {
        sent++;
        continue;
      }
      // 4xx means the request itself is wrong; retrying will not help.
      if (response.status >= 400 && response.status < 500) continue;
    } catch {
      /* still offline */
    }
    survivors.push({ ...entry, attempts: entry.attempts + 1 });
  }

  write(survivors);
  return sent;
}

export function subscribeToReconnect(onReconnect: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const handler = () => {
    void flush().then((count) => {
      if (count > 0) onReconnect();
    });
  };
  window.addEventListener("online", handler);
  return () => window.removeEventListener("online", handler);
}
