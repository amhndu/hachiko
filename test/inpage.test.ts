import { existsSync } from "node:fs";
import { resolve } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Outline, RawField } from "../src/server/browse";
import { assess, implausible } from "../src/server/health";
import { EXTRACT_SRC, OUTLINE_SRC } from "../src/server/inpage";
import { LIMITS } from "../src/server/limits";
import type { PredicateCtx } from "../src/server/sandbox";
import { validateSpec, type Field, type WatchSpec } from "../src/server/spec";
import { fakeSandbox } from "./helpers";

// The in-page scripts against a real Chromium, and the drift/heal decision
// logic against a page before and after a redesign.

const CHROMIUM = process.env.CHROMIUM_PATH ?? "/usr/bin/chromium";
const fixture = (name: string) => `file://${resolve(__dirname, "fixtures", name)}`;

let browser: Browser;
let page: Page;

async function load(name: string) {
	await page.goto(fixture(name));
}
async function extract(fields: Field[]): Promise<Record<string, RawField>> {
	const args = fields.map((f) => ({ name: f.name, selector: f.selector, attr: f.attr }));
	return page.evaluate(`(${EXTRACT_SRC})(${JSON.stringify(args)}, ${LIMITS.maxFieldTextLen}, ${LIMITS.maxMatchesPerField})`) as Promise<
		Record<string, RawField>
	>;
}
async function outline(): Promise<Outline> {
	return page.evaluate(`(${OUTLINE_SRC})(${LIMITS.outlineMaxItems}, ${LIMITS.outlineMaxChars})`) as Promise<Outline>;
}

const ctx: PredicateCtx = { now: "2026-10-05T12:00:00Z", prev: null, lastMatch: null, url: "https://acme.example/x1" };

const shopSpec: WatchSpec = validateSpec({
	url: "https://acme.example/x1",
	fields: [
		{ name: "price", description: "the sale price", selector: "#sale-price", type: "number", anchor: "Sale price" },
		{ name: "inCart", description: "add to cart button is present", selector: "button.add-to-cart", type: "exists" },
	],
	predicate: "(v, ctx) => ({ match: v.price < 300, summary: `Sale price is $${v.price} (target < $300)` })",
	notifyOn: "transition",
});

