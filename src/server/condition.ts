import { z } from "zod";
import type { Json, JsonObject } from "./json";
import { LIMITS } from "./limits";

// The condition language. A watch's condition is data, not code: a flat list
// of clauses joined by "all" or "any", each comparing two operands. It is
// checked against the field types when the spec is saved, and evaluated by
// the small interpreter below, which can only ever do O(clauses) work.
// Nothing model-written is executed anywhere.

const AggSchema = z.enum(["first", "min", "max", "count"]);
const NameSchema = z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,31}$/);

export const OperandSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("field"),
		name: NameSchema,
		agg: AggSchema.optional().describe("for list fields (all: true)"),
	}),
	z.object({
		kind: z.literal("prev"),
		name: NameSchema.describe("the field's value on the last good run; null on the first run"),
		agg: AggSchema.optional(),
	}),
	z.object({
		kind: z.literal("value"),
		value: z.union([z.number(), z.string().max(LIMITS.maxConditionStringLen), z.boolean()]),
	}),
	z.object({
		kind: z.literal("today"),
		offsetDays: z.number().int().min(-3650).max(3650).optional(),
	}),
]);

export const OpSchema = z.enum([
	"lt",
	"lte",
	"gt",
	"gte",
	"eq",
	"ne",
	"contains",
	"not_contains",
	"changed",
	"exists",
	"missing",
]);

export const ClauseSchema = z.object({
	left: OperandSchema,
	op: OpSchema,
	right: OperandSchema.optional().describe("required for every op except changed, exists, missing"),
});

export const ConditionSchema = z.object({
	mode: z.enum(["all", "any"]),
	clauses: z.array(ClauseSchema).min(1).max(LIMITS.maxConditionClauses),
});

export type Operand = z.infer<typeof OperandSchema>;
type Agg = z.infer<typeof AggSchema>;
export type Op = z.infer<typeof OpSchema>;
export type Clause = z.infer<typeof ClauseSchema>;
export type Condition = z.infer<typeof ConditionSchema>;

export type ConditionCtx = { now: string; prev: JsonObject | null };

type FieldType = "text" | "number" | "date" | "exists";
type FieldInfo = { name: string; type: FieldType; all?: boolean };
type ValueType = "text" | "number" | "date" | "boolean" | "list";

const UNARY_OPS: ReadonlySet<Op> = new Set<Op>(["changed", "exists", "missing"]);
const ORDER_OPS: ReadonlySet<Op> = new Set<Op>(["lt", "lte", "gt", "gte"]);
const TEXT_OPS: ReadonlySet<Op> = new Set<Op>(["contains", "not_contains"]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?Z?)?$/;

const OP_TEXT: Record<Op, string> = {
	lt: "<",
	lte: "<=",
	gt: ">",
	gte: ">=",
	eq: "=",
	ne: "!=",
	contains: "contains",
	not_contains: "does not contain",
	changed: "changed",
	exists: "exists",
	missing: "is missing",
};

function operandType(o: Operand, fields: Map<string, FieldInfo>): ValueType | string {
	if (o.kind === "today") return "date";
	if (o.kind === "value") {
		if (typeof o.value === "number") return "number";
		if (typeof o.value === "boolean") return "boolean";
		return ISO_DATE.test(o.value) ? "date" : "text";
	}
	const f = fields.get(o.name);
	if (!f) return `unknown field ${o.name}`;
	const base: ValueType = f.type === "exists" ? "boolean" : f.type;
	if (!f.all) return o.agg ? `${o.name} is not a list; agg is only for all-fields` : base;
	if (!o.agg) return "list";
	if (o.agg === "count") return "number";
	if ((o.agg === "min" || o.agg === "max") && base !== "number" && base !== "date") {
		return `${o.agg} needs a number or date list; ${o.name} is ${base}`;
	}
	return base;
}

const VALUE_TYPES: ReadonlySet<string> = new Set(["text", "number", "date", "boolean", "list"]);

// Every problem with a condition, as sentences the compiler model can act on.
export function checkCondition(c: Condition, fieldList: FieldInfo[]): string[] {
	const fields = new Map(fieldList.map((f) => [f.name, f]));
	const problems: string[] = [];
	for (const [i, clause] of c.clauses.entries()) {
		const at = `condition.clauses.${i}`;
		const left = operandType(clause.left, fields);
		if (!VALUE_TYPES.has(left)) {
			problems.push(`${at}.left: ${left}`);
			continue;
		}
		if (UNARY_OPS.has(clause.op)) {
			if (clause.right) problems.push(`${at}: ${clause.op} takes no right operand`);
			if (clause.left.kind !== "field") problems.push(`${at}: ${clause.op} needs a field on the left`);
			continue;
		}
		if (!clause.right) {
			problems.push(`${at}: ${clause.op} needs a right operand`);
			continue;
		}
		const right = operandType(clause.right, fields);
		if (!VALUE_TYPES.has(right)) {
			problems.push(`${at}.right: ${right}`);
			continue;
		}
		if (TEXT_OPS.has(clause.op)) {
			if ((left !== "text" && left !== "list") || right !== "text") {
				problems.push(`${at}: ${clause.op} compares text (or a text list) with a text value; got ${left} and ${right}`);
			}
			continue;
		}
		if (left === "list" || right === "list") {
			problems.push(`${at}: a list needs agg (first, min, max, count) before ${clause.op}`);
			continue;
		}
		if (ORDER_OPS.has(clause.op) && !((left === "number" && right === "number") || (left === "date" && right === "date"))) {
			problems.push(`${at}: ${clause.op} compares two numbers or two dates; got ${left} and ${right}`);
			continue;
		}
		if (left !== right) problems.push(`${at}: ${clause.op} compares ${left} with ${right}`);
	}
	return problems;
}

