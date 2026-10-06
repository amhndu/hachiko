import puppeteer, { type Page } from "@cloudflare/puppeteer";
import { BOXES_SRC, EXTRACT_SRC, OUTLINE_SRC } from "./inpage";
import { LIMITS } from "./limits";
import type { Field } from "./spec";

export type RawItem = { text: string; attr: string | null; context: string };
export type RawField = { count: number; items: RawItem[]; error?: string };
export type OutlineItem = { sel: string; attr?: string; text: string };
export type Outline = { title: string; items: OutlineItem[] };

export class FetchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FetchError";
	}
}

// One browser session per call: launch, load, run fn, close. Images, fonts
// and media are blocked unless the caller wants pixels (the picker).
export async function withPage<T>(
	env: Env,
	url: string,
	waitFor: string | undefined,
	fn: (page: Page) => Promise<T>,
	opts: { pixels?: boolean } = {},
): Promise<T> {
	const browser = await puppeteer.launch(env.BROWSER);
	try {
		const page = await browser.newPage();
		await page.setViewport({ width: 1280, height: 900 });
		await page.setRequestInterception(true);
		page.on("request", (req) => {
			const blocked = opts.pixels ? ["media"] : ["image", "media", "font"];
			if (blocked.includes(req.resourceType())) void req.abort();
			else void req.continue();
		});
		let res;
		try {
			res = await page.goto(url, { waitUntil: "networkidle2", timeout: LIMITS.navTimeoutMs });
		} catch (e) {
			throw new FetchError(`navigation failed: ${(e as Error).message}`);
		}
		if (res && res.status() >= 400) throw new FetchError(`HTTP ${res.status()} from ${url}`);
		if (waitFor) {
			// A missing waitFor is not fatal here: the fields will come back
			// empty and the drift check names the problem precisely.
			await page.waitForSelector(waitFor, { timeout: LIMITS.waitForTimeoutMs }).catch(() => undefined);
		}
		return await fn(page);
	} finally {
		await browser.close();
	}
}

export async function extract(page: Page, fields: Field[]): Promise<Record<string, RawField>> {
	const args = fields.map((f) => ({ name: f.name, selector: f.selector, attr: f.attr }));
	return (await page.evaluate(
		`(${EXTRACT_SRC})(${JSON.stringify(args)}, ${LIMITS.maxFieldTextLen}, ${LIMITS.maxMatchesPerField})`,
	)) as Record<string, RawField>;
}

export async function outline(page: Page): Promise<Outline> {
	return (await page.evaluate(
		`(${OUTLINE_SRC})(${LIMITS.outlineMaxItems}, ${LIMITS.outlineMaxChars})`,
	)) as Outline;
}

// The outline as the models see it: one element per line.
export function renderOutline(o: Outline, maxChars: number = LIMITS.outlineMaxChars): string {
	const lines = [`title: ${o.title}`];
	let used = lines[0].length;
	for (const item of o.items) {
		const line = `${item.sel}${item.attr ? ` @${item.attr}` : ""} | ${item.text}`;
		used += line.length + 1;
		if (used > maxChars) {
			lines.push("... (truncated)");
			break;
		}
		lines.push(line);
	}
	return lines.join("\n");
}

export type PickerBox = { sel: string; text: string; x: number; y: number; w: number; h: number };
export type PickerSnapshot = { image: string; width: number; height: number; boxes: PickerBox[] };

// A screenshot of the top of the page plus the boxes of everything on it
// that carries text. The user's browser never loads the third-party page.
export async function pickerSnapshot(page: Page): Promise<PickerSnapshot> {
	const { width, height, items } = (await page.evaluate(
		`(${BOXES_SRC})(${LIMITS.pickerMaxBoxes}, ${LIMITS.pickerMaxHeight})`,
	)) as { width: number; height: number; items: PickerBox[] };
	const shot = (await page.screenshot({
		type: "jpeg",
		quality: 60,
		encoding: "base64",
		clip: { x: 0, y: 0, width, height },
		captureBeyondViewport: true,
	})) as string;
	return { image: `data:image/jpeg;base64,${shot}`, width, height, boxes: items };
}