describe.skipIf(!existsSync(CHROMIUM))("in-page scripts (real Chromium)", () => {
	beforeAll(async () => {
		browser = await puppeteer.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });
		page = await browser.newPage();
	});
	afterAll(async () => {
		await browser?.close();
	});

	it("outline lists meta data and visible text with unique selectors", async () => {
		await load("shop-v1.html");
		const o = await outline();
		expect(o.title).toBe("Acme Headphones");
		expect(o.items).toContainEqual({ sel: 'meta[property="product:price:amount"]', attr: "content", text: "349.99" });
		expect(o.items.find((i) => i.text === "$299.00")?.sel).toBe("#sale-price");
		expect(o.items.some((i) => i.text === "hidden text")).toBe(false);
		for (const item of o.items) {
			if (item.attr) continue;
			const n = await page.evaluate((s) => document.querySelectorAll(s).length, item.sel);
			expect(n, item.sel).toBe(1);
		}
	});

	it("extracts text, attributes, xpath, and label context", async () => {
		await load("shop-v1.html");
		const raw = await extract([
			{ name: "price", description: "", selector: "#sale-price", type: "number" },
			{ name: "meta", description: "", selector: 'meta[property="product:price:amount"]', attr: "content", type: "number" },
			{ name: "x", description: "", selector: "xpath://s[contains(@class,'list')]", type: "number" },
			{ name: "bad", description: "", selector: "div[[", type: "text" },
		]);
		expect(raw.price.items[0].text).toBe("$299.00");
		expect(raw.price.items[0].context).toContain("Sale price:");
		expect(raw.meta.items[0].attr).toBe("349.99");
		expect(raw.x.items[0].text).toBe("$349.99");
		expect(raw.bad.error).toMatch(/selector error/);
	});

	it("a healthy page evaluates with no problems", async () => {
		await load("shop-v1.html");
		const raw = await extract(shopSpec.fields);
		const out = fakeSandbox(shopSpec, raw, ctx);
		expect(assess(shopSpec.fields, raw, out)).toEqual([]);
		expect(out.result).toEqual({ match: true, summary: "Sale price is $299 (target < $300)" });
	});

	it("after a redesign the old spec reports drift, never 'no match'", async () => {
		await load("shop-v2.html");
		const raw = await extract(shopSpec.fields);
		const out = fakeSandbox(shopSpec, raw, ctx);
		expect(out.result).toBeNull();
		expect(assess(shopSpec.fields, raw, out)).toEqual([
			{ field: "price", kind: "missing", detail: "#sale-price matched nothing" },
		]);
	});

	it("a heal onto the right element passes every gate", async () => {
		await load("shop-v2.html");
		const o = await outline();
		const sel = o.items.find((i) => i.text === "$279.00")?.sel;
		expect(sel).toBeDefined();
		// The hashed css-* class must not be in the selector: it will change.
		expect(sel).not.toMatch(/css-/);
		const healed = validateSpec({ ...shopSpec, fields: [{ ...shopSpec.fields[0], selector: sel }, shopSpec.fields[1]] });
		// The button moved too; exists-fields are allowed to read false.
		const raw = await extract(healed.fields);
		const out = fakeSandbox(healed, raw, { ...ctx, prev: { price: 299, inCart: true } });
		expect(assess(healed.fields, raw, out)).toEqual([]);
		expect(implausible(healed.fields[0], out.values.price, 299, ctx.now)).toBeNull();
		expect(out.result?.match).toBe(true);
	});

	it("a heal onto the wrong element (shipping cost) is rejected twice over", async () => {
		await load("shop-v2.html");
		const o = await outline();
		const sel = o.items.find((i) => i.text === "$9.99")?.sel;
		const wrong = validateSpec({ ...shopSpec, fields: [{ ...shopSpec.fields[0], selector: sel }, shopSpec.fields[1]] });
		const raw = await extract(wrong.fields);
		const out = fakeSandbox(wrong, raw, ctx);
		expect(assess(wrong.fields, raw, out).map((p) => p.kind)).toEqual(["anchor-lost"]);
		expect(implausible(wrong.fields[0], out.values.price, 299, ctx.now)).toMatch(/10x/);
	});

	it("the ISRO-style table: a future-date-changed predicate", async () => {
		await load("launch.html");
		const spec = validateSpec({
			url: "https://lvg.shar.gov.in/VSCREGISTRATION/index.jsp",
			fields: [
				{
					name: "launchDate",
					description: "the launch date in the Upcoming launch table",
					selector: "xpath://th[normalize-space()='Launch Date']/following-sibling::td[1]",
					type: "date",
					dateOrder: "dmy",
					anchor: "Launch Date",
				},
			],
			predicate:
				"(v, ctx) => ({ match: ctx.prev !== null && v.launchDate !== ctx.prev.launchDate && v.launchDate > ctx.now.slice(0, 10), summary: `Launch date is ${v.launchDate}` + (ctx.prev ? ` (was ${ctx.prev.launchDate})` : '') })",
			notifyOn: "transition",
		});
		const raw = await extract(spec.fields);
		const first = fakeSandbox(spec, raw, ctx);
		expect(assess(spec.fields, raw, first)).toEqual([]);
		expect(first.values.launchDate).toBe("2026-10-12");
		expect(first.result?.match).toBe(false); // no baseline yet
		const changed = fakeSandbox(spec, raw, { ...ctx, prev: { launchDate: "2026-09-30" } });
		expect(changed.result).toEqual({ match: true, summary: "Launch date is 2026-10-12 (was 2026-09-30)" });
		const past = fakeSandbox(spec, raw, { ...ctx, now: "2026-11-01T00:00:00Z", prev: { launchDate: "2026-09-30" } });
		expect(past.result?.match).toBe(false);
	});
});
