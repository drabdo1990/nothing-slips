// src/server/auth.ts
//
// Auth.js v5 (NextAuth) + Prisma adapter, email magic-link via Resend.
// One email vendor for both sign-in and alarm fallback: fewer moving parts, one deliverability story.
//
// The only thing the rest of the app knows about auth is:
//   * `auth()`            → session or null     (route handlers, server components)
//   * `requireUser()`     → session.user.id     (throws/redirects if absent)

import NextAuth from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import Resend from "next-auth/providers/resend";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  // Database sessions: revocable server-side, which matters for a private calendar.
  session: { strategy: "database", maxAge: 60 * 60 * 24 * 30 },
  secret: env.AUTH_SECRET,
  trustHost: true,
  providers: [
    Resend({
      apiKey: env.RESEND_API_KEY,
      from: env.EMAIL_FROM,
    }),
  ],
  pages: {
    signIn: "/login",
    verifyRequest: "/login/check-email",
    error: "/login",
  },
  callbacks: {
    session({ session, user }) {
      // Downstream code reads `session.user.id` and nothing else about identity.
      session.user.id = user.id;
      return session;
    },
  },
});

export { handlers as authHandlers };
