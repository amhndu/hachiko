// Runs INSIDE the sandbox (shipped as source via ?raw) and in unit tests.
// Plain JS, no imports: the Dynamic Worker gets exactly this file plus the
// predicate. It runs here, not in the host, because `pattern` is model-written
// regex and a bad one should burn the sandbox's CPU cap, not ours.

/**
 * @typedef {{ text: string, attr: string | null, context: string }} RawItem
 * @typedef {{ count: number, items: RawItem[], error?: string }} RawField
 * @typedef {{ name: string, type: "text" | "number" | "date" | "exists", attr?: string,
 *   pattern?: string, dateOrder?: "dmy" | "mdy" | "ymd", all?: boolean, required?: boolean }} FieldDef
 */

const MONTHS = {
	jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
	jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** @param {FieldDef} field @param {string} raw */
function applyPattern(field, raw) {
	if (!field.pattern) return raw;
	const m = new RegExp(field.pattern, "i").exec(raw);
	if (!m) return null;
	return (m[1] ?? m[0]).trim();
}

/** @param {string} s */
export function parseNumber(s) {
	// The first numeric run: "Rs. 45,000" must not read the dot after "Rs".
	const run = /-?\d[\d.,]*/.exec(s);
	if (!run) return null;
	const cleaned = run[0].replace(/[.,]+$/, "");
	// "1.234,56" (comma decimal) vs "1,234.56" (comma thousands)
	const lastComma = cleaned.lastIndexOf(",");
	const lastDot = cleaned.lastIndexOf(".");
	let normal;
	if (lastComma > lastDot && cleaned.length - lastComma - 1 !== 3) {
		normal = cleaned.replace(/\./g, "").replace(",", ".");
	} else {
		normal = cleaned.replace(/,/g, "");
	}
	const n = Number.parseFloat(normal);
	return Number.isFinite(n) ? n : null;
}

/** @param {number} y @param {number} m @param {number} d */
function isoDate(y, m, d) {
	if (y < 100) y += 2000;
	if (m < 1 || m > 12 || d < 1 || d > 31) return null;
	const dt = new Date(Date.UTC(y, m - 1, d));
	if (dt.getUTCMonth() !== m - 1) return null;
	return dt.toISOString().slice(0, 10);
}

/** @param {string} s @param {"dmy" | "mdy" | "ymd" | undefined} order */
export function parseDate(s, order) {
	const t = s.trim();
	// 2026-10-05, 2026/10/05, optionally with a time
	let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ](\d{1,2}):(\d{2}))?/.exec(t);
	if (m) {
		const day = isoDate(+m[1], +m[2], +m[3]);
		if (!day) return null;
		return m[4] ? `${day}T${m[4].padStart(2, "0")}:${m[5]}:00Z` : day;
	}
	// 05/10/2026 or 05-10-26: needs an order unless one side is > 12
	m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/.exec(t);
	if (m) {
		const a = +m[1], b = +m[2], y = +m[3];
		let resolved = order;
		if (!resolved || resolved === "ymd") resolved = a > 12 ? "dmy" : b > 12 ? "mdy" : null;
		if (!resolved) return null;
		return resolved === "dmy" ? isoDate(y, b, a) : isoDate(y, a, b);
	}
	// 5 Oct 2026, 05 October 2026
	m = /(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3})[a-z]*\.?,?\s+(\d{4})/i.exec(t);
	if (m && MONTHS[m[2].toLowerCase()]) return isoDate(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
	// October 5, 2026
	m = /([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/i.exec(t);
	if (m && MONTHS[m[1].toLowerCase()]) return isoDate(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
	return null;
}

/** @param {FieldDef} field @param {RawItem} item */
function coerceItem(field, item) {
	const source = field.attr ? (item.attr ?? "") : item.text;
	const picked = applyPattern(field, source);
	if (picked === null) return { error: `pattern did not match "${source.slice(0, 80)}"` };
	if (field.type === "text") return { value: picked };
	if (field.type === "number") {
		const n = parseNumber(picked);
		return n === null ? { error: `not a number: "${picked.slice(0, 80)}"` } : { value: n };
	}
	if (field.type === "date") {
		const d = parseDate(picked, field.dateOrder);
		return d === null ? { error: `not a date: "${picked.slice(0, 80)}"` } : { value: d };
	}
	return { error: `unknown type ${field.type}` };
}

/**
 * @param {FieldDef[]} fields
 * @param {Record<string, RawField>} raw
 * @returns {{ values: Record<string, unknown>, errors: Record<string, string> }}
 */
export function coerceAll(fields, raw) {
	/** @type {Record<string, unknown>} */
	const values = {};
	/** @type {Record<string, string>} */
	const errors = {};
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
			const list = [];
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
