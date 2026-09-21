// app/not-found.tsx

import { CalendarX2 } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { ButtonLink } from "@/components/ui/Button";

export default function NotFound() {
  return (
    <div className="flex min-h-[60dvh] flex-col justify-center">
      <Card className="p-6 text-center">
        <CalendarX2 aria-hidden className="mx-auto size-8 text-slate" />
        <h1 className="mt-3 text-xl font-semibold text-ink">Not found</h1>
        <p className="mt-2 text-sm text-slate">
          That item does not exist, or it belongs to another account.
        </p>
        <div className="mt-4">
          <ButtonLink href="/" size="sm">
            Back to today
          </ButtonLink>
        </div>
      </Card>
    </div>
  );
}
