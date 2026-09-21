// src/lib/client/push.ts
//
// Browser-side push subscription lifecycle.
//
// PERMISSION TIMING: `Notification.requestPermission()` is only ever called from a real user
// gesture, on a card that explains why. Asking on first load is how an app gets permanently blocked
// — and a blocked permission is unrecoverable from inside the app.

export type PushState =
  | "unsupported" // no service worker / no Push API
  | "unconfigured" // server has no VAPID keys (email-only deployment)
  | "blocked" // user (or policy) denied — recoverable only in browser settings
  | "subscribed" // we have a live subscription registered server-side
  | "available"; // supported, not yet asked

export async function getPushState(): Promise<PushState> {
  if (typeof window === "undefined") return "unsupported";
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return "unsupported";

  try {
    const response = await fetch("/api/push/subscribe", { cache: "no-store" });
    if (!response.ok) return "unsupported";
    const body = (await response.json()) as { enabled: boolean };
    if (!body.enabled) return "unconfigured";

    if (Notification.permission === "denied") return "blocked";

    const registration = await navigator.serviceWorker.getRegistration();
    const existing = await registration?.pushManager.getSubscription();
    if (existing && Notification.permission === "granted") return "subscribed";

    return "available";
  } catch {
    return "unsupported";
  }
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(normalized);
  // Explicit ArrayBuffer so the type is a plain BufferSource, not ArrayBufferLike.
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

export interface SubscribeResult {
  ok: boolean;
  state: PushState;
  reason?: string;
}

/**
 * Must be called from a click handler. Returns the resulting state so the UI can explain a denial
 * rather than leaving the user wondering whether alarms are on.
 */
export async function subscribeToPush(): Promise<SubscribeResult> {
  const state = await getPushState();
  if (state === "unsupported" || state === "unconfigured" || state === "blocked") {
    return { ok: false, state, reason: state };
  }

  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      return { ok: false, state: permission === "denied" ? "blocked" : "available", reason: "permission" };
    }

    const config = (await fetch("/api/push/subscribe", { cache: "no-store" }).then((r) => r.json())) as {
      publicKey: string | null;
    };
    if (!config.publicKey) return { ok: false, state: "unconfigured", reason: "no-vapid-key" };

    const registration =
      (await navigator.serviceWorker.getRegistration()) ??
      (await navigator.serviceWorker.register("/sw.js", { scope: "/" }));
    await navigator.serviceWorker.ready;

    const subscription =
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true, // required by Chrome; also a promise we intend to keep
        applicationServerKey: urlBase64ToUint8Array(config.publicKey),
      }));

    const json = subscription.toJSON() as { endpoint?: string; keys?: { p256dh: string; auth: string } };
    if (!json.endpoint || !json.keys) return { ok: false, state, reason: "malformed-subscription" };

    const response = await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
    });
    if (!response.ok) return { ok: false, state, reason: "server-rejected" };

    return { ok: true, state: "subscribed" };
  } catch (error) {
    return { ok: false, state, reason: error instanceof Error ? error.message : "subscribe-failed" };
  }
}

export async function unsubscribeFromPush(): Promise<SubscribeResult> {
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    if (!subscription) return { ok: true, state: "available" };

    await fetch("/api/push/unsubscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    });
    await subscription.unsubscribe();
    return { ok: true, state: "available" };
  } catch {
    return { ok: false, state: "available", reason: "unsubscribe-failed" };
  }
}
