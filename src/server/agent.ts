import { AIChatAgent } from "@cloudflare/ai-chat";
import { callable } from "agents";
import { createAI } from "agents/models/ai-sdk";
import { convertToModelMessages, pruneMessages, stepCountIs, streamText, tool, type UIMessage } from "ai";
import { z } from "zod";
import { outline, pickerSnapshot, renderOutline, withPage } from "./browse";
import { describeProblems, draftWatch, dryRun } from "./check";
import { workersAI } from "./compile";
import { describeCondition } from "./condition";
import { JsonObjectSchema, parseJson, type JsonObject } from "./json";
import { LIMITS } from "./limits";
import { checkCron, checkUrl, SpecError, validateSpec, WatchSpecSchema, type WatchSpec } from "./spec";
import type { CheckParams, RunOutcome, RunReport } from "./workflow";

export type Health = "new" | "ok" | "healed" | "broken" | "error";

export type RunView = {
	id: number;
	version: number;
	outcome: RunOutcome;
	match: boolean | null;
	summary: string | null;
	values: JsonObject | null;
	problems: string[];
	startedAt: string;
	finishedAt: string;
};

export type WatchView = {
	id: string;
	name: string;
	intent: string;
	cron: string;
	paused: boolean;
	health: Health;
	version: number;
	spec: WatchSpec;
	lastValues: JsonObject | null;
	lastMatch: boolean | null;
	lastSummary: string | null;
	lastOkAt: string | null;
	lastRunAt: string | null;
	errorStreak: number;
	running: boolean;
	recentRuns: RunView[];
};

export type Notice = { id: number; watchId: string; kind: string; text: string; createdAt: string };

export type HachikoState = { watches: WatchView[]; notices: Notice[] };

type WatchRow = {
	id: string;
	name: string;
	intent: string;
	cron: string;
	paused: number;
	health: Health;
	version: number;
	last_values: string | null;
	last_match: number | null;
	last_summary: string | null;
	last_ok_at: string | null;
	last_run_at: string | null;
	error_streak: number;
	schedule_id: string | null;
	running_instance: string | null;
	running_since: string | null;
	created_at: string;
};

type RunRow = {
	id: number;
	watch_id: string;
	version: number;
	outcome: RunOutcome;
	match: number | null;
	summary: string | null;
	values_json: string | null;
	problems: string;
	started_at: string;
	finished_at: string;
};

// Drafts round-trip through SQLite as JSON; parsed back through this schema.
const StoredDraftSchema = z.object({
	name: z.string(),
	explanation: z.string(),
	spec: WatchSpecSchema,
	preview: z.object({
		values: JsonObjectSchema,
		result: z.object({ match: z.boolean(), summary: z.string() }).nullable(),
		problems: z.array(z.string()),
	}),
	cron: z.string(),
	intent: z.string(),
	replaceWatchId: z.string().nullable(),
});
type StoredDraft = z.infer<typeof StoredDraftSchema>;
const ProblemsSchema = z.array(z.string());

const SYSTEM = `You are hachiko, an assistant that creates and manages web page watches.
A watch loads a page on a schedule, reads values with selectors, and runs a small
condition; the user is notified when the condition becomes true.

How to work:
- To create a watch, call draft_watch with the URL, the user's condition in their words,
  and a UTC cron schedule. Never invent selectors or code yourself; draft_watch compiles
  and dry-runs them against the live page.
- Show the user the draft's name, schedule, the values it read, and whether the
  condition matches right now. If the draft has problems, explain them plainly and
  do not save it; ask for a clearer condition or a different page instead.
- Call save_watch with the draftId to save. The user must approve it in the UI. Never
  say a watch is saved until save_watch has returned.
- Schedules are UTC cron. The minimum interval is ${LIMITS.minIntervalMinutes} minutes. If the user
  gives no schedule, use hourly ("0 * * * *"). Convert local times to UTC when the user
  names a time zone; otherwise say you assumed UTC.
- To change what a watch checks (its condition or page), call draft_watch with
  replaceWatchId, then save_watch. To rename, reschedule, pause or resume, use update_watch.
- delete_watch needs user approval. run_watch_now starts a check immediately.
- If a message includes a picked element, pass it to draft_watch as hint.
Keep replies short and concrete.`;

