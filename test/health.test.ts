import { describe, expect, it } from "vitest";
import type { RawField } from "../src/server/browse";
import { assess, implausible, type EvalOutput } from "../src/server/health";
import type { Field } from "../src/server/spec";

const f = (over: Partial<Field>): Field => ({ name: "price", description: "", selector: "#p", type: "number", ...over });
const raw = (text: string, context = ""): RawField => ({ count: 1, items: [{ text, attr: null, context }] });
const out = (errors: Record<string, string> = {}): EvalOutput => ({ values: {}, errors, result: null });

describe("assess", () => {
	it("missing required field is drift; missing optional is not", () => {
		const none: RawField = { count: 0, items: [] };
		expect(assess([f({})], { price: none }, out())[0].kind).toBe("missing");
		expect(assess([f({ required: false })], { price: none }, out())).toEqual([]);
	});
	it("exists-fields may match nothing", () => {
		expect(assess([f({ type: "exists" })], { price: { count: 0, items: [] } }, out())).toEqual([]);
	});
	it("anchor mismatch is drift even when the value parses", () => {
		const p = assess([f({ anchor: "Sale price" })], { price: raw("$9.99", "Shipping: $9.99") }, out());
		expect(p[0].kind).toBe("anchor-lost");
	});
	it("anchor match is case-insensitive", () => {
		expect(assess([f({ anchor: "sale PRICE" })], { price: raw("$1", "Sale price: $1") }, out())).toEqual([]);
	});
	it("coercion failure is unparseable", () => {
		const p = assess([f({})], { price: raw("Call us") }, out({ price: "not a number" }));
		expect(p[0].kind).toBe("unparseable");
	});
	it("selector errors are reported as such", () => {
		const p = assess([f({})], { price: { count: 0, items: [], error: "selector error: bad" } }, out());
		expect(p[0].kind).toBe("selector-error");
	});
});

describe("implausible", () => {
	const now = "2026-10-05T00:00:00Z";
	it("numbers must stay within 10x of last good", () => {
		expect(implausible(f({}), 279, 299, now)).toBeNull();
		expect(implausible(f({}), 9.99, 299, now)).toMatch(/10x/);
		expect(implausible(f({}), 5000, 299, now)).toMatch(/10x/);
	});
	it("with no baseline anything non-null passes", () => {
		expect(implausible(f({}), 1, null, now)).toBeNull();
		expect(implausible(f({}), null, null, now)).toBe("no value");
	});
	it("dates must be within 5 years", () => {
		expect(implausible(f({ type: "date" }), "2027-01-01", "2026-12-01", now)).toBeNull();
		expect(implausible(f({ type: "date" }), "2019-01-01", "2026-12-01", now)).toMatch(/5 years/);
	});
});
