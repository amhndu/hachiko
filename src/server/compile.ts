import type { JsonObject } from "./json";
import { createAI } from "agents/models/ai-sdk";
import { generateText, Output } from "ai";
import { z } from "zod";
import { renderOutline, type Outline } from "./browse";
import type { Problem } from "./health";
import { LIMITS } from "./limits";
import { FieldSchema, WatchSpecSchema, type Field, type WatchSpec } from "./spec";

// The offline env (CLOUDFLARE_ENV=offline) has no AI binding; say so plainly.
export function workersAI(env: Env): Ai {
	if (!env.AI) throw new Error("Workers AI is not bound (offline mode); chat, compile and heal need it");
	return env.AI;
}

export function compilerModel(env: Env) {
	return createAI({ binding: workersAI(env) }).languageModel(env.COMPILER_MODEL);
}

const SPEC_RULES = `
A watch spec is JSON. Everything in it is data; nothing is executed.
- url: the page.
- waitFor (optional): CSS selector to wait for before reading, for pages that render late.
- fields (1-${LIMITS.maxFields}): values read off the page. Each has
  name (identifier), description (what it means, in words),
  selector (CSS, or "xpath:<expr>"), type (text | number | date | exists),
  and optionally:
  attr (read an attribute, eg "content" for meta tags),
  after / before (literal text markers: keep only what follows "after" and precedes "before",
    eg after "Launch Date:" on "Launch Date: 12-10-2026 (tentative)" with before "("),
  dateOrder (dmy | mdy | ymd, for numeric dates like 05/10/2026),
  all (collect every match as a list), required (default true),
  anchor (short, stable label text that appears next to the value, eg "Launch Date").
  Numbers read the first number in the text ("In stock (22 available)" -> 22, "Rs. 45,000" -> 45000).
  Dates read the first date in the text and become YYYY-MM-DD. exists is true when the selector matches.
- condition: { mode: "all" | "any", clauses: [ ...1-${LIMITS.maxConditionClauses} ] }.
  A clause is { left, op, right }. Operands:
    { kind: "field", name, agg? }   the field's value now
    { kind: "prev", name, agg? }    its value on the last good run (null on the first run)
    { kind: "value", value }        a literal number, string or boolean ("2026-10-12" is a date)
    { kind: "today", offsetDays? }  today's date (UTC), optionally shifted
  agg (first | min | max | count) turns a list field (all: true) into one value.
  Ops: lt lte gt gte (two numbers or two dates), eq ne (same type),
  contains not_contains (text field vs a text value, case-insensitive),
  and the one-operand ops changed (the field differs from the last good run; false on the
  first run), exists, missing (no right operand).
  Examples:
    price under 300:  { mode: "all", clauses: [{ left: { kind: "field", name: "price" }, op: "lt", right: { kind: "value", value: 300 } }] }
    date changed and still in the future:  { mode: "all", clauses: [
      { left: { kind: "field", name: "launchDate" }, op: "changed" },
      { left: { kind: "field", name: "launchDate" }, op: "gt", right: { kind: "today" } } ] }
- summary: one human sentence with placeholders {field}, {prev.field} and {today},
  eg "Price is {price} (target under 300)" or "Launch date is {launchDate} (was {prev.launchDate})".
- notifyOn: "transition" (notify when the condition goes false -> true; the default) or
  "every-match" (notify on every run where it holds).

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
// the condition, or the URL: those are the user's intent, and a heal that
// changed them would be silently answering a different question.
const HealPatch = z.object({
	fields: z.array(
		FieldSchema.pick({
			name: true,
			selector: true,
			attr: true,
			after: true,
			before: true,
			anchor: true,
			dateOrder: true,
		}),
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
			after: p.after,
			before: p.before,
			anchor: p.anchor,
			dateOrder: p.dateOrder ?? f.dateOrder,
		};
	});
	return { fields, note: output.note };
}