function nowIso(): string {
	return new Date().toISOString();
}

export class Hachiko extends AIChatAgent<Env, HachikoState> {
	initialState: HachikoState = { watches: [], notices: [] };
	maxPersistedMessages = 200;

	async onStart() {
		this.sql`CREATE TABLE IF NOT EXISTS watches (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			intent TEXT NOT NULL,
			cron TEXT NOT NULL,
			paused INTEGER NOT NULL DEFAULT 0,
			health TEXT NOT NULL DEFAULT 'new',
			version INTEGER NOT NULL,
			last_values TEXT,
			last_match INTEGER,
			last_summary TEXT,
			last_ok_at TEXT,
			last_run_at TEXT,
			error_streak INTEGER NOT NULL DEFAULT 0,
			schedule_id TEXT,
			running_instance TEXT,
			running_since TEXT,
			created_at TEXT NOT NULL
		)`;
		this.sql`CREATE TABLE IF NOT EXISTS watch_versions (
			watch_id TEXT NOT NULL,
			version INTEGER NOT NULL,
			spec TEXT NOT NULL,
			reason TEXT NOT NULL,
			created_at TEXT NOT NULL,
			PRIMARY KEY (watch_id, version)
		)`;
		this.sql`CREATE TABLE IF NOT EXISTS runs (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			watch_id TEXT NOT NULL,
			version INTEGER NOT NULL,
			outcome TEXT NOT NULL,
			match INTEGER,
			summary TEXT,
			values_json TEXT,
			problems TEXT NOT NULL,
			started_at TEXT NOT NULL,
			finished_at TEXT NOT NULL
		)`;
		this.sql`CREATE INDEX IF NOT EXISTS runs_by_watch ON runs (watch_id, id)`;
		this.sql`CREATE TABLE IF NOT EXISTS drafts (
			id TEXT PRIMARY KEY,
			payload TEXT NOT NULL,
			created_at TEXT NOT NULL
		)`;
		this.sql`CREATE TABLE IF NOT EXISTS notices (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			watch_id TEXT NOT NULL,
			kind TEXT NOT NULL,
			text TEXT NOT NULL,
			created_at TEXT NOT NULL
		)`;
		this.refresh();
	}

	// ---- chat ---------------------------------------------------------------

	async onChatMessage() {
		const model = createAI({ binding: workersAI(this.env) }).languageModel(this.env.ORCHESTRATOR_MODEL);
		const result = streamText({
			model,
			system: SYSTEM,
			messages: pruneMessages({
				messages: await convertToModelMessages(this.messages),
				toolCalls: "before-last-2-messages",
			}),
			tools: this.tools(),
			stopWhen: stepCountIs(8),
		});
		return result.toUIMessageStreamResponse();
	}

