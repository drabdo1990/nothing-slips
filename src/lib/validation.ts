// src/lib/validation.ts
//
// One zod schema per mutation, used by BOTH the server action and the API route. Validating in the
// UI and again on the server is not duplication; the server check is the security boundary, the
// client check is a courtesy.

import { z } from "zod";
import { isValidIanaZone } from "@/lib/time/zone";
import { MAX_OFFSET_MINUTES } from "@/lib/reminders/offsets";

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date");

const ianaZone = z.string().refine(isValidIanaZone, "Expected an IANA timezone like Europe/Berlin");

const rruleString = z
  .string()
  .trim()
  .min(1)
  .max(500)
  // Only the RRULE part is accepted; DTSTART always comes from the event row, so there is exactly
  // one source of truth for "when does this series start".
  .refine(
    (value) => !/DTSTART/i.test(value),
    "DTSTART is derived from the event start and must not be set directly",
  )
  .refine((value) => /FREQ=(SECONDLY|MINUTELY|HOURLY|DAILY|WEEKLY|MONTHLY|YEARLY)/i.test(value), {
    message: "RRULE must declare a FREQ",
  });

export const reminderRuleSchema = z.object({
  offsetMinutes: z.number().int().min(0).max(MAX_OFFSET_MINUTES),
  channels: z.array(z.enum(["push", "email"])).min(1),
});

export const eventInputSchema = z
  .object({
    title: z.string().trim().min(1, "Give it a title").max(200),
    notes: z.string().trim().max(4000).optional().nullable(),
    location: z.string().trim().max(300).optional().nullable(),
    categoryId: z.string().cuid().optional().nullable(),
    allDay: z.boolean().default(false),
    timezone: ianaZone,
    // Timed events carry instants; all-day events carry dates. Both are validated, and the
    // refinement below rejects the combinations that would otherwise corrupt the timeline.
    startUtc: z.coerce.date().optional().nullable(),
    endUtc: z.coerce.date().optional().nullable(),
    startDate: isoDate.optional().nullable(),
    endDate: isoDate.optional().nullable(),
    rrule: rruleString.optional().nullable(),
    overrideQuietHours: z.boolean().default(false),
    travelBufferMinutes: z.number().int().min(0).max(240).default(0),
    reminders: z.array(reminderRuleSchema).max(5).default([]),
  })
  .superRefine((value, ctx) => {
    if (value.allDay) {
      if (!value.startDate) {
        ctx.addIssue({ code: "custom", path: ["startDate"], message: "All-day events need a start date" });
      }
      if (!value.endDate) {
        ctx.addIssue({ code: "custom", path: ["endDate"], message: "All-day events need an end date" });
      }
      if (value.startDate && value.endDate && value.endDate <= value.startDate) {
        ctx.addIssue({
          code: "custom",
          path: ["endDate"],
          message: "The end date must be after the start date (it is exclusive)",
        });
      }
      if (value.startUtc || value.endUtc) {
        ctx.addIssue({
          code: "custom",
          path: ["startUtc"],
          message: "All-day events must not carry a timestamp — that is how all-day blocks shift",
        });
      }
      return;
    }

    if (!value.startUtc) {
      ctx.addIssue({ code: "custom", path: ["startUtc"], message: "A start time is required" });
    }
    if (!value.endUtc) {
      ctx.addIssue({ code: "custom", path: ["endUtc"], message: "An end time is required" });
    }
    if (value.startUtc && value.endUtc && value.endUtc.getTime() <= value.startUtc.getTime()) {
      ctx.addIssue({ code: "custom", path: ["endUtc"], message: "The end must be after the start" });
    }
    if (value.startDate || value.endDate) {
      ctx.addIssue({
        code: "custom",
        path: ["startDate"],
        message: "Timed events must not carry date-only fields",
      });
    }
  });

export type EventInput = z.infer<typeof eventInputSchema>;
export type ReminderRuleInputDto = z.infer<typeof reminderRuleSchema>;

export const quickAddSchema = z.object({
  text: z.string().trim().min(2, "Type something like “dentist thursday 3pm”").max(300),
  timezone: ianaZone.optional(),
});

export const settingsInputSchema = z
  .object({
    name: z.string().trim().max(120).optional().nullable(),
    timezone: ianaZone,
    quietHoursEnabled: z.boolean(),
    quietHoursStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:mm"),
    quietHoursEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:mm"),
    dnd: z.boolean(),
    defaultReminderOffsets: z.array(z.number().int().min(0).max(MAX_OFFSET_MINUTES)).max(5),
    emailFallbackEnabled: z.boolean(),
  })
  .superRefine((value, ctx) => {
    if (value.quietHoursEnabled && value.quietHoursStart === value.quietHoursEnd) {
      ctx.addIssue({
        code: "custom",
        path: ["quietHoursEnd"],
        message: "Choose an end time different from the start, or turn quiet hours off",
      });
    }
  });

export type SettingsInput = z.infer<typeof settingsInputSchema>;

export const pushSubscriptionSchema = z.object({
  endpoint: z.string().url().max(1000),
  keys: z.object({
    p256dh: z.string().min(1).max(500),
    auth: z.string().min(1).max(500),
  }),
});

export const scopeSchema = z.enum(["this", "thisAndFuture", "series"]).default("series");
export type MutationScope = z.infer<typeof scopeSchema>;

/** Turns a zod error into a { field: message } map the form can render inline. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_";
    out[key] ??= issue.message;
  }
  return out;
}
