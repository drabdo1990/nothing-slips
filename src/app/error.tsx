// app/error.tsx
"use client";

import { useEffect } from "react";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";

/**
 * Friendly, actionable, and deliberately vague about internals: the error boundary logs the digest
 * (which maps to a server log line) but never renders calendar contents or a stack trace.
 */
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The digest is the join key to the server log. No payload, no user data.
    console.error("App error", { digest: error.digest });
  }, [error.digest]);

  return (
    <div className="flex min-h-[60dvh] flex-col justify-center">
      <Card className="p-6 text-center">
        <TriangleAlert aria-hidden className="mx-auto size-8 text-danger-500" />
        <h1 className="mt-3 text-xl font-semibold text-ink">Something went wrong</h1>
        <p className="mt-2 text-sm text-slate">
          Your schedule is safe — nothing was lost. This was a problem showing the page.
        </p>
        {error.digest ? (
          <p className="mt-2 text-xs text-slate tabular">
            Reference: <code>{error.digest}</code>
          </p>
        ) : null}
        <div className="mt-4 flex justify-center gap-2">
          <Button onClick={reset}>Try again</Button>
          <Button variant="secondary" onClick={() => window.location.assign("/")}>
            Go to today
          </Button>
        </div>
        <p className="mt-4 border-t border-mist pt-3 text-xs text-slate">
          Alarms are delivered by the server and are unaffected by this error.
        </p>
      </Card>
    </div>
  );
}
