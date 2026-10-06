import type { RawField } from "./browse";
import { coerceAll } from "./coerce";
import { evaluateCondition, renderSummary, type ConditionCtx } from "./condition";
import { assess, type EvalOutput, type Problem } from "./health";
import type { WatchSpec } from "./spec";

export type Evaluation = {
	raw: Record<string, RawField>;
	out: EvalOutput;
	problems: Problem[];
};

// Coerce, then evaluate the condition -- unless a required field failed, in
// which case there is no result at all and assess() names the drift. Pure and
// synchronous: the same raw text and ctx always give the same answer.
export function evaluate(spec: WatchSpec, raw: Record<string, RawField>, ctx: ConditionCtx): Evaluation {
	const { values, errors } = coerceAll(spec.fields, raw);
	const blocking = spec.fields.some((f) => f.required !== false && errors[f.name] !== undefined);
	const result = blocking
		? null
		: { match: evaluateCondition(spec.condition, values, ctx), summary: renderSummary(spec.summary, values, ctx) };
	const out: EvalOutput = { values, errors, result };
	return { raw, out, problems: assess(spec.fields, raw, out) };
}
