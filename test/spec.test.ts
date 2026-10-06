import { describe, expect, it } from "vitest";
import { checkCron, checkUrl, SpecError, validateSpec } from "../src/server/spec";

const base = {
	url: "https://example.com/p",
	fields: [{ name: "price", description: "sale price", selector: "#price", type: "number" }],
	condition: { mode: "all", clauses: [{ left: { kind: "field", name: "price" }, op: "lt", right: { kind: "value", value: 10 } }] },
	summary: "Price is {price}",
	notifyOn: "transition",
};

describe("checkUrl", () => {
	it.each(["http://localhost:8787/", "http://127.0.0.1/", "http://10.0.0.5/", "http://192.168.1.1/", "file:///etc/passwd", "https://user:pw@example.com/", "http://[::1]/"])(
		"rejects %s",
		(u) => expect(checkUrl(u)).not.toBeNull(),
	);
	it("accepts public https", () => expect(checkUrl("https://lvg.shar.gov.in/VSCREGISTRATION/index.jsp")).toBeNull());
});

describe("checkCron", () => {
	const from = new Date("2026-10-05T00:00:00Z");
	it("accepts hourly and daily", () => {
		expect(checkCron("0 * * * *", from)).toBeNull();
		expect(checkCron("0 */6 * * *", from)).toBeNull();
		expect(checkCron("30 6 * * 1", from)).toBeNull();
	});
	it("rejects anything under the hourly floor, including bursts", () => {
		expect(checkCron("*/15 * * * *", from)).toContain("floor");
		expect(checkCron("*/5 9 * * *", from)).toContain("floor");
		expect(checkCron("0,30 9 * * *", from)).toContain("floor");
	});
	it("rejects garbage", () => expect(checkCron("every hour", from)).toContain("cron"));
});

describe("validateSpec", () => {
	it("accepts a minimal spec", () => expect(validateSpec(base).fields).toHaveLength(1));

	it("collects every problem", () => {
		const bad = {
			...base,
			url: "http://localhost/",
			fields: [base.fields[0], { ...base.fields[0] }],
			condition: { mode: "all", clauses: [{ left: { kind: "field", name: "cost" }, op: "lt", right: { kind: "value", value: 1 } }] },
		};
		try {
			validateSpec(bad);
			expect.unreachable();
		} catch (e) {
			expect(e).toBeInstanceOf(SpecError);
			const text = (e as SpecError).problems.join("\n");
			expect(text).toContain("private and loopback");
			expect(text).toContain("duplicate name price");
			expect(text).toContain("unknown field cost");
		}
	});

	it("enforces the field cap", () => {
		const fields = Array.from({ length: 9 }, (_, i) => ({ ...base.fields[0], name: `f${i}` }));
		expect(() => validateSpec({ ...base, fields })).toThrow(SpecError);
	});
});
