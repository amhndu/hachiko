import { routeAgentRequest } from "agents";

export { Hachiko } from "./agent";
export { CheckWorkflow } from "./workflow";

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		return (await routeAgentRequest(request, env)) ?? new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
