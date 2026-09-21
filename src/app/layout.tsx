// app/layout.tsx
import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { BottomNav } from "@/components/nav/BottomNav";
import { OfflineBanner } from "@/components/system/OfflineBanner";
import { ServiceWorkerRegistrar } from "@/components/system/ServiceWorkerRegistrar";
import { AlarmProvider } from "@/components/alarm/AlarmProvider";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "Nothing Slips", template: "%s · Nothing Slips" },
  description:
    "A calm, dependable personal scheduler. Every commitment, with an alarm that actually fires.",
  applicationName: "Nothing Slips",
  manifest: "/manifest.webmanifest",
  // The manifest covers Android/desktop install; these cover the browser tab and iOS Home Screen,
  // which do not read the manifest for their icons.
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: { capable: true, title: "Nothing Slips", statusBarStyle: "default" },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f8fafc" },
    { media: "(prefers-color-scheme: dark)", color: "#101a22" },
  ],
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="min-h-dvh font-sans text-base antialiased">
        {/* Skip link: the today view is dense and keyboard users need a fast path. */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:shadow-card"
        >
          Skip to main content
        </a>

        <OfflineBanner />
        {/* Alarms are mounted above everything: when one fires, it owns the screen. It quietly
            no-ops on the login page (a 401 simply stops the poll). */}
        <AlarmProvider />
        <main id="main" className="mx-auto w-full max-w-2xl px-4 pb-24 pt-4 sm:px-6">
          {children}
        </main>
        <BottomNav />
        <ServiceWorkerRegistrar />
      </body>
    </html>
  );
}
