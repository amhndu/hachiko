import { describe, expect, it } from "vitest";
import type { RawItem } from "../src/server/browse";
import { coerceAll, cut, parseDate, parseNumber } from "../src/server/coerce";
import { field } from "./fields";

describe("parseNumber", () => {
	it.each([
		["$299.00", 299],
		["1,299.50", 1299.5],
		["1.299,50 EUR", 1299.5],
		["12,5", 12.5],
		["1,234", 1234],
		["Rs. 45,000", 45000],
		["In stock (22 available)", 22],
		["-3", -3],
	])("%s -> %d", (input: string, want: number) => expect(parseNumber(input)).toBe(want));

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
	it("finds the date inside longer text", () => {
		expect(parseDate("Launch: 12-10-2026 (tentative)", "dmy")).toBe("2026-10-12");
	});
	it("reads month names", () => {
		expect(parseDate("5th Oct 2026", undefined)).toBe("2026-10-05");
		expect(parseDate("October 5, 2026", undefined)).toBe("2026-10-05");
	});
	it("rejects impossible dates", () => expect(parseDate("31-02-2026", "dmy")).toBeNull());
});

describe("cut", () => {
	it("keeps what is between the markers, case-insensitively", () => {
		expect(cut("Launch Date: 12-10-2026 (tentative)", "launch date:", "(")).toBe("12-10-2026");
	});
	it("a missing after-marker is a miss; a missing before-marker is ignored", () => {
		expect(cut("Price $5", "Sale:", undefined)).toBeNull();
		expect(cut("Price $5", undefined, "|")).toBe("Price $5");
	});
});

describe("coerceAll", () => {
	const item = (text: string, attr: string | null = null): RawItem => ({ text, attr, context: "" });

	it("coerces typed fields and flags required failures", () => {
		const { values, errors } = coerceAll(
			[
				field({ name: "price", type: "number" }),
				field({ name: "when", type: "date", dateOrder: "dmy" }),
				field({ name: "inStock", type: "exists" }),
				field({ name: "note", type: "text", required: false }),
				field({ name: "broken", type: "number" }),
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

	it("applies markers and reads attributes", () => {
		const { values, errors } = coerceAll(
			[
				field({ name: "qty", type: "number", after: "only" }),
				field({ name: "amount", type: "number", attr: "content" }),
				field({ name: "gone", type: "number", after: "Sale:" }),
			],
			{
				qty: { count: 1, items: [item("2 colours, only 3 left in stock")] },
				amount: { count: 1, items: [item("", "349.99")] },
				gone: { count: 1, items: [item("Price: $5")] },
			},
		);
		expect(values).toEqual({ qty: 3, amount: 349.99, gone: null });
		expect(errors.gone).toContain('"Sale:" not found');
	});

	it("collects lists for all-fields", () => {
		const { values } = coerceAll([field({ name: "prices", type: "number", all: true })], {
			prices: { count: 3, items: [item("$1"), item("n/a"), item("$3")] },
		});
		expect(values.prices).toEqual([1, 3]);
	});
});
