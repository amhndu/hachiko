import type { JsonObject } from "./json";
import { extract, outline, withPage, type Outline, type RawField } from "./browse";
import { compileSpec, proposeHeal } from "./compile";
import type { ConditionCtx } from "./condition";
import { evaluate, type Evaluation } from "./evaluate";
import { implausible, type EvalOutput, type Problem } from "./health";
import { LIMITS } from "./limits";
import { SpecError, validateSpec, type WatchSpec } from "./spec";

// The check pipeline (everything with I/O), shared by the scheduled workflow and the interactive
// dry run. Each function is one durable step's worth of work.

export async function observe(env: Env, spec: WatchSpec): Promise<Record<string, RawField>> {
	return withPage(env, spec.url, spec.waitFor, (page) => extract(page, spec.fields));
}

export async function dryRun(env: Env, spec: WatchSpec, ctx: ConditionCtx): Promise<Evaluation> {
	return evaluate(spec, await observe(env, spec), ctx);
}

export function describeProblems(e: Evaluation): string[] {
	return e.problems.map((p) => `${p.field}: ${p.kind}: ${p.detail}`);
}

export type HealResult =
	| { healed: true; spec: WatchSpec; evaluation: Evaluation; note: string; attempts: number }
	| { healed: false; reasons: string[]; attempts: number };

// One browser session; up to maxHealAttemptsPerRun proposals. A proposal is
// accepted only if, on the live page, every field reads, every anchor holds,
// every value coerces, and every healed value is plausible next to the last
// good one. Anything less is a failed heal, and a failed heal is loud.
export async function heal(
	env: Env,
	args: {
		intent: string;
		spec: WatchSpec;
		problems: Problem[];
		lastGood: JsonObject | null;
		ctx: ConditionCtx;
	},
): Promise<HealResult> {
	return withPage(env, args.spec.url, args.spec.waitFor, async (page) => {
		const view = await outline(page);
		const rejected: string[] = [];
		let problems = args.problems;
		for (let attempt = 1; attempt <= LIMITS.maxHealAttemptsPerRun; attempt++) {
			const proposal = await proposeHeal(env, {
				intent: args.intent,
				spec: args.spec,
				problems,
				lastGood: args.lastGood,
				outline: view,
				rejected,
			});
			let candidate: WatchSpec;
			try {
				candidate = validateSpec({ ...args.spec, fields: proposal.fields });
			} catch (e) {
				rejected.push(`${JSON.stringify(proposal.fields)} -> ${(e as Error).message}`);
				continue;
			}
			const raw = await extract(page, candidate.fields);
			const evaluation = evaluate(candidate, raw, args.ctx);
			const reasons = describeProblems(evaluation);
			const healedNames = new Set(args.problems.map((p) => p.field));
			for (const f of candidate.fields) {
				if (!healedNames.has(f.name)) continue;
				const why = implausible(f, evaluation.out.values[f.name], args.lastGood?.[f.name], args.ctx.now);
				if (why) reasons.push(`${f.name}: implausible: ${why}`);
			}
			if (reasons.length === 0) {
				return { healed: true, spec: candidate, evaluation, note: proposal.note, attempts: attempt };
			}
			const moved = candidate.fields.filter((f) => healedNames.has(f.name)).map((f) => `${f.name}=${f.selector}`);
			rejected.push(`${moved.join(", ")} -> ${reasons.join("; ")}`);
			problems = evaluation.problems.length > 0 ? evaluation.problems : problems;
		}
		return { healed: false, reasons: rejected, attempts: LIMITS.maxHealAttemptsPerRun };
	});
}

export type Draft = {
	name: string;
	explanation: string;
	spec: WatchSpec;
	preview: { values: JsonObject; result: EvalOutput["result"]; problems: string[] };
};

// Intent -> spec -> dry run against the live page; one retry with the dry
// run's problems fed back. A draft that still fails is returned with its
// problems so the orchestrator can tell the user rather than save it.
export async function draftWatch(
	env: Env,
	args: { url: string; intent: string; hint?: string; now: string },
): Promise<Draft> {
	const view: Outline = await withPage(env, args.url, undefined, (page) => outline(page));
	const ctx: ConditionCtx = { now: args.now, prev: null };
	let previous: { spec: WatchSpec; problems: string[]; values: JsonObject } | undefined;
	let last: Draft | undefined;
	for (let attempt = 0; attempt < 2; attempt++) {
		const compiled = await compileSpec(env, { ...args, outline: view, previous });
		let spec: WatchSpec;
		try {
			spec = validateSpec(compiled.spec);
		} catch (e) {
			const problems = e instanceof SpecError ? e.problems : [(e as Error).message];
			previous = { spec: compiled.spec, problems, values: {} };
			last = { ...compiled, preview: { values: {}, result: null, problems } };
			continue;
		}
		const evaluation = await dryRun(env, spec, ctx);
		const problems = describeProblems(evaluation);
		last = {
			name: compiled.name,
			explanation: compiled.explanation,
			spec,
			preview: { values: evaluation.out.values, result: evaluation.out.result, problems },
		};
		if (problems.length === 0) return last;
		previous = { spec, problems, values: evaluation.out.values };
	}
	return last as Draft;
}
