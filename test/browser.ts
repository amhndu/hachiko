import { existsSync } from "node:fs";
import { resolve } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { afterAll, beforeAll } from "vitest";
import { checkShape } from "../src/server/json";
import { RawResultSchema, type Outline, type RawField } from "../src/server/browse";
import { EXTRACT_SRC, OUTLINE_SRC } from "../src/server/inpage";
import { LIMITS } from "../src/server/limits";
import type { Field } from "../src/server/spec";

// A real Chromium for the in-page scripts. Tests that need it wrap their
// describe in skipIf(!HAS_CHROMIUM) and call useChromium() inside it.

const CHROMIUM = process.env.CHROMIUM_PATH ?? "/usr/bin/chromium";
export const HAS_CHROMIUM: boolean = existsSync(CHROMIUM);

export type Chromium = {
	page: () => Page;
	load: (fixture: string) => Promise<void>;
	extract: (fields: Field[]) => Promise<Record<string, RawField>>;
	outline: () => Promise<Outline>;
};

export function useChromium(): Chromium {
	let browser: Browser | undefined;
	let page: Page | undefined;
	beforeAll(async () => {
		browser = await puppeteer.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });
		page = await browser.newPage();
	});
	afterAll(async () => {
		await browser?.close();
	});
	const current = (): Page => {
		if (!page) throw new Error("useChromium: browser not started (call inside a describe)");
		return page;
	};
	return {
		page: current,
		load: async (fixture: string) => {
			await current().goto(`file://${resolve(__dirname, "fixtures", fixture)}`);
		},
		extract: async (fields: Field[]) => {
			const args = fields.map((f) => ({ name: f.name, selector: f.selector, attr: f.attr }));
			const result: unknown = await current().evaluate(
				`(${EXTRACT_SRC})(${JSON.stringify(args)}, ${LIMITS.maxFieldTextLen}, ${LIMITS.maxMatchesPerField})`,
			);
			return checkShape(RawResultSchema, result, "extract");
		},
		outline: async () =>
			(await current().evaluate(`(${OUTLINE_SRC})(${LIMITS.outlineMaxItems}, ${LIMITS.outlineMaxChars})`)) as Outline,
	};
}
