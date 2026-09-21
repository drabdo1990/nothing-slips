// app/login/page.tsx

import { redirect } from "next/navigation";
import { auth, signIn } from "@/server/auth";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { CalendarClock } from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; sent?: string }>;
}) {
  const session = await auth();
  if (session?.user?.id) redirect("/");
  const params = await searchParams;

  async function sendMagicLink(formData: FormData) {
    "use server";
    const email = String(formData.get("email") ?? "").trim();
    if (!email) return;
    await signIn("resend", { email, redirectTo: "/" });
  }

  return (
    <div className="flex min-h-[70dvh] flex-col justify-center gap-6">
      <div className="text-center">
        <CalendarClock aria-hidden className="mx-auto size-8 text-primary-500" />
        <h1 className="mt-3 text-2xl font-semibold text-ink">Nothing Slips</h1>
        <p className="mt-1 text-sm text-slate">
          One person&apos;s schedule, with alarms that actually fire.
        </p>
      </div>

      <Card className="p-4">
        {params.error ? (
          <p role="alert" className="mb-3 rounded-lg border border-danger-500/40 bg-danger-50 p-3 text-sm text-danger-500">
            That sign-in link did not work. It may have expired — request a new one below.
          </p>
        ) : null}

        <form action={sendMagicLink} className="flex flex-col gap-3">
          <Field
            label="Email"
            id="email"
            hint="We send a one-time sign-in link. No password to remember."
          >
            <Input id="email" name="email" type="email" required autoComplete="email" placeholder="you@example.com" />
          </Field>
          <Button type="submit">Email me a sign-in link</Button>
        </form>

        <p className="mt-4 border-t border-mist pt-3 text-xs text-slate">
          Your calendar is private to your account. Nobody else can read or change it.
        </p>
      </Card>
    </div>
  );
}
