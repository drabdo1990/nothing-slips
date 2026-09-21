// src/lib/notifications/email.ts
//
// Email is the fallback — when push is denied, unavailable, or the browser dropped the
// subscription. It reuses the same Resend account as auth, so there is one deliverability story.
// The template applies the same design language as the app: calm, clear, tabular numerals.

import { Resend } from "resend";
import { emailConfigured, env } from "@/lib/env";

export interface EmailAlarm {
  to: string;
  eventTitle: string;
  /** Pre-formatted, already zone-labelled time range. */
  whenText: string;
  /** Full sentence for the heading/alt text. */
  whenAria: string;
  offsetLabel: string;
  location?: string | null;
  notes?: string | null;
  lateBySeconds: number | null;
  eventUrl: string;
  unsubscribeUrl: string;
}

export type EmailResult =
  | { ok: true; channel: "email" }
  | { ok: false; channel: "email"; error: string };

let client: Resend | null = null;

function resend(): Resend | null {
  if (!emailConfigured()) return null;
  client ??= new Resend(env.RESEND_API_KEY!);
  return client;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderHtml(alarm: EmailAlarm): string {
  const late =
    alarm.lateBySeconds && alarm.lateBySeconds >= 45
      ? `<p style="margin:8px 0 0;font-size:13px;color:#b47b1e">Delivered ${Math.round(
          alarm.lateBySeconds / 60,
        )} min late — the scheduler tick was behind.</p>`
      : "";

  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f8fafc;font-family:Inter,-apple-system,Segoe UI,sans-serif;color:#14202b">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto">
    <tr><td style="background:#ffffff;border:1px solid #e6ebf1;border-radius:14px;padding:24px">
      <p style="margin:0 0 12px;font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:#3e6b8c">
        ${escapeHtml(alarm.offsetLabel)}
      </p>
      <h1 style="margin:0 0 8px;font-size:22px;line-height:1.25;font-weight:600">
        ${escapeHtml(alarm.eventTitle)}
      </h1>
      <p style="margin:0;font-size:16px;font-variant-numeric:tabular-nums;color:#14202b">
        <time>${escapeHtml(alarm.whenText)}</time>
      </p>
      <p style="margin:4px 0 0;font-size:13px;color:#5a6b7b">${escapeHtml(alarm.whenAria)}</p>
      ${
        alarm.location
          ? `<p style="margin:12px 0 0;font-size:14px;color:#5a6b7b">📍 ${escapeHtml(alarm.location)}</p>`
          : ""
      }
      ${late}
      ${
        alarm.notes
          ? `<p style="margin:16px 0 0;padding-top:16px;border-top:1px solid #e6ebf1;font-size:14px;color:#5a6b7b;white-space:pre-wrap">${escapeHtml(
              alarm.notes,
            )}</p>`
          : ""
      }
      <p style="margin:24px 0 0">
        <a href="${escapeHtml(alarm.eventUrl)}"
           style="display:inline-block;background:#3e6b8c;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:8px;font-size:15px">
          Open in Nothing Slips
        </a>
      </p>
    </td></tr>
    <tr><td style="padding:16px 4px;font-size:12px;color:#93a2b1">
      You are receiving this because email fallback is on.
      <a href="${escapeHtml(alarm.unsubscribeUrl)}" style="color:#93a2b1">Turn off email alarms</a>.
    </td></tr>
  </table>
</body></html>`;
}

function renderText(alarm: EmailAlarm): string {
  const lines = [
    alarm.offsetLabel.toUpperCase(),
    alarm.eventTitle,
    alarm.whenText,
    alarm.whenAria,
  ];
  if (alarm.location) lines.push(`Location: ${alarm.location}`);
  if (alarm.lateBySeconds && alarm.lateBySeconds >= 45) {
    lines.push(`Delivered ${Math.round(alarm.lateBySeconds / 60)} min late.`);
  }
  if (alarm.notes) lines.push("", alarm.notes);
  lines.push("", `Open: ${alarm.eventUrl}`, `Turn off email alarms: ${alarm.unsubscribeUrl}`);
  return lines.join("\n");
}

export async function sendAlarmEmail(alarm: EmailAlarm): Promise<EmailResult> {
  const resendClient = resend();
  if (!resendClient) return { ok: false, channel: "email", error: "email-not-configured" };

  try {
    const { error } = await resendClient.emails.send({
      from: env.EMAIL_FROM,
      to: alarm.to,
      subject: `${alarm.offsetLabel}: ${alarm.eventTitle}`,
      html: renderHtml(alarm),
      text: renderText(alarm),
    });
    if (error) return { ok: false, channel: "email", error: `resend-${error.name ?? "error"}` };
    return { ok: true, channel: "email" };
  } catch {
    // Never surface raw provider errors: they can echo recipient addresses into logs.
    return { ok: false, channel: "email", error: "email-transport-error" };
  }
}
