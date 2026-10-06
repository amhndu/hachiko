import type { RawField } from "../src/server/browse";
import type { PredicateCtx, SandboxOutput } from "../src/server/sandbox";
import { coerceAll } from "../src/server/sandboxed/coerce.js";
import type { WatchSpec } from "../src/server/spec";

// What the Dynamic Worker does, minus the isolation: coerce, then run the
// predicate unless a required field failed. Tests only.
export function fakeSandbox(spec: WatchSpec, raw: Record<string, RawField>, ctx: PredicateCtx): SandboxOutput {
	const { values, errors } = coerceAll(spec.fields, raw);
	const blocking = spec.fields.some((f) => f.required !== false && errors[f.name] !== undefined);
	if (blocking) return { values, errors, result: null, predicateError: null } as SandboxOutput;
	const predicate = new Function(`return (${spec.predicate});`)() as (v: unknown, c: unknown) => { match: boolean; summary: string };
	return { values, errors, result: predicate(values, ctx), predicateError: null } as SandboxOutput;
}
