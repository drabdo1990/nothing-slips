// scripts/tick.ts
//
// Run the scheduler from a terminal: `npm run tick`.
// Useful in development (no cron locally) and as a break-glass way to drain the queue. It exercises
// exactly the same code path as /api/cron/tick.

import { runTick } from "../src/lib/reminders/scheduler";

async function main() {
  const started = Date.now();
  const result = await runTick({ origin: process.env.AUTH_URL ?? "http://localhost:3000" });

  console.log("Tick complete in", Date.now() - started, "ms");
  console.table(result);

  if (result.errors.length > 0) {
    console.error("Errors:");
    for (const error of result.errors) console.error(" -", error);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
