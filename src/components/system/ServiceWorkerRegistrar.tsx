// src/components/system/ServiceWorkerRegistrar.tsx
"use client";

import { useEffect } from "react";

/**
 * Registers the service worker once, after paint, so it never competes with the first render.
 * Without this the push channel has nowhere to land: a notification with no worker is not delivered.
 */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    if (process.env.NODE_ENV !== "production") return; // HMR + a SW is a bad combination

    const register = () => {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
        // Registration failure degrades to in-app alerts only; it must never break the page.
      });
    };

    if (document.readyState === "complete") register();
    else {
      window.addEventListener("load", register, { once: true });
      return () => window.removeEventListener("load", register);
    }
  }, []);

  return null;
}
