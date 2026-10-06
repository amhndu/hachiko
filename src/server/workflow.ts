import { AgentWorkflow, type AgentWorkflowEvent, type AgentWorkflowStep } from "agents/workflows";
import type { Hachiko } from "./agent";
import { describeProblems, evaluate, heal, observe, type Evaluation, type HealResult } from "./check";
import type { RawField } from "./browse";
import type { JsonObject } from "./json";
import type { PredicateCtx } from "./sandbox";
import type { WatchSpec } from "./spec";

export type CheckParams = {
	watchId: string;
	version: number;
	intent: string;
	spec: WatchSpec;
	prev: JsonObject | null;
	lastMatch: boolean | null;
	healBudget: number;
};

export type RunOutcome = "ok" | "healed" | "broken" | "error";

export type RunReport = {
	watchId: string;
	version: number;
	instanceId: string;
	startedAt: string;
	finishedAt: string;
	outcome: RunOutcome;
	values: JsonObject | null;
	match: boolean | null;
	summary: string | null;
	problems: string[];
	healedSpec: WatchSpec | null;
	healNote: string | null;
};

// Step results are structured-cloned. Ours are JSON by construction, but too
// recursive for the Serializable<T> check, so steps are typed at the call site.
function durable<T>(fn: () => Promise<T>): () => Promise<never> {
	return fn as () => Promise<never>;
}

// One scheduled check: observe -> evaluate -> (heal) -> record. Each stage is
// a durable step, so a browser hiccup retries the observation without
// re-running anything before it, and a crash after a heal does not heal twice.
export class CheckWorkflow extends AgentWorkflow<Hachiko, CheckParams> {
	async run(event: AgentWorkflowEvent<CheckParams>, step: AgentWorkflowStep) {
		const p = event.payload;
		const startedAt = await step.do("clock", async () => new Date().toISOString());
		const ctx: PredicateCtx = { now: startedAt, prev: p.prev, lastMatch: p.lastMatch, url: p.spec.url };
		const base = {
			watchId: p.watchId,
			version: p.version,
			instanceId: event.instanceId,
			startedAt,
			values: null,
			match: null,
			summary: null,
			problems: [] as string[],
			healedSpec: null,
			healNote: null,
		};

		let report: Omit<RunReport, "finishedAt">;
		try {
			const raw = (await step.do<never>(
				"observe",
				{ retries: { limit: 2, delay: "15 seconds", backoff: "exponential" }, timeout: "2 minutes" },
				durable(() => observe(this.env, p.spec)),
			)) as Record<string, RawField>;
			const ev = (await step.do<never>(
				"evaluate",
				{ retries: { limit: 1, delay: "2 seconds" } },
				durable(() => evaluate(this.env, p.spec, raw, ctx)),
			)) as Evaluation;

			if (ev.problems.length === 0 && !ev.out.predicateError && ev.out.result) {
				report = {
					...base,
					outcome: "ok",
					values: ev.out.values,
					match: ev.out.result.match,
					summary: ev.out.result.summary,
				};
			} else if (ev.problems.length === 0) {
				// Selectors read fine but the predicate failed: that is a bug in
				// the user's condition, which healing must not paper over.
				report = { ...base, outcome: "broken", values: ev.out.values, problems: describeProblems(ev) };
			} else if (p.healBudget <= 0) {
				report = {
					...base,
					outcome: "broken",
					values: ev.out.values,
					problems: [...describeProblems(ev), "heal budget for today is spent"],
				};
			} else {
				const healed = (await step.do<never>(
					"heal",
					{ retries: { limit: 1, delay: "30 seconds" }, timeout: "5 minutes" },
					durable(() => heal(this.env, { intent: p.intent, spec: p.spec, problems: ev.problems, lastGood: p.prev, ctx })),
				)) as HealResult;
				if (healed.healed && healed.evaluation.out.result) {
					report = {
						...base,
						outcome: "healed",
						values: healed.evaluation.out.values,
						match: healed.evaluation.out.result.match,
						summary: healed.evaluation.out.result.summary,
						problems: describeProblems(ev),
						healedSpec: healed.spec,
						healNote: healed.note,
					};
				} else {
					report = {
						...base,
						outcome: "broken",
						values: ev.out.values,
						problems: [...describeProblems(ev), ...(healed.healed ? [] : healed.reasons.map((r) => `heal rejected: ${r}`))],
					};
				}
			}
		} catch (e) {
			report = { ...base, outcome: "error", problems: [(e as Error).message] };
		}

		await step.do("record", async () => {
			await this.agent.recordRun({ ...report, finishedAt: new Date().toISOString() });
		});
		return report.outcome;
	}
}