	private tools() {
		return {
			list_watches: tool({
				description: "List the user's watches with their status and last values.",
				inputSchema: z.object({}),
				execute: async () =>
					this.state.watches.map((w) => ({
						id: w.id,
						name: w.name,
						cron: w.cron,
						paused: w.paused,
						health: w.health,
						lastSummary: w.lastSummary,
						lastValues: w.lastValues,
						lastRunAt: w.lastRunAt,
					})),
			}),
			inspect_page: tool({
				description: "Load a page and return an outline of its visible text with selectors. Use to answer questions about what a page shows.",
				inputSchema: z.object({ url: z.string() }),
				execute: async ({ url }) => {
					const bad = checkUrl(url);
					if (bad) return { error: bad };
					const view = await withPage(this.env, url, undefined, (page) => outline(page));
					return { outline: renderOutline(view, 12_000) };
				},
			}),
			draft_watch: tool({
				description: "Compile a watch from a URL and a condition, and dry-run it against the live page. Returns a draft to show the user.",
				inputSchema: z.object({
					url: z.string(),
					intent: z.string().describe("the condition, in the user's words"),
					cron: z.string().describe("UTC cron, eg '0 * * * *'"),
					hint: z.string().optional().describe("an element the user picked on the page"),
					replaceWatchId: z.string().optional().describe("set when changing an existing watch"),
				}),
				execute: async (input) => this.createDraft(input),
			}),
			save_watch: tool({
				description: "Save a draft as a scheduled watch (or apply it to replaceWatchId). Requires user approval.",
				inputSchema: z.object({ draftId: z.string() }),
				needsApproval: true,
				execute: async ({ draftId }) => this.saveDraft(draftId),
			}),
			update_watch: tool({
				description: "Rename, reschedule, pause or resume a watch.",
				inputSchema: z.object({
					watchId: z.string(),
					name: z.string().optional(),
					cron: z.string().optional(),
					paused: z.boolean().optional(),
				}),
				execute: async ({ watchId, ...patch }) => this.applyUpdate(watchId, patch),
			}),
			delete_watch: tool({
				description: "Delete a watch and its schedule. Requires user approval.",
				inputSchema: z.object({ watchId: z.string() }),
				needsApproval: true,
				execute: async ({ watchId }) => this.removeWatch(watchId),
			}),
			run_watch_now: tool({
				description: "Start a check of a watch immediately.",
				inputSchema: z.object({ watchId: z.string() }),
				execute: async ({ watchId }) => this.startCheck(watchId, "manual"),
			}),
			watch_history: tool({
				description: "Recent runs and spec versions of a watch, including heals.",
				inputSchema: z.object({ watchId: z.string() }),
				execute: async ({ watchId }) => this.history(watchId),
			}),
		};
	}

	// ---- UI callables -------------------------------------------------------

	@callable()
	async runNow(watchId: string) {
		return this.startCheck(watchId, "manual");
	}

	@callable()
	async setPaused(watchId: string, paused: boolean) {
		return this.applyUpdate(watchId, { paused });
	}

	@callable()
	async updateWatch(watchId: string, patch: { name?: string; cron?: string }) {
		return this.applyUpdate(watchId, patch);
	}

	@callable()
	async deleteWatch(watchId: string) {
		return this.removeWatch(watchId);
	}

	@callable()
	async getHistory(watchId: string) {
		return this.history(watchId);
	}

	// The manual path: a hand-written spec, no model involved. Same dry run,
	// same gates as a compiled draft.
	@callable()
	async testSpec(input: unknown) {
		let spec: WatchSpec;
		try {
			spec = validateSpec(input);
		} catch (e) {
			return { problems: e instanceof SpecError ? e.problems : [(e as Error).message] };
		}
		const ev = await dryRun(this.env, spec, { now: nowIso(), prev: null });
		return { values: ev.out.values, result: ev.out.result, problems: describeProblems(ev), raw: ev.raw };
	}

	@callable()
	async createFromSpec(input: { name: string; intent: string; cron: string; spec: unknown }) {
		const cronProblem = checkCron(input.cron);
		if (cronProblem) return { error: cronProblem };
		if (this.count() >= LIMITS.maxWatches) return { error: `watch limit reached (${LIMITS.maxWatches})` };
		const tested = await this.testSpec(input.spec);
		if (tested.problems.length > 0) return { error: "dry run failed", problems: tested.problems };
		return this.saveStored({
			name: input.name,
			explanation: "hand-written spec",
			spec: validateSpec(input.spec),
			preview: { values: tested.values ?? {}, result: tested.result ?? null, problems: [] },
			cron: input.cron,
			intent: input.intent,
			replaceWatchId: null,
		});
	}

	// The picker: a screenshot plus clickable element boxes. The chosen
	// element goes back into the chat as a hint for draft_watch.
	@callable()
	async snapshot(url: string) {
		const bad = checkUrl(url);
		if (bad) return { error: bad };
		return withPage(this.env, url, undefined, (page) => pickerSnapshot(page), { pixels: true });
	}

