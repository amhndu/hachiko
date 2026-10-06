import { describe, expect, it } from "vitest";
import { checkPredicate } from "../src/server/predicate-check";

describe("checkPredicate", () => {
	it("accepts a pure arrow function", () => {
		expect(checkPredicate("(v, ctx) => ({ match: v.price < 300, summary: `Price is ${v.price}` })")).toEqual([]);
		expect(checkPredicate("(v, ctx) => ({ match: v.when > ctx.now.slice(0, 10), summary: new Date(ctx.now).toISOString() })")).toEqual([]);
	});

	it("allows banned words as property names", () => {
		expect(checkPredicate("(v) => ({ match: v.self === 1, summary: String({ fetch: 1 }.fetch) })")).toEqual([]);
	});

	it.each([
		["(v) => fetch('https://x')", "fetch is not allowed"],
		["(v) => ({ match: Date.now() > 0, summary: '' })", "Date.now is not allowed"],
		["(v) => ({ match: new Date() > 0, summary: '' })", "new Date() reads the clock"],
		["(v) => import('x')", "import is not allowed"],
		["(v) => globalThis.x", "globalThis is not allowed"],
		["(v) => ({ match: Math.random() > 0.5, summary: '' })", "Math.random is not allowed"],
		["v.price < 3", "must be a function expression"],
		["(v) => 1; fetch('x')", "single function expression"],
		["(v) => {", "does not parse"],
	])("rejects %s", (src, want) => {
		expect(checkPredicate(src).join(" ")).toContain(want);
	});
});
