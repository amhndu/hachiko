import { describe, expect, it } from "vitest";
import {
	checkCondition,
	describeCondition,
	evaluateCondition,
	renderSummary,
	type Condition,
	type ConditionCtx,
} from "../src/server/condition";
import type { JsonObject } from "../src/server/json";

const fields = [
	{ name: "price", type: "number" as const },
	{ name: "launchDate", type: "date" as const },
	{ name: "status", type: "text" as const },
	{ name: "inCart", type: "exists" as const },
	{ name: "prices", type: "number" as const, all: true },
];
const ctx: ConditionCtx = { now: "2026-10-05T12:00:00Z", prev: null };
const f = (name: string) => ({ kind: "field" as const, name });
const v = (value: number | string | boolean) => ({ kind: "value" as const, value });
const all = (...clauses: Condition["clauses"]): Condition => ({ mode: "all", clauses });

describe("checkCondition", () => {
	it("accepts well-typed clauses", () => {
		const c = all(
			{ left: f("price"), op: "lt", right: v(300) },
			{ left: f("launchDate"), op: "changed" },
			{ left: f("launchDate"), op: "gt", right: { kind: "today" } },
			{ left: f("status"), op: "contains", right: v("in stock") },
			{ left: f("inCart"), op: "eq", right: v(true) },
			{ left: { kind: "field", name: "prices", agg: "min" }, op: "lte", right: v(10) },
		);
		expect(checkCondition(c, fields)).toEqual([]);
	});

	it.each<[string, Condition["clauses"][number], string]>([
		["unknown field", { left: f("cost"), op: "lt", right: v(1) }, "unknown field cost"],
		["number vs text", { left: f("price"), op: "lt", right: v("cheap") }, "two numbers or two dates"],
		["date vs number", { left: f("launchDate"), op: "gt", right: v(5) }, "two numbers or two dates"],
		["contains on a number", { left: f("price"), op: "contains", right: v("1") }, "compares text"],
		["list without agg", { left: f("prices"), op: "lt", right: v(1) }, "needs agg"],
		["agg on a scalar", { left: { kind: "field", name: "price", agg: "min" }, op: "lt", right: v(1) }, "not a list"],
		["binary op without right", { left: f("price"), op: "lt" }, "needs a right operand"],
		["unary op with right", { left: f("price"), op: "changed", right: v(1) }, "takes no right operand"],
		["changed on a literal", { left: v(1), op: "changed" }, "needs a field"],
		["eq across types", { left: f("inCart"), op: "eq", right: v("yes") }, "compares boolean with text"],
	])("rejects %s", (_name, clause, want) => {
		expect(checkCondition(all(clause), fields).join(" ")).toContain(want);
	});
});

describe("evaluateCondition", () => {
	const values: JsonObject = { price: 279, launchDate: "2026-10-12", status: "In Stock", inCart: true, prices: [12, 9, 30] };

	it("compares numbers, dates against today, text and booleans", () => {
		expect(evaluateCondition(all({ left: f("price"), op: "lt", right: v(300) }), values, ctx)).toBe(true);
		expect(evaluateCondition(all({ left: f("launchDate"), op: "gt", right: { kind: "today" } }), values, ctx)).toBe(true);
		expect(
			evaluateCondition(all({ left: f("launchDate"), op: "gt", right: { kind: "today", offsetDays: 30 } }), values, ctx),
		).toBe(false);
		expect(evaluateCondition(all({ left: f("status"), op: "contains", right: v("in stock") }), values, ctx)).toBe(true);
		expect(evaluateCondition(all({ left: f("inCart"), op: "eq", right: v(true) }), values, ctx)).toBe(true);
	});

	it("aggregates lists", () => {
		const min = { kind: "field" as const, name: "prices", agg: "min" as const };
		const count = { kind: "field" as const, name: "prices", agg: "count" as const };
		expect(evaluateCondition(all({ left: min, op: "lt", right: v(10) }), values, ctx)).toBe(true);
		expect(evaluateCondition(all({ left: count, op: "eq", right: v(3) }), values, ctx)).toBe(true);
	});

	it("changed is false with no baseline, true when the value moved", () => {
		const c = all({ left: f("launchDate"), op: "changed" });
		expect(evaluateCondition(c, values, ctx)).toBe(false);
		expect(evaluateCondition(c, values, { ...ctx, prev: { launchDate: "2026-10-12" } })).toBe(false);
		expect(evaluateCondition(c, values, { ...ctx, prev: { launchDate: "2026-09-30" } })).toBe(true);
	});

	it("prev operands compare against the last good run", () => {
		const c = all({ left: f("price"), op: "lt", right: { kind: "prev", name: "price" } });
		expect(evaluateCondition(c, values, { ...ctx, prev: { price: 299 } })).toBe(true);
		expect(evaluateCondition(c, values, ctx)).toBe(false);
	});

	it("a missing value satisfies no comparison", () => {
		const missing: JsonObject = { ...values, price: null };
		expect(evaluateCondition(all({ left: f("price"), op: "lt", right: v(300) }), missing, ctx)).toBe(false);
		expect(evaluateCondition(all({ left: f("price"), op: "ne", right: v(300) }), missing, ctx)).toBe(false);
		expect(evaluateCondition(all({ left: f("price"), op: "missing" }), missing, ctx)).toBe(true);
	});

	it("any vs all", () => {
		const clauses: Condition["clauses"] = [
			{ left: f("price"), op: "gt", right: v(1000) },
			{ left: f("inCart"), op: "eq", right: v(true) },
		];
		expect(evaluateCondition({ mode: "all", clauses }, values, ctx)).toBe(false);
		expect(evaluateCondition({ mode: "any", clauses }, values, ctx)).toBe(true);
	});
});

describe("renderSummary and describeCondition", () => {
	it("fills placeholders and marks missing values", () => {
		const s = renderSummary("Launch {launchDate} (was {prev.launchDate}), seen {today}; {nope}", { launchDate: "2026-10-12" }, ctx);
		expect(s).toBe("Launch 2026-10-12 (was n/a), seen 2026-10-05; n/a");
	});
	it("reads a condition back as one line", () => {
		const c = all({ left: f("launchDate"), op: "changed" }, { left: f("launchDate"), op: "gt", right: { kind: "today" } });
		expect(describeCondition(c)).toBe("launchDate changed and launchDate > today");
	});
});
