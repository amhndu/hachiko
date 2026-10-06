import { describe, expect, it } from "vitest";
import type { ConditionCtx } from "../src/server/condition";
import { evaluate } from "../src/server/evaluate";
import { validateSpec, type WatchSpec } from "../src/server/spec";
import { HAS_CHROMIUM, useChromium } from "./browser";

// The two use cases from the brief, written as watch specs exactly as the
// compiler would emit them, run against real markup in a real Chromium.

const now = "2026-10-05T12:00:00Z";

describe.skipIf(!HAS_CHROMIUM)("use cases from the brief (real Chromium)", () => {
	const { page, load, extract, outline } = useChromium();

	// "Notify me when product X has a sale price less than Y."
	describe("sale price less than Y", () => {
		// The sale price only exists while a sale runs, so it is optional: no
		// sale means no match, not drift. An optional field alone could go
		// quietly null after a redesign, so it is paired with a required field
		// from the same box: if the box moves, that one drifts and heals.
		const saleUnder = (y: number): WatchSpec =>
			validateSpec({
				url: "https://acme.example/x1",
				fields: [
					{
						name: "price",
						description: "the regular price, always shown in the price box",
						selector: ".price-box .price",
						type: "number",
					},
					{
						name: "salePrice",
						description: "the sale price, shown only during a sale",
						selector: ".price-box .sale",
						type: "number",
						required: false,
						anchor: "Sale price",
					},
				],
				condition: {
					mode: "all",
					clauses: [{ left: { kind: "field", name: "salePrice" }, op: "lt", right: { kind: "value", value: y } }],
				},
				summary: `Sale price is \${salePrice} (target under $${y})`,
				notifyOn: "transition",
			});

		it("matches when the sale price is under Y", async () => {
			await load("shop-v1.html");
			const { out, problems } = evaluate(saleUnder(300), await extract(saleUnder(300).fields), { now, prev: null });
			expect(problems).toEqual([]);
			expect(out.result).toEqual({ match: true, summary: "Sale price is $299 (target under $300)" });
		});

		it("does not match when the sale price is not under Y", async () => {
			await load("shop-v1.html");
			const { out } = evaluate(saleUnder(250), await extract(saleUnder(250).fields), { now, prev: null });
			expect(out.result?.match).toBe(false);
		});

		it("no sale running is no match, not drift", async () => {
			await load("shop-nosale.html");
			const { out, problems } = evaluate(saleUnder(300), await extract(saleUnder(300).fields), { now, prev: null });
			expect(problems).toEqual([]);
			expect(out.result).toEqual({ match: false, summary: "Sale price is $n/a (target under $300)" });
		});

		it("a redesign of the price box is drift even while no sale runs", async () => {
			await load("shop-v2.html");
			const { out, problems } = evaluate(saleUnder(300), await extract(saleUnder(300).fields), { now, prev: null });
			expect(out.result).toBeNull();
			expect(problems.map((p) => `${p.field}:${p.kind}`)).toEqual(["price:missing"]);
		});

		it("variant: the lowest listed price under Y, via a list aggregate", async () => {
			const spec = validateSpec({
				url: "https://acme.example/x1",
				fields: [{ name: "prices", description: "every price shown", selector: ".price-box .price", type: "number", all: true }],
				condition: {
					mode: "all",
					clauses: [
						{ left: { kind: "field", name: "prices", agg: "min" }, op: "lt", right: { kind: "value", value: 300 } },
					],
				},
				summary: "Prices: {prices}",
				notifyOn: "transition",
			});
			await load("shop-v1.html");
			expect(evaluate(spec, await extract(spec.fields), { now, prev: null }).out.result).toEqual({
				match: true,
				summary: "Prices: 299, 349.99",
			});
			await load("shop-nosale.html");
			expect(evaluate(spec, await extract(spec.fields), { now, prev: null }).out.result?.match).toBe(false);
		});
	});

	// "Notify me when the ISRO rocket launch date on
	// https://lvg.shar.gov.in/VSCREGISTRATION/index.jsp is updated and is in
	// the future." The fixture is the real page's markup.
	describe("ISRO launch date updated and in the future", () => {
		const spec = validateSpec({
			url: "https://lvg.shar.gov.in/VSCREGISTRATION/index.jsp",
			fields: [
				{
					name: "launchDate",
					description: "the scheduled launch date under LAUNCH SCHEDULED",
					selector: '#dividleft font[color="blue"]',
					type: "date",
					anchor: "LAUNCH SCHEDULED",
				},
				{
					name: "mission",
					description: "the mission name in the black header above the launch date",
					selector: '#dividleft font[color="white"]',
					type: "text",
				},
			],
			condition: {
				mode: "all",
				clauses: [
					{ left: { kind: "field", name: "launchDate" }, op: "changed" },
					{ left: { kind: "field", name: "launchDate" }, op: "gt", right: { kind: "today" } },
				],
			},
			summary: "{mission} launch is now {launchDate} (was {prev.launchDate})",
			notifyOn: "transition",
		});

		// Simulates the site posting a new launch, by editing the DOM the way
		// the real page would change.
		async function postLaunch(mission: string, when: string): Promise<void> {
			await page().evaluate(
				([m, w]) => {
					const blue = document.querySelector('#dividleft font[color="blue"]');
					const white = document.querySelector('#dividleft font[color="white"] b');
					if (!blue || !white) throw new Error("fixture changed");
					blue.innerHTML = ` LAUNCH SCHEDULED  <br><br>on ${w}`;
					white.textContent = ` ${m}\n`;
				},
				[mission, when],
			);
		}

		it("reads the date from the real markup, ignoring the stale date in an HTML comment", async () => {
			await load("isro-vsc.html");
			const raw = await extract(spec.fields);
			expect(raw.launchDate.count).toBe(1);
			const { out, problems } = evaluate(spec, raw, { now, prev: null });
			expect(problems).toEqual([]);
			expect(out.values).toEqual({ launchDate: "2026-09-04", mission: "GSLV-F17 / EOS-05 Mission" });
			// First run: no baseline, so "changed" cannot hold yet.
			expect(out.result?.match).toBe(false);
		});

		it("the compiler's outline offers a working selector for the date", async () => {
			await load("isro-vsc.html");
			const item = (await outline()).items.find((i) => i.text.includes("LAUNCH SCHEDULED"));
			expect(item).toBeDefined();
			const text = await page().evaluate((sel) => document.querySelector(sel)?.textContent ?? "", item?.sel ?? "");
			expect(text).toContain("04th September 2026");
		});

		const baseline: ConditionCtx = { now, prev: { launchDate: "2026-09-04", mission: "GSLV-F17 / EOS-05 Mission" } };

		it("matches when the date is updated to a future date", async () => {
			await load("isro-vsc.html");
			await postLaunch("PSLV-C62 / Oceansat-3B Mission", "12th December 2026, Saturday at 10:30 AM");
			const { out, problems } = evaluate(spec, await extract(spec.fields), baseline);
			expect(problems).toEqual([]);
			expect(out.result).toEqual({
				match: true,
				summary: "PSLV-C62 / Oceansat-3B Mission launch is now 2026-12-12 (was 2026-09-04)",
			});
		});

		it("does not match when the date is updated but already past", async () => {
			await load("isro-vsc.html");
			await postLaunch("GSLV-F17 / EOS-05 Mission", "20th September 2026, Sunday at 09:00 AM");
			expect(evaluate(spec, await extract(spec.fields), baseline).out.result?.match).toBe(false);
		});

		it("does not match when nothing changed", async () => {
			await load("isro-vsc.html");
			expect(evaluate(spec, await extract(spec.fields), baseline).out.result?.match).toBe(false);
		});

		it("a page that drops the date is drift, never a silent no-match", async () => {
			await load("isro-vsc.html");
			await page().evaluate(() => {
				const blue = document.querySelector('#dividleft font[color="blue"]');
				if (blue) blue.innerHTML = " LAUNCH SCHEDULED <br><br>Date to be announced";
			});
			const { out, problems } = evaluate(spec, await extract(spec.fields), baseline);
			expect(out.result).toBeNull();
			expect(problems.map((p) => p.kind)).toEqual(["unparseable"]);
		});
	});
});
