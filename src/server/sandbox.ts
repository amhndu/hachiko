import type { JsonObject } from "./json";
import { z } from "zod";
import { LIMITS } from "./limits";
import COERCE_SRC from "./sandboxed/coerce.js?raw";
import type { RawField } from "./browse";
import type { Field } from "./spec";

// The sandbox: everything model-written that is code (the predicate) or
// code-like (regex patterns) runs in a fresh Dynamic Worker with
//   - globalOutbound: null  -> fetch() and connect() throw
//   - env: {}               -> no bindings, no secrets
//   - cpuMs / subRequests   -> hard caps enforced by the runtime
//   - a wall-clock race     -> a predicate that never settles is cut off
// Input is size-capped going in and the output is schema-checked coming out.

export type PredicateCtx = {
	now: string;
	prev: JsonObject | null;
	lastMatch: boolean | null;
	url: string;
};

export type SandboxInput = {
	fields: Field[];
	raw: Record<string, RawField>;
	ctx: PredicateCtx;
};

const ResultSchema = z.object({
	match: z.boolean(),
	summary: z.string().max(LIMITS.maxSummaryLen * 4),
});

export type SandboxOutput = {
	values: JsonObject;
	errors: Record<string, string>;
	result: { match: boolean; summary: string } | null;
	predicateError: string | null;
};

export class SandboxError extends Error {
	constructor(
		readonly kind: "limit" | "input" | "output",
		message: string,
	) {
		super(message);
		this.name = "SandboxError";
	}
}

const MAIN_SRC = `
import { coerceAll } from "./coerce.js";
import predicate from "./predicate.js";

export default {
	async fetch(request) {
		const { fields, raw, ctx } = await request.json();
		const { values, errors } = coerceAll(fields, raw);
		const blocking = fields.some((f) => f.required !== false && errors[f.name] !== undefined);
		let result = null;
		let predicateError = null;
		if (!blocking) {
			try {
				result = await predicate(Object.freeze(values), Object.freeze(ctx));
			} catch (e) {
				predicateError = String((e && e.message) || e);
			}
		}
		return Response.json({ values, errors, result, predicateError });
	},
};
`;

async function sha256(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function runSandbox(
	env: Env,
	predicate: string,
	input: SandboxInput,
): Promise<SandboxOutput> {
	const body = JSON.stringify(input);
	if (body.length > LIMITS.maxSandboxInputBytes) {
		throw new SandboxError("input", `sandbox input is ${body.length} bytes; cap is ${LIMITS.maxSandboxInputBytes}`);
	}

	// Same predicate source -> same id -> the runtime may reuse a warm isolate.
	const id = `predicate:${await sha256(predicate)}`;
	const worker = env.LOADER.get(id, async () => ({
		compatibilityDate: "2026-10-05",
		mainModule: "main.js",
		modules: {
			"main.js": MAIN_SRC,
			"coerce.js": COERCE_SRC,
			"predicate.js": `export default (${predicate});\n`,
		},
		env: {},
		globalOutbound: null,
		limits: { cpuMs: LIMITS.sandboxCpuMs, subRequests: 0 },
	}));

	let timer: ReturnType<typeof setTimeout> | undefined;
	const wall = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new SandboxError("limit", `sandbox exceeded ${LIMITS.sandboxWallMs}ms wall time`)),
			LIMITS.sandboxWallMs,
		);
	});

	let response: Response;
	try {
		response = await Promise.race([
			worker.getEntrypoint().fetch("https://sandbox.invalid/", { method: "POST", body }),
			wall,
		]);
	} catch (e) {
		if (e instanceof SandboxError) throw e;
		throw new SandboxError("limit", `sandbox aborted: ${(e as Error).message}`);
	} finally {
		clearTimeout(timer);
	}
	if (!response.ok) {
		throw new SandboxError("limit", `sandbox failed: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
	}

	const out = (await response.json()) as SandboxOutput;
	if (out.result !== null) {
		const checked = ResultSchema.safeParse(out.result);
		if (!checked.success) {
			return {
				...out,
				result: null,
				predicateError: "predicate must return { match: boolean, summary: string }",
			};
		}
		out.result = {
			match: checked.data.match,
			summary: checked.data.summary.slice(0, LIMITS.maxSummaryLen),
		};
	}
	return out;
}