	@callable()
	async dismissNotices() {
		this.sql`DELETE FROM notices`;
		this.refresh();
	}

	// ---- drafts and watches -------------------------------------------------

	private async createDraft(input: {
		url: string;
		intent: string;
		cron: string;
		hint?: string;
		replaceWatchId?: string;
	}) {
		const urlProblem = checkUrl(input.url);
		if (urlProblem) return { error: urlProblem };
		const cronProblem = checkCron(input.cron);
		if (cronProblem) return { error: cronProblem };
		if (input.replaceWatchId && !this.row(input.replaceWatchId)) return { error: `no watch ${input.replaceWatchId}` };
		if (!input.replaceWatchId && this.count() >= LIMITS.maxWatches) {
			return { error: `watch limit reached (${LIMITS.maxWatches}); delete one first` };
		}

		const draft = await draftWatch(this.env, { url: input.url, intent: input.intent, hint: input.hint, now: nowIso() });
		const id = crypto.randomUUID().slice(0, 8);
		const stored: StoredDraft = {
			...draft,
			cron: input.cron,
			intent: input.intent,
			replaceWatchId: input.replaceWatchId ?? null,
		};
		const cutoff = new Date(Date.now() - LIMITS.draftTtlHours * 3_600_000).toISOString();
		this.sql`DELETE FROM drafts WHERE created_at < ${cutoff}`;
		this.sql`INSERT INTO drafts (id, payload, created_at) VALUES (${id}, ${JSON.stringify(stored)}, ${nowIso()})`;
		return {
			draftId: id,
			name: draft.name,
			explanation: draft.explanation,
			cron: input.cron,
			valuesNow: draft.preview.values,
			matchesNow: draft.preview.result?.match ?? null,
			summaryNow: draft.preview.result?.summary ?? null,
			problems: draft.preview.problems,
			fields: draft.spec.fields.map((f) => ({ name: f.name, selector: f.selector, type: f.type })),
			condition: describeCondition(draft.spec.condition),
			summaryTemplate: draft.spec.summary,
		};
	}

	private async saveDraft(draftId: string) {
		const [row] = this.sql<{ payload: string }>`SELECT payload FROM drafts WHERE id = ${draftId}`;
		if (!row) return { error: `no draft ${draftId}; drafts expire after ${LIMITS.draftTtlHours}h` };
		const d = parseJson(StoredDraftSchema, row.payload, `draft ${draftId}`);
		if (d.preview.problems.length > 0) {
			return { error: "this draft failed its dry run; it cannot be saved", problems: d.preview.problems };
		}
		this.sql`DELETE FROM drafts WHERE id = ${draftId}`;
		return this.saveStored(d);
	}

	private async saveStored(d: StoredDraft) {

		if (d.replaceWatchId) {
			const w = this.row(d.replaceWatchId);
			if (!w) return { error: `no watch ${d.replaceWatchId}` };
			const version = w.version + 1;
			this.sql`INSERT INTO watch_versions (watch_id, version, spec, reason, created_at)
				VALUES (${w.id}, ${version}, ${JSON.stringify(d.spec)}, ${"edited: " + d.intent}, ${nowIso()})`;
			// A new condition starts from a clean slate: prev values and the
			// match state belonged to the old question.
			this.sql`UPDATE watches SET version = ${version}, intent = ${d.intent}, name = ${d.name},
				health = 'new', last_values = NULL, last_match = NULL, last_summary = NULL WHERE id = ${w.id}`;
			if (d.cron !== w.cron) await this.applyUpdate(w.id, { cron: d.cron });
			this.refresh();
			return { saved: true, watchId: w.id, version };
		}

		const id = crypto.randomUUID().slice(0, 8);
		const now = nowIso();
		this.sql`INSERT INTO watches (id, name, intent, cron, version, created_at)
			VALUES (${id}, ${d.name}, ${d.intent}, ${d.cron}, 1, ${now})`;
		this.sql`INSERT INTO watch_versions (watch_id, version, spec, reason, created_at)
			VALUES (${id}, 1, ${JSON.stringify(d.spec)}, 'created', ${now})`;
		const schedule = await this.schedule(d.cron, "tick", { watchId: id });
		this.sql`UPDATE watches SET schedule_id = ${schedule.id} WHERE id = ${id}`;
		// First real run right away, so the baseline (ctx.prev) exists.
		await this.startCheck(id, "manual");
		this.refresh();
		return { saved: true, watchId: id, version: 1 };
	}

