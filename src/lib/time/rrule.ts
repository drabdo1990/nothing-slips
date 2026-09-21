// src/lib/time/rrule.ts
//
// Interop shim for `rrule`. This exists because of a real, hard-to-see packaging problem:
//
//   rrule declares `module: dist/esm/index.js` and `main: dist/es5/rrule.js`, but has NO `exports`
//   map. Bundlers therefore prefer `module` and see the ESM named exports. Node's native ESM
//   resolver ignores `module` and loads `main`, a CJS bundle whose named exports
//   `cjs-module-lexer` cannot detect — so `import { rrulestr } from "rrule"` works under
//   `next build` and vitest, and throws
//       SyntaxError: The requested module 'rrule' does not provide an export named 'rrulestr'
//   under `tsx scripts/tick.ts` or `tsx prisma/seed.ts`.
//
// Resolving the binding once here means every caller works in both worlds, and the explanation
// lives in a single place instead of being rediscovered as a mystery.

import * as rruleNamespace from "rrule";

type RrulestrFn = typeof import("rrule").rrulestr;
type RRuleCtor = typeof import("rrule").RRule;
type RRuleSetCtor = typeof import("rrule").RRuleSet;

interface ResolvedRruleModule {
  rrulestr: RrulestrFn;
  RRule: RRuleCtor;
  RRuleSet: RRuleSetCtor;
}

/** Bundler path: named exports sit on the namespace. Node path: everything sits under `default`. */
const namespace = rruleNamespace as unknown as Partial<ResolvedRruleModule>;
const cjsDefault = (rruleNamespace as unknown as { default?: ResolvedRruleModule }).default;

function resolve<K extends keyof ResolvedRruleModule>(key: K): ResolvedRruleModule[K] {
  const value = namespace[key] ?? cjsDefault?.[key];
  if (!value) {
    throw new Error(
      `rrule.${String(key)} could not be resolved. The rrule package layout changed; see src/lib/time/rrule.ts.`,
    );
  }
  return value;
}

export const rrulestr: RrulestrFn = resolve("rrulestr");
export const RRule: RRuleCtor = resolve("RRule");
export const RRuleSet: RRuleSetCtor = resolve("RRuleSet");
