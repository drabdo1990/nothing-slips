// public/sw.js
//
// The service worker. Two jobs, and only two:
//   1. Receive a push and SHOW AN ALARM. This is what makes "works with the tab closed" true.
//   2. Serve the app shell offline so the today view opens on the train.
//
// It deliberately contains no scheduling logic. There is no timer here that decides whether
// something is due — the server decides, sends a push, and this file renders it.

const VERSION = "v1";
const SHELL_CACHE = `shell-${VERSION}`;
const RUNTIME_CACHE = `runtime-${VERSION}`;
const SHELL_ASSETS = ["/", "/calendar", "/agenda", "/offline", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      // A failed asset must not abort installation, or the app never gets offline support at all.
      .then((cache) => Promise.allSettled(SHELL_ASSETS.map((asset) => cache.add(asset))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== SHELL_CACHE && key !== RUNTIME_CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Never cache the reminder feed: a stale "what is due" is worse than no answer.
  if (url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(request);
          return cached ?? (await caches.match("/offline")) ?? Response.error();
        }),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) {
        // Stale-while-revalidate: instant paint, refreshed in the background.
        event.waitUntil(
          fetch(request)
            .then((response) => caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, response.clone())))
            .catch(() => undefined),
        );
        return cached;
      }
      return fetch(request).catch(() => Response.error());
    }),
  );
});

// ────────────────────────────────────────────────────────────── alarms

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: "Reminder", body: "You have something coming up." };
  }

  const title = payload.title || "Reminder";
  const options = {
    body: payload.body || "",
    // The collapse key: a duplicate delivery for the same occurrence+offset REPLACES this
    // notification instead of stacking a second alarm. This is the last line of defence for the
    // at-least-once delivery model.
    tag: payload.tag || "nothing-slips",
    renotify: false,
    requireInteraction: payload.requireInteraction !== false,
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    // Alarms are the one place an assertive vibration is correct.
    vibrate: [180, 90, 180],
    data: { url: payload.url || "/", ...(payload.data || {}) },
    actions: [
      { action: "snooze10", title: "Snooze 10 min" },
      { action: "ack", title: "Got it" },
    ],
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  const data = event.notification.data || {};
  const reminderId = data.reminderId;
  event.notification.close();

  if (event.action === "snooze10" && reminderId) {
    event.waitUntil(postReminder(reminderId, { action: "snooze", minutes: 10 }));
    return;
  }

  if (event.action === "ack" && reminderId) {
    event.waitUntil(postReminder(reminderId, { action: "ack" }));
    return;
  }

  // Body click: deep-link into the event so the user lands where the alarm pointed.
  const target = new URL(data.url || "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.startsWith(self.location.origin) && "focus" in client) {
          client.navigate(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});

/**
 * Fire-and-forget state change from a notification action. If it fails (offline), the notification
 * is already dismissed — the reminder stays unresolved server-side and will re-appear in the in-app
 * feed, which is the honest failure mode.
 */
function postReminder(reminderId, body) {
  return fetch(`/api/reminders/${reminderId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  }).catch(() => undefined);
}
