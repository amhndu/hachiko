import puppeteer, { type Page } from "@cloudflare/puppeteer";
import { z } from "zod";
import { BOXES_SRC, EXTRACT_SRC, OUTLINE_SRC } from "./inpage";
import { checkShape } from "./json";
import { LIMITS } from "./limits";
import type { Field } from "./spec";

// Results from page.evaluate run in the page's realm, where the site's own
// scripts could have patched the DOM APIs. They are checked on the way out.
export const RawItemSchema = z.object({
	text: z.string(),
	attr: z.string().nullable(),
	context: z.string(),
});
export const RawFieldSchema = z.object({
	count: z.number().int().nonnegative(),
	items: z.array(RawItemSchema).max(LIMITS.maxMatchesPerField),
	error: z.string().optional(),
});
export const RawResultSchema = z.record(z.string(), RawFieldSchema);
const OutlineSchema = z.object({
	title: z.string(),
	items: z.array(z.object({ sel: z.string(), attr: z.string().optional(), text: z.string() })),
});
const PickerBoxSchema = z.object({
	sel: z.string(),
	text: z.string(),
	x: z.number(),
	y: z.number(),
	w: z.number(),
	h: z.number(),
});
const BoxesSchema = z.object({
	width: z.number().positive(),
	height: z.number().positive(),
	items: z.array(PickerBoxSchema).max(LIMITS.pickerMaxBoxes),
});

export type RawItem = z.infer<typeof RawItemSchema>;
export type RawField = z.infer<typeof RawFieldSchema>;
export type Outline = z.infer<typeof OutlineSchema>;
export type OutlineItem = Outline["items"][number];

export class FetchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FetchError";
	}
}

// Browser Run Free is limited to three simultaneous browsers account-wide.
// Serialize sessions within this Worker isolate to leave room for other
// isolates and prevent one chat turn from exhausting the shared allowance.
let browserQueue: Promise<void> = Promise.resolve();

// One browser session per call: launch, load, run fn, close. Images, fonts
// and media are blocked unless the caller wants pixels (the picker).
export async function withPage<T>(
	env: Env,
	url: string,
	waitFor: string | undefined,
	fn: (page: Page) => Promise<T>,
	opts: { pixels?: boolean } = {},
): Promise<T> {
	const sessionId = crypto.randomUUID();
	const host = safeHost(url);
	const requestedAt = Date.now();
	let release!: () => void;
	const previous = browserQueue;
	browserQueue = new Promise<void>((resolve) => { release = resolve; });
	await previous;
	const queueWaitMs = Date.now() - requestedAt;
	let phase = "launch";
	console.info("browser.session.start", { sessionId, host, queueWaitMs, pixels: opts.pixels ?? false });
	try {
		const launched = await puppeteer.launch(env.BROWSER);
		try {
			phase = "new_page";
			const page = await launched.newPage();
			await page.setViewport({ width: 1280, height: 900 });
			await page.setRequestInterception(true);
			page.on("request", (req) => {
				const blocked = opts.pixels ? ["media"] : ["image", "media", "font"];
				if (blocked.includes(req.resourceType())) void req.abort();
				else void req.continue();
			});
			let res;
			try {
				phase = "navigation";
				res = await page.goto(url, { waitUntil: "networkidle2", timeout: LIMITS.navTimeoutMs });
			} catch (e) {
				throw new FetchError(`navigation failed: ${(e as Error).message}`);
			}
			console.info("browser.session.navigation_complete", {
				sessionId,
				host,
				status: res?.status() ?? null,
				startupAndNavigationMs: Date.now() - requestedAt - queueWaitMs,
			});
			if (res && res.status() >= 400) throw new FetchError(`HTTP ${res.status()} from ${url}`);
			if (waitFor) {
				// A missing waitFor is not fatal here: the fields will come back
				// empty and the drift check names the problem precisely.
				phase = "wait_for_selector";
				await page.waitForSelector(waitFor, { timeout: LIMITS.waitForTimeoutMs }).catch(() => undefined);
			}
			phase = "page_task";
			return await fn(page);
		} finally {
			phase = "close";
			try {
				await launched.close();
				console.info("browser.session.close", { sessionId, host, elapsedMs: Date.now() - requestedAt });
			} catch (e) {
				console.error("browser.session.close_error", {
					sessionId,
					host,
					errorName: e instanceof Error ? e.name : "UnknownError",
					error: safeError(e, url),
				});
				throw e;
			}
		}
	} catch (e) {
		console.error("browser.session.error", {
			sessionId,
			host,
			phase,
			elapsedMs: Date.now() - requestedAt,
			errorName: e instanceof Error ? e.name : "UnknownError",
			error: safeError(e, url),
		});
		throw e;
	} finally {
		release();
	}
}

function safeHost(rawUrl: string): string {
	try {
		return new URL(rawUrl).host;
	} catch {
		return "invalid-url";
	}
}

function safeError(error: unknown, rawUrl: string): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.replaceAll(rawUrl, safeHost(rawUrl)).slice(0, 500);
}

export async function extract(page: Page, fields: Field[]): Promise<Record<string, RawField>> {
	const args = fields.map((f) => ({ name: f.name, selector: f.selector, attr: f.attr }));
	const result: unknown = await page.evaluate(
		`(${EXTRACT_SRC})(${JSON.stringify(args)}, ${LIMITS.maxFieldTextLen}, ${LIMITS.maxMatchesPerField})`,
	);
	return checkShape(RawResultSchema, result, "extract");
}

export async function outline(page: Page): Promise<Outline> {
	const result: unknown = await page.evaluate(
		`(${OUTLINE_SRC})(${LIMITS.outlineMaxItems}, ${LIMITS.outlineMaxChars})`,
	);
	return checkShape(OutlineSchema, result, "outline");
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

export type PickerBox = z.infer<typeof PickerBoxSchema>;
export type PickerSnapshot = { image: string; width: number; height: number; boxes: PickerBox[] };

// A screenshot of the top of the page plus the boxes of everything on it
// that carries text. The user's browser never loads the third-party page.
export async function pickerSnapshot(page: Page): Promise<PickerSnapshot> {
	const boxes: unknown = await page.evaluate(
		`(${BOXES_SRC})(${LIMITS.pickerMaxBoxes}, ${LIMITS.pickerMaxHeight})`,
	);
	const { width, height, items } = checkShape(BoxesSchema, boxes, "picker boxes");
	const shot = (await page.screenshot({
		type: "jpeg",
		quality: 60,
		encoding: "base64",
		clip: { x: 0, y: 0, width, height },
		captureBeyondViewport: true,
	})) as string;
	return { image: `data:image/jpeg;base64,${shot}`, width, height, boxes: items };
}
