import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ["web-push", "@prisma/client"],
  experimental: {
    // Server Actions receive FormData; keep the body budget small and predictable.
    serverActions: { bodySizeLimit: "1mb" },
  },
  async headers() {
    return [
      {
        // The service worker must never be cached, or alarm/offline fixes never ship.
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
};

export default nextConfig;