	private async applyUpdate(watchId: string, patch: { name?: string; cron?: string; paused?: boolean }) {
		const w = this.row(watchId);
		if (!w) return { error: `no watch ${watchId}` };
		if (patch.cron !== undefined) {
			const bad = checkCron(patch.cron);
			if (bad) return { error: bad };
		}
		if (patch.name !== undefined) this.sql`UPDATE watches SET name = ${patch.name.slice(0, 60)} WHERE id = ${watchId}`;

		const cron = patch.cron ?? w.cron;
		const paused = patch.paused ?? w.paused === 1;
		if (w.schedule_id && (paused || cron !== w.cron)) {
			await this.cancelSchedule(w.schedule_id);
			this.sql`UPDATE watches SET schedule_id = NULL WHERE id = ${watchId}`;
		}
		if (!paused && (cron !== w.cron || !w.schedule_id)) {
			const schedule = await this.schedule(cron, "tick", { watchId });
			this.sql`UPDATE watches SET schedule_id = ${schedule.id} WHERE id = ${watchId}`;
		}
		this.sql`UPDATE watches SET cron = ${cron}, paused = ${paused ? 1 : 0} WHERE id = ${watchId}`;
		this.refresh();
		return { updated: true, watchId, cron, paused };
	}

	private async removeWatch(watchId: string) {
		const w = this.row(watchId);
		if (!w) return { error: `no watch ${watchId}` };
		if (w.schedule_id) await this.cancelSchedule(w.schedule_id);
		this.sql`DELETE FROM watches WHERE id = ${watchId}`;
		this.sql`DELETE FROM watch_versions WHERE watch_id = ${watchId}`;
		this.sql`DELETE FROM runs WHERE watch_id = ${watchId}`;
		this.sql`DELETE FROM notices WHERE watch_id = ${watchId}`;
		this.refresh();
		return { deleted: true, watchId };
	}

	private history(watchId: string) {
		const versions = this.sql<{ version: number; spec: string; reason: string; created_at: string }>`
			SELECT version, spec, reason, created_at FROM watch_versions WHERE watch_id = ${watchId} ORDER BY version DESC`;
		const runs = this.sql<RunRow>`SELECT * FROM runs WHERE watch_id = ${watchId} ORDER BY id DESC LIMIT 30`;
		return {
			versions: versions.map((v) => ({
				version: v.version,
				reason: v.reason,
				createdAt: v.created_at,
				spec: parseJson(WatchSpecSchema, v.spec, `watch ${watchId} v${v.version}`),
			})),
			runs: runs.map(toRunView),
		};
	}

	// ---- checks -------------------------------------------------------------

	// Schedule callback. Payload is the schedule's, so it survives restarts.
	async tick(payload: { watchId: string }) {
		await this.startCheck(payload.watchId, "schedule");
	}

	private async startCheck(watchId: string, reason: "schedule" | "manual") {
		const w = this.row(watchId);
		if (!w) return { error: `no watch ${watchId}` };
		if (reason === "schedule" && w.paused) return { skipped: "paused" };
		const staleBefore = new Date(Date.now() - LIMITS.runningStaleMinutes * 60_000).toISOString();
		if (w.running_since && w.running_since > staleBefore) return { skipped: "a check is already running" };

		const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
		const [{ n: healsToday }] = this.sql<{ n: number }>`
			SELECT COUNT(*) AS n FROM runs WHERE watch_id = ${watchId} AND outcome = 'healed' AND started_at > ${dayAgo}`;
		const params: CheckParams = {
			watchId,
			version: w.version,
			intent: w.intent,
			spec: this.spec(watchId, w.version),
			prev: w.last_values ? parseJson(JsonObjectSchema, w.last_values, `watch ${watchId} last values`) : null,
			healBudget: LIMITS.maxHealsPerDay - healsToday,
		};
		const instanceId = await this.runWorkflow("CHECK_WORKFLOW", params);
		this.sql`UPDATE watches SET running_instance = ${instanceId}, running_since = ${nowIso()} WHERE id = ${watchId}`;
		this.refresh();
		return { started: true, instanceId };
	}

