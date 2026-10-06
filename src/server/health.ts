import type { RawField } from "./browse";
import type { SandboxOutput } from "./sandbox";
import type { Field } from "./spec";

// Drift is any sign that the selectors no longer point at what they were
// compiled to point at. Every kind here is a reason to heal; none of them is
// ever allowed to look like "condition not met".
export type ProblemKind =
	| "missing" // a required selector matched nothing
	| "selector-error" // the selector no longer parses or evaluates
	| "unparseable" // matched, but the text no longer coerces to the type
	| "anchor-lost"; // matched, but the label next to it is gone: wrong element

export type Problem = { field: string; kind: ProblemKind; detail: string };

export function assess(fields: Field[], raw: Record<string, RawField>, out: SandboxOutput): Problem[] {
	const problems: Problem[] = [];
	for (const f of fields) {
		const r = raw[f.name];
		const required = f.required !== false;
		if (!r) {
			problems.push({ field: f.name, kind: "missing", detail: "not extracted" });
			continue;
		}
		if (r.error) {
			problems.push({ field: f.name, kind: "selector-error", detail: r.error });
			continue;
		}
		// exists fields are allowed to match nothing: that is their value.
		if (f.type !== "exists" && r.count === 0) {
			if (required) problems.push({ field: f.name, kind: "missing", detail: `${f.selector} matched nothing` });
			continue;
		}
		if (f.anchor && r.count > 0) {
			const ctx = r.items[0].context.toLowerCase();
			if (!ctx.includes(f.anchor.toLowerCase())) {
				problems.push({
					field: f.name,
					kind: "anchor-lost",
					detail: `expected "${f.anchor}" near the value; found "${r.items[0].context.slice(0, 120)}"`,
				});
				continue;
			}
		}
		if (required && out.errors[f.name] !== undefined) {
			problems.push({ field: f.name, kind: "unparseable", detail: out.errors[f.name] });
		}
	}
	return problems;
}

// A healed selector must find a value that could plausibly be the same
// thing. This is what stops a heal from "fixing" a price field by pointing
// it at the shipping cost, or a launch date at the page's copyright year.
export function implausible(
	f: Field,
	value: unknown,
	lastGood: unknown,
	now: string,
): string | null {
	if (value === null || value === undefined) return "no value";
	if (lastGood === null || lastGood === undefined || f.all) return null;
	if (f.type === "number" && typeof value === "number" && typeof lastGood === "number") {
		if (lastGood !== 0) {
			const ratio = value / lastGood;
			if (!(ratio >= 0.1 && ratio <= 10)) return `${value} is not within 10x of last good ${lastGood}`;
		}
		return null;
	}
	if (f.type === "date" && typeof value === "string") {
		const years = Math.abs(Date.parse(value) - Date.parse(now)) / (365.25 * 86_400_000);
		if (!(years <= 5)) return `${value} is more than 5 years from now`;
		return null;
	}
	if (f.type === "text" && typeof value === "string" && value.length === 0) return "empty text";
	return null;
}
