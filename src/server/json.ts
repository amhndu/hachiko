import { z } from "zod";

// Values that cross a durable boundary (workflow steps, SQLite, RPC) are JSON.
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export const JsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), z.json());

export class DataError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DataError";
	}
}

// Every JSON string that comes back from somewhere else (the sandbox, the
// database) is parsed here and checked against a schema before it is used.
// A cast would hand an unchecked shape to the rest of the code.
export function parseJson<T>(schema: z.ZodType<T>, text: string, what: string): T {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (e) {
		throw new DataError(`${what}: not JSON: ${(e as Error).message}`);
	}
	return checkShape(schema, raw, what);
}

// The same check for values that arrive already parsed, eg page.evaluate
// results, which the page's own scripts could have tampered with.
export function checkShape<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
	const parsed = schema.safeParse(value);
	if (!parsed.success) {
		const issues = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
		throw new DataError(`${what}: unexpected shape: ${issues.join("; ")}`);
	}
	return parsed.data;
}
