import { parseExpressionAt } from "acorn";
import { LIMITS } from "./limits";

// Static checks on the predicate before it ever reaches the sandbox. The
// sandbox is the wall (no network, CPU cap); this is the early, readable
// error the compiler model can act on, plus the determinism rules: a
// predicate is a pure function of (v, ctx), so clocks and randomness are out.
const BANNED_IDENTIFIERS = new Set([
	"eval",
	"Function",
	"fetch",
	"connect",
	"WebSocket",
	"EventSource",
	"XMLHttpRequest",
	"importScripts",
	"globalThis",
	"self",
	"caches",
	"setTimeout",
	"setInterval",
	"queueMicrotask",
]);

const BANNED_MEMBERS = new Set(["Date.now", "Math.random", "performance.now"]);

type AstNode = { type: string; [key: string]: unknown };

export function checkPredicate(source: string): string[] {
	if (source.length > LIMITS.maxPredicateLen) {
		return [`predicate: longer than ${LIMITS.maxPredicateLen} chars`];
	}
	let root: AstNode;
	try {
		root = parseExpressionAt(source, 0, { ecmaVersion: "latest" }) as unknown as AstNode;
	} catch (e) {
		return [`predicate: does not parse: ${(e as Error).message}`];
	}
	if ((root as unknown as { end: number }).end !== source.trimEnd().length) {
		return ["predicate: must be a single function expression and nothing else"];
	}
	if (root.type !== "ArrowFunctionExpression" && root.type !== "FunctionExpression") {
		return ["predicate: must be a function expression like (v, ctx) => ({ match, summary })"];
	}

	const problems = new Set<string>();
	// Property names (v.self, { fetch: 1 }) are not references to globals.
	const names = new WeakSet<AstNode>();
	walk(root, (node) => {
		if ((node.type === "MemberExpression" || node.type === "Property") && !node.computed) {
			names.add((node.type === "Property" ? node.key : node.property) as AstNode);
		}
		if (node.type === "ImportExpression" || node.type === "MetaProperty") {
			problems.add("predicate: import is not allowed");
		}
		if (
			node.type === "Identifier" &&
			!names.has(node) &&
			BANNED_IDENTIFIERS.has(node.name as string)
		) {
			problems.add(`predicate: ${node.name as string} is not allowed`);
		}
		if (node.type === "MemberExpression") {
			const name = memberName(node);
			if (name && BANNED_MEMBERS.has(name)) {
				problems.add(`predicate: ${name} is not allowed; use ctx.now`);
			}
		}
		if (node.type === "NewExpression") {
			const callee = node.callee as AstNode;
			const args = node.arguments as unknown[];
			if (callee.type === "Identifier" && callee.name === "Date" && args.length === 0) {
				problems.add("predicate: new Date() reads the clock; use new Date(ctx.now)");
			}
		}
	});
	return [...problems];
}

function memberName(node: AstNode): string | null {
	const obj = node.object as AstNode;
	const prop = node.property as AstNode;
	if (obj.type !== "Identifier" || node.computed) return null;
	if (prop.type !== "Identifier") return null;
	return `${obj.name as string}.${prop.name as string}`;
}

function walk(node: AstNode, visit: (n: AstNode) => void): void {
	visit(node);
	for (const key of Object.keys(node)) {
		if (key === "type" || key === "start" || key === "end") continue;
		const child = node[key];
		if (Array.isArray(child)) {
			for (const c of child) if (c && typeof c === "object" && "type" in c) walk(c as AstNode, visit);
		} else if (child && typeof child === "object" && "type" in child) {
			walk(child as AstNode, visit);
		}
	}
}
