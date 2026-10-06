// Scripts evaluated inside the rendered page. They are strings on purpose:
// bundlers rewrite functions (esbuild keepNames injects __name() calls) and
// page.evaluate(fn) would then ship a function that references a helper the
// page does not have. These are trusted, fixed code; selectors are data.

// (fields, maxText, maxMatches) -> Record<name, { count, items, error? }>
export const EXTRACT_SRC = `(function (fields, maxText, maxMatches) {
	function clean(s) { return (s || "").replace(/\\s+/g, " ").trim().slice(0, maxText); }
	function contextOf(el) {
		// The nearest ancestor (up to 4 levels) that says more than the
		// element itself: for <tr><th>Launch Date</th><td>12-10-2026</td></tr>
		// that is the row. Nearest, not largest, so a sibling row's label
		// cannot vouch for this element.
		var own = clean(el.innerText || el.textContent), cur = el;
		for (var i = 0; i < 4 && cur.parentElement; i++) {
			cur = cur.parentElement;
			var t = clean(cur.innerText || cur.textContent);
			if (t.length > 400) break;
			if (t.length > own.length) return t;
		}
		return own;
	}
	function query(sel) {
		if (sel.indexOf("xpath:") === 0) {
			var snap = document.evaluate(sel.slice(6), document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
			var out = [];
			for (var i = 0; i < snap.snapshotLength; i++) {
				var n = snap.snapshotItem(i);
				out.push(n.nodeType === 1 ? n : (n.parentElement || n.ownerElement));
			}
			return out.filter(Boolean);
		}
		return Array.prototype.slice.call(document.querySelectorAll(sel));
	}
	var result = {};
	for (var f of fields) {
		try {
			var els = query(f.selector);
			result[f.name] = {
				count: els.length,
				items: els.slice(0, maxMatches).map(function (el) {
					var text = el.innerText !== undefined ? el.innerText : el.textContent;
					if ((!text || !text.trim()) && "value" in el) text = el.value;
					return {
						text: clean(text),
						attr: f.attr ? clean(el.getAttribute(f.attr)) : null,
						context: contextOf(el),
					};
				}),
			};
		} catch (e) {
			result[f.name] = { count: 0, items: [], error: "selector error: " + (e && e.message || e) };
		}
	}
	return result;
})`;

// Builds a selector that is unique in the page right now, preferring stable
// hooks (ids, data-testid, itemprop) and skipping hashed CSS-in-JS classes.
const CSS_PATH_SRC = `
	function stableId(id) { return id && id.length < 40 && !/\\d{4,}|^[0-9]|[:]|^(ember|react|radix|mui)/i.test(id); }
	function stableClass(c) { return c.length < 30 && !/^(css|sc|jsx|emotion|svelte)-|[0-9a-f]{6,}|__[a-zA-Z0-9]{5}$|^_/.test(c); }
	function unique(sel) { try { return document.querySelectorAll(sel).length === 1; } catch (e) { return false; } }
	function cssPath(el) {
		if (stableId(el.id) && unique("#" + CSS.escape(el.id))) return "#" + CSS.escape(el.id);
		var parts = [], cur = el;
		while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
			if (cur !== el && stableId(cur.id)) { parts.unshift("#" + CSS.escape(cur.id)); break; }
			var part = cur.tagName.toLowerCase();
			var hook = ["data-testid", "data-test", "itemprop"].find(function (a) { return cur.hasAttribute(a); });
			if (hook) {
				part += "[" + hook + '="' + cur.getAttribute(hook).replace(/"/g, '\\\\"') + '"]';
			} else {
				var cls = Array.prototype.filter.call(cur.classList, stableClass).slice(0, 2);
				if (cls.length) part += "." + cls.map(function (c) { return CSS.escape(c); }).join(".");
			}
			var parent = cur.parentElement;
			if (parent) {
				var same = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === cur.tagName; });
				if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(cur) + 1) + ")";
			}
			parts.unshift(part);
			if (unique(parts.join(" > "))) return parts.join(" > ");
			cur = parent;
		}
		return parts.join(" > ");
	}
`;

// (maxItems, maxChars) -> { title, items: [{ sel, attr?, text }] }
// A pruned view of the page for the compiler and the healer: meta tags that
// carry data, then every visible element that carries its own text.
export const OUTLINE_SRC = `(function (maxItems, maxChars) {
	${CSS_PATH_SRC}
	var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, SVG: 1, TEMPLATE: 1, IFRAME: 1, HEAD: 1 };
	function ownText(el) {
		var s = "";
		for (var n of el.childNodes) if (n.nodeType === 3) s += n.nodeValue;
		s = s.replace(/\\s+/g, " ").trim();
		if (!s && (el.tagName === "INPUT" || el.tagName === "BUTTON")) s = (el.value || el.getAttribute("aria-label") || "").trim();
		if (!s && el.tagName === "IMG") s = (el.getAttribute("alt") || "").trim();
		return s;
	}
	var items = [], chars = 0;
	var metas = document.querySelectorAll('meta[property^="og:"], meta[property^="product:"], meta[itemprop], meta[name="description"]');
	for (var m of metas) {
		var key = ["property", "itemprop", "name"].find(function (a) { return m.hasAttribute(a); });
		items.push({ sel: "meta[" + key + '="' + m.getAttribute(key) + '"]', attr: "content", text: (m.getAttribute("content") || "").slice(0, 160) });
	}
	var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
		acceptNode: function (el) {
			if (SKIP[el.tagName.toUpperCase()]) return NodeFilter.FILTER_REJECT;
			if (el.checkVisibility && !el.checkVisibility()) return NodeFilter.FILTER_REJECT;
			return NodeFilter.FILTER_ACCEPT;
		},
	});
	var el;
	while ((el = walker.nextNode()) && items.length < maxItems && chars < maxChars) {
		var text = ownText(el);
		if (!text) continue;
		var line = { sel: cssPath(el), text: text.slice(0, 160) };
		chars += line.sel.length + line.text.length + 4;
		items.push(line);
	}
	return { title: document.title, items: items };
})`;

// (maxItems) -> { width, height, items: [{ sel, text, x, y, w, h }] }
// Boxes for the picker, in page coordinates, drawn over a screenshot in the
// UI. Every element with visible text, not just leaves, so a click can pick
// a row or a card as well as a value; the UI picks the smallest box hit.
export const BOXES_SRC = `(function (maxItems, maxHeight) {
	${CSS_PATH_SRC}
	var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, SVG: 1, TEMPLATE: 1, IFRAME: 1, HEAD: 1, HTML: 1, BODY: 1 };
	var items = [];
	var all = document.body.querySelectorAll("*");
	for (var i = 0; i < all.length && items.length < maxItems; i++) {
		var el = all[i];
		if (SKIP[el.tagName.toUpperCase()]) continue;
		var r = el.getBoundingClientRect();
		if (r.width < 4 || r.height < 4) continue;
		var y = r.top + window.scrollY;
		if (y > maxHeight) continue;
		var text = (el.innerText || "").replace(/\\s+/g, " ").trim();
		if (!text || text.length > 300) continue;
		items.push({ sel: cssPath(el), text: text.slice(0, 160), x: r.left + window.scrollX, y: y, w: r.width, h: r.height });
	}
	return { width: document.documentElement.clientWidth, height: Math.min(document.documentElement.scrollHeight, maxHeight), items: items };
})`;