	// Called by CheckWorkflow's last step. The only writer of run results.
	async recordRun(r: RunReport) {
		const w = this.row(r.watchId);
		if (!w) return;
		this.sql`UPDATE watches SET running_instance = NULL, running_since = NULL, last_run_at = ${r.finishedAt}
			WHERE id = ${r.watchId}`;
		this.sql`INSERT INTO runs (watch_id, version, outcome, match, summary, values_json, problems, started_at, finished_at)
			VALUES (${r.watchId}, ${r.version}, ${r.outcome}, ${r.match === null ? null : r.match ? 1 : 0}, ${r.summary},
				${r.values ? JSON.stringify(r.values) : null}, ${JSON.stringify(r.problems)}, ${r.startedAt}, ${r.finishedAt})`;
		this.sql`DELETE FROM runs WHERE watch_id = ${r.watchId} AND id NOT IN
			(SELECT id FROM runs WHERE watch_id = ${r.watchId} ORDER BY id DESC LIMIT ${LIMITS.runsKeptPerWatch})`;

		// A run against a version that has since been replaced reports, but
		// does not move the watch's state.
		if (r.version !== w.version) {
			this.refresh();
			return;
		}

		if (r.outcome === "ok" || r.outcome === "healed") {
			let version = w.version;
			if (r.outcome === "healed" && r.healedSpec) {
				version = w.version + 1;
				this.sql`INSERT INTO watch_versions (watch_id, version, spec, reason, created_at)
					VALUES (${w.id}, ${version}, ${JSON.stringify(r.healedSpec)}, ${"healed: " + (r.healNote ?? "")}, ${r.finishedAt})`;
				await this.notify(w.id, "healed", `"${w.name}" healed itself (v${version}): ${r.healNote ?? "selectors moved"}. ${r.summary ?? ""}`);
			}
			const wasMatch = w.last_match === 1;
			this.sql`UPDATE watches SET version = ${version}, health = ${r.outcome}, error_streak = 0,
				last_values = ${JSON.stringify(r.values)}, last_match = ${r.match ? 1 : 0},
				last_summary = ${r.summary}, last_ok_at = ${r.finishedAt} WHERE id = ${w.id}`;
			const spec = this.spec(w.id, version);
			if (r.match && (spec.notifyOn === "every-match" || !wasMatch)) {
				await this.notify(w.id, "match", `"${w.name}": ${r.summary ?? "condition met"}`);
			}
		} else if (r.outcome === "broken") {
			if (w.health !== "broken") {
				await this.notify(w.id, "broken", `"${w.name}" is broken and could not heal itself: ${r.problems.slice(0, 3).join("; ")}`);
			}
			this.sql`UPDATE watches SET health = 'broken' WHERE id = ${w.id}`;
		} else {
			const streak = w.error_streak + 1;
			this.sql`UPDATE watches SET error_streak = ${streak} WHERE id = ${w.id}`;
			if (streak >= LIMITS.errorStreakToNotify) this.sql`UPDATE watches SET health = 'error' WHERE id = ${w.id}`;
			if (streak === LIMITS.errorStreakToNotify) {
				await this.notify(w.id, "error", `"${w.name}" has failed ${streak} checks in a row: ${r.problems[0] ?? "unknown error"}`);
			}
		}
		this.refresh();
	}

