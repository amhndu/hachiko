import { parseCronExpression } from "cron-schedule";
import { z } from "zod";
import { LIMITS } from "./limits";
import { checkPredicate } from "./predicate-check";

// A field is one value read off the page. Selectors are CSS by default, or
// XPath when prefixed with "xpath:".
export const FieldSchema = z.object({
	name: z
		.string()
		.regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,31}$/)
		.describe("identifier the predicate reads, eg price"),
	description: z
		.string()
		.min(1)
		.max(200)
		.describe("what this value means, in words; the healer re-finds it from this"),
	selector: z
		.string()
		.min(1)
		.max(LIMITS.maxSelectorLen)
		.describe('CSS selector, or "xpath:<expr>"'),
	attr: z
		.string()
		.max(40)
		.optional()
		.describe("read this attribute instead of the text, eg content, href, value"),
	type: z.enum(["text", "number", "date", "exists"]),
	pattern: z
		.string()
		.max(LIMITS.maxPatternLen)
		.optional()
		.describe("regex applied to the raw text before coercion; first capture group wins"),
	dateOrder: z
		.enum(["dmy", "mdy", "ymd"])
		.optional()
		.describe("for numeric dates like 05/10/2026"),
	all: z.boolean().optional().describe("collect every match as a list instead of the first"),
	required: z
		.boolean()
		.optional()
		.describe("default true; a missing required field is drift"),
	anchor: z
		.string()
		.max(LIMITS.maxAnchorLen)
		.optional()
		.describe("stable label text that sits next to the value, eg 'Launch Date'"),
});

export const WatchSpecSchema = z.object({
	url: z.url(),
	waitFor: z.string().max(LIMITS.maxSelectorLen).optional(),
	fields: z.array(FieldSchema).min(1).max(LIMITS.maxFields),
	predicate: z
		.string()
		.min(1)
		.max(LIMITS.maxPredicateLen)
		.describe("JS arrow function (v, ctx) => ({ match, summary })"),
	notifyOn: z.enum(["transition", "every-match"]),
});

export type Field = z.infer<typeof FieldSchema>;
export type WatchSpec = z.infer<typeof WatchSpecSchema>;

export class SpecError extends Error {
	constructor(readonly problems: string[]) {
		super(problems.join("; "));
		this.name = "SpecError";
	}
}

// Everything that can be checked without a browser. The dry run checks the
// rest (selectors that do not parse, values that do not coerce).
export function validateSpec(input: unknown): WatchSpec {
	const parsed = WatchSpecSchema.safeParse(input);
	if (!parsed.success) {
		throw new SpecError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
	}
	const spec = parsed.data;
	const problems: string[] = [];

	const urlProblem = checkUrl(spec.url);
	if (urlProblem) problems.push(urlProblem);

	const names = new Set<string>();
	for (const f of spec.fields) {
		if (names.has(f.name)) problems.push(`fields: duplicate name ${f.name}`);
		names.add(f.name);
		if (f.pattern !== undefined) {
			try {
				new RegExp(f.pattern);
			} catch (e) {
				problems.push(`fields.${f.name}.pattern: ${(e as Error).message}`);
			}
		}
		if (f.type === "exists" && f.all) problems.push(`fields.${f.name}: exists cannot be all`);
	}

	problems.push(...checkPredicate(spec.predicate));
	if (problems.length > 0) throw new SpecError(problems);
	return spec;
}

// http(s) only, and no hosts that name the inside of a network. The browser
// runs on Cloudflare, so this is about intent, not reachability.
export function checkUrl(raw: string): string | null {
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		return "url: not a URL";
	}
	if (u.protocol !== "https:" && u.protocol !== "http:") return "url: http(s) only";
	if (u.username || u.password) return "url: no credentials in URLs";
	const host = u.hostname.toLowerCase();
	if (
		host === "localhost" ||
		host.endsWith(".localhost") ||
		host.endsWith(".internal") ||
		host.endsWith(".local") ||
		/^127\./.test(host) ||
		/^10\./.test(host) ||
		/^192\.168\./.test(host) ||
		/^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
		/^169\.254\./.test(host) ||
		host === "0.0.0.0" ||
		host.startsWith("[")
	) {
		return "url: private and loopback hosts are not watchable";
	}
	return null;
}

// Cron is UTC. Rejects anything that would fire more often than the floor,
// measured over the next 50 fires so "*/5 9 * * *" is caught too.
export function checkCron(cron: string, from: Date = new Date()): string | null {
	let parsed;
	try {
		parsed = parseCronExpression(cron);
	} catch (e) {
		return `cron: ${(e as Error).message}`;
	}
	const dates = parsed.getNextDates(50, from);
	for (let i = 1; i < dates.length; i++) {
		const gap = (dates[i].getTime() - dates[i - 1].getTime()) / 60_000;
		if (gap < LIMITS.minIntervalMinutes) {
			return `cron: fires every ${gap} min; the floor is ${LIMITS.minIntervalMinutes}`;
		}
	}
	return null;
}