function aggregate(value: Json | undefined, agg: Agg | undefined): Json {
	if (value === undefined || value === null) return null;
	if (!Array.isArray(value) || agg === undefined) return value;
	if (agg === "count") return value.length;
	if (value.length === 0) return null;
	if (agg === "first") return value[0];
	const sorted = [...value].sort((a, b) => compare(a, b));
	return agg === "min" ? sorted[0] : sorted[sorted.length - 1];
}

function todayPlus(now: string, days: number): string {
	const d = new Date(Date.parse(now) + days * 86_400_000);
	return d.toISOString().slice(0, 10);
}

function resolve(o: Operand, values: JsonObject, ctx: ConditionCtx): Json {
	if (o.kind === "value") return o.value;
	if (o.kind === "today") return todayPlus(ctx.now, o.offsetDays ?? 0);
	if (o.kind === "field") return aggregate(values[o.name], o.agg);
	return aggregate(ctx.prev?.[o.name], o.agg);
}

// Dates are ISO strings: compared by instant, so "2026-10-12" and
// "2026-10-12T09:00:00Z" order correctly. Text is compared case-insensitively.
function compare(a: Json, b: Json): number {
	if (typeof a === "number" && typeof b === "number") return a - b;
	if (typeof a === "string" && typeof b === "string") {
		if (ISO_DATE.test(a) && ISO_DATE.test(b)) return Date.parse(a) - Date.parse(b);
		return a.toLowerCase().localeCompare(b.toLowerCase());
	}
	return String(a).localeCompare(String(b));
}

function same(a: Json, b: Json): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

function holds(clause: Clause, values: JsonObject, ctx: ConditionCtx): boolean {
	const left = resolve(clause.left, values, ctx);
	if (clause.op === "exists") return left !== null;
	if (clause.op === "missing") return left === null;
	if (clause.op === "changed") {
		// Needs a baseline run. A value appearing after an empty stretch
		// (null -> value) is a change; a value disappearing is not -- that is
		// what "missing" is for.
		if (!ctx.prev || clause.left.kind !== "field") return false;
		const before = aggregate(ctx.prev[clause.left.name], clause.left.agg);
		return left !== null && !same(left, before);
	}
	const right = clause.right ? resolve(clause.right, values, ctx) : null;
	// A missing value satisfies nothing: an optional field that is absent
	// makes its comparisons false, never true by accident.
	if (left === null || right === null) return false;
	switch (clause.op) {
		case "lt":
			return compare(left, right) < 0;
		case "lte":
			return compare(left, right) <= 0;
		case "gt":
			return compare(left, right) > 0;
		case "gte":
			return compare(left, right) >= 0;
		case "eq":
			return compare(left, right) === 0;
		case "ne":
			return compare(left, right) !== 0;
		case "contains":
		case "not_contains": {
			const needle = String(right).toLowerCase();
			const hay = Array.isArray(left) ? left.map((x) => String(x).toLowerCase()) : [String(left).toLowerCase()];
			const found = hay.some((h) => h.includes(needle));
			return clause.op === "contains" ? found : !found;
		}
	}
}

export function evaluateCondition(c: Condition, values: JsonObject, ctx: ConditionCtx): boolean {
	return c.mode === "all"
		? c.clauses.every((clause) => holds(clause, values, ctx))
		: c.clauses.some((clause) => holds(clause, values, ctx));
}

// "Price is {price} (was {prev.price}), checked {today}": placeholders only,
// no expressions. Unknown or missing values render as "n/a".
export function renderSummary(template: string, values: JsonObject, ctx: ConditionCtx): string {
	const text = template.replace(/\{(prev\.)?([a-zA-Z_][a-zA-Z0-9_]{0,31})\}/g, (_m, prev: string | undefined, name: string) => {
		if (!prev && name === "today") return todayPlus(ctx.now, 0);
		const v = prev ? ctx.prev?.[name] : values[name];
		if (v === undefined || v === null) return "n/a";
		return Array.isArray(v) ? v.join(", ") : String(v);
	});
	return text.slice(0, LIMITS.maxSummaryLen);
}

function describeOperand(o: Operand): string {
	if (o.kind === "value") return typeof o.value === "string" ? `"${o.value}"` : String(o.value);
	if (o.kind === "today") {
		const d = o.offsetDays ?? 0;
		return d === 0 ? "today" : `today ${d > 0 ? "+" : "-"} ${Math.abs(d)}d`;
	}
	const base = o.kind === "prev" ? `previous ${o.name}` : o.name;
	return o.agg ? `${o.agg}(${base})` : base;
}

// One readable line, eg "price < 300 and launchDate changed".
export function describeCondition(c: Condition): string {
	const parts = c.clauses.map((clause) =>
		clause.right
			? `${describeOperand(clause.left)} ${OP_TEXT[clause.op]} ${describeOperand(clause.right)}`
			: `${describeOperand(clause.left)} ${OP_TEXT[clause.op]}`,
	);
	return parts.join(c.mode === "all" ? " and " : " or ");
}