	async onWorkflowError(_workflowName: string, instanceId: string, error: string) {
		const [w] = this.sql<WatchRow>`SELECT * FROM watches WHERE running_instance = ${instanceId}`;
		if (!w) return;
		const now = nowIso();
		await this.recordRun({
			watchId: w.id,
			version: w.version,
			instanceId,
			startedAt: w.running_since ?? now,
			finishedAt: now,
			outcome: "error",
			values: null,
			match: null,
			summary: null,
			problems: [`workflow failed: ${error}`],
			healedSpec: null,
			healNote: null,
		});
	}

	// ---- notifications ------------------------------------------------------

	private async notify(watchId: string, kind: string, text: string) {
		this.sql`INSERT INTO notices (watch_id, kind, text, created_at) VALUES (${watchId}, ${kind}, ${text}, ${nowIso()})`;
		this.sql`DELETE FROM notices WHERE id NOT IN (SELECT id FROM notices ORDER BY id DESC LIMIT 50)`;
		const message: UIMessage = {
			id: crypto.randomUUID(),
			role: "assistant",
			parts: [{ type: "text", text: `[${kind}] ${text}` }],
		};
		await this.persistMessages([...this.messages, message]);
		if (this.env.NOTIFY_WEBHOOK_URL) {
			// Discord-compatible body; Slack accepts { text } instead.
			const res = await fetch(this.env.NOTIFY_WEBHOOK_URL, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ content: `hachiko [${kind}] ${text}`.slice(0, 1900) }),
			}).catch((e: unknown) => new Response(String(e), { status: 599 }));
			if (!res.ok) console.error(`webhook failed: ${res.status}`);
		}
	}

	// ---- state --------------------------------------------------------------

	private row(id: string): WatchRow | undefined {
		return this.sql<WatchRow>`SELECT * FROM watches WHERE id = ${id}`[0];
	}

	private count(): number {
		return this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM watches`[0].n;
	}

	private spec(watchId: string, version: number): WatchSpec {
		const [v] = this.sql<{ spec: string }>`
			SELECT spec FROM watch_versions WHERE watch_id = ${watchId} AND version = ${version}`;
		return parseJson(WatchSpecSchema, v.spec, `watch ${watchId} v${version}`);
	}

	private refresh() {
		const rows = this.sql<WatchRow>`SELECT * FROM watches ORDER BY created_at`;
		const watches = rows.map((w): WatchView => {
			const runs = this.sql<RunRow>`SELECT * FROM runs WHERE watch_id = ${w.id} ORDER BY id DESC LIMIT 5`;
			return {
				id: w.id,
				name: w.name,
				intent: w.intent,
				cron: w.cron,
				paused: w.paused === 1,
				health: w.health,
				version: w.version,
				spec: this.spec(w.id, w.version),
				lastValues: w.last_values ? parseJson(JsonObjectSchema, w.last_values, `watch ${w.id} last values`) : null,
				lastMatch: w.last_match === null ? null : w.last_match === 1,
				lastSummary: w.last_summary,
				lastOkAt: w.last_ok_at,
				lastRunAt: w.last_run_at,
				errorStreak: w.error_streak,
				running: w.running_instance !== null,
				recentRuns: runs.map(toRunView),
			};
		});
		const notices = this.sql<{ id: number; watch_id: string; kind: string; text: string; created_at: string }>`
			SELECT * FROM notices ORDER BY id DESC LIMIT 20`.map((n) => ({
			id: n.id,
			watchId: n.watch_id,
			kind: n.kind,
			text: n.text,
			createdAt: n.created_at,
		}));
		this.setState({ watches, notices });
	}
}

function toRunView(r: RunRow): RunView {
	return {
		id: r.id,
		version: r.version,
		outcome: r.outcome,
		match: r.match === null ? null : r.match === 1,
		summary: r.summary,
		values: r.values_json ? parseJson(JsonObjectSchema, r.values_json, `run ${r.id} values`) : null,
		problems: parseJson(ProblemsSchema, r.problems, `run ${r.id} problems`),
		startedAt: r.started_at,
		finishedAt: r.finished_at,
	};
}
