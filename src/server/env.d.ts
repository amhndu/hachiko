// Optional secret; wrangler types only sees vars declared in wrangler.jsonc.
interface Env {
	NOTIFY_WEBHOOK_URL?: string;
}

declare module "*?raw" {
	const content: string;
	export default content;
}
