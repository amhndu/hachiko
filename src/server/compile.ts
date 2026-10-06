import type { JsonObject } from "./json";
import { createAI } from "agents/models/ai-sdk";
import { generateText, Output } from "ai";
import { z } from "zod";
import { renderOutline, type Outline } from "./browse";
import type { Problem } from "./health";
import { LIMITS } from "./limits";
import { FieldSchema, WatchSpecSchema, type Field, type WatchSpec } from "./spec";

export function compilerModel(env: Env) {
	return createAI({ binding: env.AI }).languageModel(env.COMPILER_MODEL);
}

const SPEC_RULES = `
A watch spec is JSON:
- url: the page.
- waitFor (optional): CSS selector to wait for before reading, for pages that render late.
- fields (1-${LIMITS.maxFields}): values read off the page. Each has
  name (identifier), description (what it means, in words),
  selector (CSS, or "xpath:<expr>"), type (text | number | date | exists),
  and optionally attr (read an attribute, eg "content" for meta tags),
  pattern (regex; first capture group is kept), dateOrder (dmy | mdy | ymd, for numeric dates),
  all (collect every match as a list), required (default true),
  anchor (short, stable label text that appears next to the value, eg "Launch Date").
- predicate: a JS arrow function (v, ctx) => ({ match: boolean, summary: string }).
  v holds the coerced field values: numbers are numbers, dates are ISO strings
  (YYYY-MM-DD, comparable as strings), exists is a boolean, all-fields are arrays.
  ctx = { now (ISO timestamp), prev (last good v, or null on the first run), lastMatch, url }.
  The predicate must be pure: no fetch, no timers, no Date.now(), no new Date() without
  arguments, no Math.random. Use ctx.now for the current time. Keep it short.
  summary is one human sentence stating the observed values, eg "Price is $42 (target < $50)".
  For "when X changes" conditions compare against ctx.prev and return match:false when prev is null.
- notifyOn: "transition" (notify when match goes false -> true; the default) or
  "every-match" (notify on every run that matches).

Selector rules:
- Prefer selectors from the outline; they were checked unique on the live page.
- Prefer stable hooks (ids, itemprop, data-testid, meta tags) over deep positional paths.
- Set anchor whenever a label sits next to the value: it is how drift is detected.
- Read the value, not its label: the selector should point at the element holding the value.
`.trim();

const CompileOutput = z.object({
	name: z.string().min(1).max(60).describe("short name for the watch, eg 'Sony XM6 under $300'"),
	spec: WatchSpecSchema,
	explanation: z.string().max(400).describe("one or two sentences on what the watch reads and when it fires"),
});
export type CompileOutput = z.infer<typeof CompileOutput>;

export async function compileSpec(
	env: Env,
	args: {
		url: string;
		intent: string;
		outline: Outline;
		hint?: string;
		previous?: { spec: WatchSpec; problems: string[]; values: JsonObject };
	},
): Promise<CompileOutput> {
	const parts = [
		`User intent: ${args.intent}`,
		`URL: ${args.url}`,
		args.hint ? `The user pointed at this element on the page: ${args.hint}` : "",
		args.previous
			? [
					"Your previous attempt failed its dry run against the live page:",
					JSON.stringify(args.previous.spec, null, 1),
					`Problems: ${args.previous.problems.join("; ")}`,
					`Values it read: ${JSON.stringify(args.previous.values)}`,
					"Fix it.",
				].join("\n")
			: "",
		"Page outline (selector | text), one element per line:",
		renderOutline(args.outline),
	];
	const { output } = await generateText({
		model: compilerModel(env),
		system: `You compile a user's request to watch a web page into a deterministic watch spec.\n\n${SPEC_RULES}`,
		prompt: parts.filter(Boolean).join("\n\n"),
		output: Output.object({ schema: CompileOutput }),
	});
	return { ...output, spec: { ...output.spec, url: args.url } };
}

// The healer may move selectors. It may not touch names, types, descriptions,
// the predicate, or the URL: those are the user's intent, and a heal that
// changed them would be silently answering a different question.
const HealPatch = z.object({
	fields: z.array(
		FieldSchema.pick({ name: true, selector: true, attr: true, pattern: true, anchor: true, dateOrder: true }),
	),
	note: z.string().max(300).describe("what moved on the page, in one sentence"),
});

export async function proposeHeal(
	env: Env,
	args: {
		intent: string;
		spec: WatchSpec;
		problems: Problem[];
		lastGood: JsonObject | null;
		outline: Outline;
		rejected: string[];
	},
): Promise<{ fields: Field[]; note: string }> {
	const broken = new Set(args.problems.map((p) => p.field));
	const prompt = [
		`The watch's purpose: ${args.intent}`,
		"Current spec:",
		JSON.stringify(args.spec, null, 1),
		"Fields that no longer read correctly:",
		...args.problems.map((p) => `- ${p.field}: ${p.kind}: ${p.detail}`),
		`Last good values: ${JSON.stringify(args.lastGood)}`,
		args.rejected.length ? `Already tried and rejected:\n${args.rejected.join("\n")}` : "",
		"Page outline now (selector | text):",
		renderOutline(args.outline),
		`Return replacement selectors for: ${[...broken].join(", ")}. Keep each field's meaning; if the value genuinely no longer exists on the page, return the old selector unchanged.`,
	];
	const { output } = await generateText({
		model: compilerModel(env),
		system: `You repair watch specs after a website changed its markup. You only move selectors.\n\n${SPEC_RULES}`,
		prompt: prompt.filter(Boolean).join("\n\n"),
		output: Output.object({ schema: HealPatch }),
	});
	const patch = new Map(output.fields.map((f) => [f.name, f]));
	const fields = args.spec.fields.map((f) => {
		const p = patch.get(f.name);
		if (!p || !broken.has(f.name)) return f;
		return {
			...f,
			selector: p.selector,
			attr: p.attr,
			pattern: p.pattern,
			anchor: p.anchor,
			dateOrder: p.dateOrder ?? f.dateOrder,
		};
	});
	return { fields, note: output.note };
}
