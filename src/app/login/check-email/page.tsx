// app/login/check-email/page.tsx

import { MailCheck } from "lucide-react";
import { Card } from "@/components/ui/Card";

export const dynamic = "force-static";
export const metadata = { title: "Check your email" };

export default function CheckEmailPage() {
  return (
    <div className="flex min-h-[70dvh] flex-col justify-center">
      <Card className="p-6 text-center">
        <MailCheck aria-hidden className="mx-auto size-8 text-primary-500" />
        <h1 className="mt-3 text-xl font-semibold text-ink">Check your email</h1>
        <p className="mt-2 text-sm text-slate">
          We sent you a one-time sign-in link. It expires shortly, so open it soon. You can close this
          tab.
        </p>
      </Card>
    </div>
  );
}
