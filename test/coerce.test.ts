import { describe, expect, it } from "vitest";
import { coerceAll, parseDate, parseNumber } from "../src/server/sandboxed/coerce.js";

describe("parseNumber", () => {
	it.each([
		["$299.00", 299],
		["1,299.50", 1299.5],
		["1.299,50 EUR", 1299.5],
		["12,5", 12.5],
		["1,234", 1234],
		["Rs. 45,000", 45000],
		["-3", -3],
	])("%s -> %d", (input, want) => expect(parseNumber(input)).toBe(want));

	it("rejects text with no digits", () => expect(parseNumber("Sold out")).toBeNull());
});

describe("parseDate", () => {
	it("reads ISO dates and keeps the time", () => {
		expect(parseDate("2026-10-12", undefined)).toBe("2026-10-12");
		expect(parseDate("2026-10-12 09:30", undefined)).toBe("2026-10-12T09:30:00Z");
	});
	it("uses dateOrder for numeric dates", () => {
		expect(parseDate("12-10-2026", "dmy")).toBe("2026-10-12");
		expect(parseDate("12-10-2026", "mdy")).toBe("2026-12-10");
	});
	it("infers order when one side is over 12, refuses when ambiguous", () => {
		expect(parseDate("25/10/2026", undefined)).toBe("2026-10-25");
		expect(parseDate("10/25/2026", undefined)).toBe("2026-10-25");
		expect(parseDate("05/10/2026", undefined)).toBeNull();
	});
	it("reads month names", () => {
		expect(parseDate("5th Oct 2026", undefined)).toBe("2026-10-05");
		expect(parseDate("October 5, 2026", undefined)).toBe("2026-10-05");
	});
	it("rejects impossible dates", () => expect(parseDate("31-02-2026", "dmy")).toBeNull());
});

describe("coerceAll", () => {
	const item = (text: string, attr: string | null = null) => ({ text, attr, context: "" });

	it("coerces typed fields and flags required failures", () => {
		const { values, errors } = coerceAll(
			[
				{ name: "price", type: "number" },
				{ name: "when", type: "date", dateOrder: "dmy" },
				{ name: "inStock", type: "exists" },
				{ name: "note", type: "text", required: false },
				{ name: "broken", type: "number" },
			],
			{
				price: { count: 1, items: [item("$299.00")] },
				when: { count: 1, items: [item("12-10-2026")] },
				inStock: { count: 0, items: [] },
				note: { count: 0, items: [] },
				broken: { count: 1, items: [item("Call for price")] },
			},
		);
		expect(values).toEqual({ price: 299, when: "2026-10-12", inStock: false, note: null, broken: null });
		expect(Object.keys(errors)).toEqual(["broken"]);
	});

	it("applies pattern and reads attributes", () => {
		const { values } = coerceAll(
			[
				{ name: "qty", type: "number", pattern: "only (\\d+) left" },
				{ name: "amount", type: "number", attr: "content" },
			],
			{
				qty: { count: 1, items: [item("Hurry, only 3 left in stock")] },
				amount: { count: 1, items: [item("", "349.99")] },
			},
		);
		expect(values).toEqual({ qty: 3, amount: 349.99 });
	});

	it("collects lists for all-fields", () => {
		const { values } = coerceAll([{ name: "prices", type: "number", all: true }], {
			prices: { count: 3, items: [item("$1"), item("n/a"), item("$3")] },
		});
		expect(values.prices).toEqual([1, 3]);
	});
});
