import type { RawField, RawItem } from "./browse";
import type { Json, JsonObject } from "./json";
import type { Field } from "./spec";

// Raw page text to typed values. Fully declarative: the spec says which type
// to read and, optionally, literal markers to cut the text at (`after`,
// `before`). Every regex here is fixed and ours; nothing model-written is
// compiled or executed.

type DateOrder = "dmy" | "mdy" | "ymd";
type Coerced = { value: Json } | { error: string };

const MONTHS: Record<string, number> = {
	jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
	jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

// "Launch Date: 12-10-2026 (tentative)" with after "Launch Date:" and
// before "(" gives "12-10-2026". Markers are matched case-insensitively.
export function cut(text: string, after: string | undefined, before: string | undefined): string | null {
	let s = text;
	if (after) {
		const i = s.toLowerCase().indexOf(after.toLowerCase());
		if (i < 0) return null;
		s = s.slice(i + after.length);
	}
	if (before) {
		const i = s.toLowerCase().indexOf(before.toLowerCase());
		if (i >= 0) s = s.slice(0, i);
	}
	return s.trim();
}

export function parseNumber(s: string): number | null {
	// The first numeric run: "Rs. 45,000" must not read the dot after "Rs".
	const run = /-?\d[\d.,]*/.exec(s);
	if (!run) return null;
	const cleaned = run[0].replace(/[.,]+$/, "");
	// "1.234,56" (comma decimal) vs "1,234.56" (comma thousands)
	const lastComma = cleaned.lastIndexOf(",");
	const lastDot = cleaned.lastIndexOf(".");
	const commaDecimal = lastComma > lastDot && cleaned.length - lastComma - 1 !== 3;
	const normal = commaDecimal ? cleaned.replace(/\./g, "").replace(",", ".") : cleaned.replace(/,/g, "");
	const n = Number.parseFloat(normal);
	return Number.isFinite(n) ? n : null;
}

function isoDate(year: number, month: number, day: number): string | null {
	const y = year < 100 ? year + 2000 : year;
	if (month < 1 || month > 12 || day < 1 || day > 31) return null;
	const dt = new Date(Date.UTC(y, month - 1, day));
	if (dt.getUTCMonth() !== month - 1) return null;
	return dt.toISOString().slice(0, 10);
}

// The first date in the text, as YYYY-MM-DD (or YYYY-MM-DDTHH:MM:00Z when a
// time follows an ISO date).
export function parseDate(s: string, order: DateOrder | undefined): string | null {
	const iso = /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ](\d{1,2}):(\d{2}))?/.exec(s);
	if (iso) {
		const day = isoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
		if (!day) return null;
		return iso[4] ? `${day}T${iso[4].padStart(2, "0")}:${iso[5]}:00Z` : day;
	}
	// 05/10/2026 or 05-10-26: needs an order unless one side is over 12
	const numeric = /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/.exec(s);
	if (numeric) {
		const a = Number(numeric[1]);
		const b = Number(numeric[2]);
		const y = Number(numeric[3]);
		const inferred: DateOrder | null = a > 12 ? "dmy" : b > 12 ? "mdy" : null;
		const resolved = order === "dmy" || order === "mdy" ? order : inferred;
		if (!resolved) return null;
		return resolved === "dmy" ? isoDate(y, b, a) : isoDate(y, a, b);
	}
	// 5 Oct 2026, 05 October 2026
	const dayFirst = /(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3})[a-z]*\.?,?\s+(\d{4})/i.exec(s);
	if (dayFirst) {
		const month = MONTHS[dayFirst[2].toLowerCase()];
		if (month) return isoDate(Number(dayFirst[3]), month, Number(dayFirst[1]));
	}
	// October 5, 2026
	const monthFirst = /([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/i.exec(s);
	if (monthFirst) {
		const month = MONTHS[monthFirst[1].toLowerCase()];
		if (month) return isoDate(Number(monthFirst[3]), month, Number(monthFirst[2]));
	}
	return null;
}

function coerceItem(field: Field, item: RawItem): Coerced {
	const source = field.attr ? (item.attr ?? "") : item.text;
	const picked = cut(source, field.after, field.before);
	if (picked === null) return { error: `"${field.after}" not found in "${source.slice(0, 80)}"` };
	if (field.type === "text") return { value: picked };
	if (field.type === "number") {
		const n = parseNumber(picked);
		return n === null ? { error: `not a number: "${picked.slice(0, 80)}"` } : { value: n };
	}
	const d = parseDate(picked, field.dateOrder);
	return d === null ? { error: `not a date: "${picked.slice(0, 80)}"` } : { value: d };
}

export function coerceAll(
	fields: Field[],
	raw: Record<string, RawField>,
): { values: JsonObject; errors: Record<string, string> } {
	const values: JsonObject = {};
	const errors: Record<string, string> = {};
	for (const field of fields) {
		const r = raw[field.name];
		const required = field.required !== false;
		if (!r || r.error) {
			errors[field.name] = r?.error ?? "not extracted";
			values[field.name] = null;
			continue;
		}
		if (field.type === "exists") {
			values[field.name] = r.count > 0;
			continue;
		}
		if (r.count === 0) {
			values[field.name] = field.all ? [] : null;
			if (required) errors[field.name] = "no element matched";
			continue;
		}
		if (field.all) {
			const list: Json[] = [];
			for (const item of r.items) {
				const c = coerceItem(field, item);
				if ("value" in c) list.push(c.value);
			}
			values[field.name] = list;
			if (list.length === 0 && required) errors[field.name] = "no match coerced";
			continue;
		}
		const c = coerceItem(field, r.items[0]);
		if ("value" in c) {
			values[field.name] = c.value;
		} else {
			values[field.name] = null;
			if (required) errors[field.name] = c.error;
		}
	}
	return { values, errors };
}
