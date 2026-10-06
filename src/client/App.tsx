import { getToolApproval, getToolInput, getToolOutput, getToolPartState, useAgentChat } from "@cloudflare/ai-chat/react";
import { useAgent } from "agents/react";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { PickerBox, PickerSnapshot } from "../server/browse";
import type { HachikoState, Notice, RunView, WatchView } from "../server/agent";
import type { Hachiko } from "../server/agent";

type Agent = ReturnType<typeof useAgent<Hachiko, HachikoState>>;
type History = Awaited<ReturnType<Hachiko["getHistory"]>>;

export function App() {
	const [state, setState] = useState<HachikoState>({ watches: [], notices: [] });
	const agent = useAgent<Hachiko, HachikoState>({
		agent: "Hachiko",
		name: "me",
		onStateUpdate: (s) => setState(s),
	});

	return (
		<div className="shell">
			<header className="top">
				<h1>hachiko</h1>
				<span className="tag">waits at the station so you don't have to</span>
			</header>
			<Notices notices={state.notices} onDismiss={() => void agent.stub.dismissNotices()} />
			<main className="cols">
				<section className="watches" aria-label="Watches">
					<h2>Watches <span className="count">{state.watches.length}</span></h2>
					{state.watches.length === 0 && (
						<p className="empty">No watches yet. Ask in the chat: "tell me when the price on &lt;url&gt; drops under $50".</p>
					)}
					{state.watches.map((w) => (
						<WatchCard key={w.id} watch={w} agent={agent} />
					))}
				</section>
				<Chat agent={agent} />
			</main>
		</div>
	);
}

function Notices({ notices, onDismiss }: { notices: Notice[]; onDismiss: () => void }) {
	if (notices.length === 0) return null;
	return (
		<section className="notices" aria-label="Notifications">
			<ul>
				{notices.slice(0, 5).map((n) => (
					<li key={n.id} className={`notice notice-${n.kind}`}>
						<span className="pill">{n.kind}</span> {n.text} <time>{ago(n.createdAt)}</time>
					</li>
				))}
			</ul>
			<button className="ghost" onClick={onDismiss}>Dismiss all</button>
		</section>
	);
}

function WatchCard({ watch: w, agent }: { watch: WatchView; agent: Agent }) {
	const [open, setOpen] = useState(false);
	const [history, setHistory] = useState<History | null>(null);
	const host = safeHost(w.spec.url);

	useEffect(() => {
		if (open) void agent.stub.getHistory(w.id).then(setHistory);
	}, [open, w.version, w.lastRunAt, agent, w.id]);

	return (
		<article className={`card health-${w.health}`}>
			<div className="card-head">
				<div>
					<h3>{w.name}</h3>
					<a href={w.spec.url} target="_blank" rel="noreferrer" className="host">{host}</a>
				</div>
				<div className="badges">
					{w.running && <span className="pill pill-running">checking</span>}
					{w.paused && <span className="pill pill-paused">paused</span>}
					<span className={`pill pill-${w.health}`}>{w.health}</span>
					{w.lastMatch && <span className="pill pill-match">match</span>}
				</div>
			</div>
			<p className="summary">{w.lastSummary ?? "No successful check yet."}</p>
			<dl className="meta">
				<dt>schedule</dt><dd><code>{w.cron}</code> UTC</dd>
				<dt>last run</dt><dd>{w.lastRunAt ? ago(w.lastRunAt) : "never"}</dd>
				<dt>last ok</dt><dd>{w.lastOkAt ? ago(w.lastOkAt) : "never"}</dd>
				<dt>version</dt><dd>v{w.version}</dd>
			</dl>
			{w.lastValues && <Values values={w.lastValues} />}
			<div className="actions">
				<button onClick={() => void agent.stub.runNow(w.id)} disabled={w.running}>Run now</button>
				<button onClick={() => void agent.stub.setPaused(w.id, !w.paused)}>{w.paused ? "Resume" : "Pause"}</button>
				<button className="ghost" onClick={() => setOpen(!open)}>{open ? "Hide details" : "Details"}</button>
				<button
					className="danger"
					onClick={() => {
						if (confirm(`Delete "${w.name}"?`)) void agent.stub.deleteWatch(w.id);
					}}
				>
					Delete
				</button>
			</div>
			{open && (
				<div className="details">
					<p className="intent">"{w.intent}"</p>
					<table>
						<thead><tr><th>field</th><th>type</th><th>selector</th><th>anchor</th></tr></thead>
						<tbody>
							{w.spec.fields.map((f) => (
								<tr key={f.name} title={f.description}>
									<td>{f.name}</td>
									<td>{f.type}{f.all ? "[]" : ""}</td>
									<td><code>{f.selector}{f.attr ? ` @${f.attr}` : ""}</code></td>
									<td>{f.anchor ?? ""}</td>
								</tr>
							))}
						</tbody>
					</table>
					<pre className="code">{w.spec.predicate}</pre>
					{history && (
						<>
							<h4>Versions</h4>
							<ul className="versions">
								{history.versions.map((v) => (
									<li key={v.version}>v{v.version} -- {v.reason} <time>{ago(v.createdAt)}</time></li>
								))}
							</ul>
							<h4>Runs</h4>
							<ul className="runs">{history.runs.map((r) => <Run key={r.id} run={r} />)}</ul>
						</>
					)}
				</div>
			)}
		</article>
	);
}

function Run({ run: r }: { run: RunView }) {
	return (
		<li>
			<span className={`pill pill-${r.outcome}`}>{r.outcome}</span> v{r.version} <time>{ago(r.startedAt)}</time>
			{r.summary && <span> -- {r.summary}</span>}
			{r.problems.length > 0 && <ul className="problems">{r.problems.map((p, i) => <li key={i}>{p}</li>)}</ul>}
		</li>
	);
}

function Values({ values }: { values: Record<string, unknown> }) {
	return (
		<dl className="values">
			{Object.entries(values).map(([k, v]) => (
				<div key={k}><dt>{k}</dt><dd>{JSON.stringify(v)}</dd></div>
			))}
		</dl>
	);
}

function Chat({ agent }: { agent: Agent }) {
	const { messages, sendMessage, addToolApprovalResponse, status, clearHistory } = useAgentChat({ agent });
	const [input, setInput] = useState("");
	const [picking, setPicking] = useState(false);
	const end = useRef<HTMLDivElement>(null);
	const busy = status === "submitted" || status === "streaming";

	useEffect(() => {
		// Braces matter: newer Chromium returns a Promise from scrollIntoView,
		// and React treats any returned non-function as a broken cleanup.
		end.current?.scrollIntoView({ block: "end" });
	}, [messages]);

	function submit(e: FormEvent) {
		e.preventDefault();
		const text = input.trim();
		if (!text || busy) return;
		void sendMessage({ text });
		setInput("");
	}

	return (
		<section className="chat" aria-label="Chat">
			<div className="chat-head">
				<h2>Chat</h2>
				<button className="ghost" onClick={clearHistory}>Clear</button>
			</div>
			<div className="log">
				{messages.map((m) => <Message key={m.id} message={m} onApprove={addToolApprovalResponse} />)}
				{busy && <p className="thinking">...</p>}
				<div ref={end} />
			</div>
			{picking && (
				<Picker
					agent={agent}
					onClose={() => setPicking(false)}
					onPick={(url, box) => {
						setInput((cur) => `${cur}${cur ? "\n" : ""}[picked element on ${url}: selector \`${box.sel}\`, text "${box.text.slice(0, 120)}"]`);
						setPicking(false);
					}}
				/>
			)}
			<form onSubmit={submit} className="composer">
				<textarea
					value={input}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey) submit(e);
					}}
					placeholder="Notify me when the sale price on https://... is under $40"
					rows={3}
				/>
				<div className="composer-actions">
					<button type="submit" disabled={busy || !input.trim()}>Send</button>
					<button type="button" className="ghost" onClick={() => setPicking(true)}>Pick</button>
				</div>
			</form>
		</section>
	);
}

// Point at an element instead of describing it. The page is rendered by
// Browser Run; this shows its screenshot with the element boxes on top, so
// third-party HTML never runs in this origin.
function Picker({ agent, onClose, onPick }: { agent: Agent; onClose: () => void; onPick: (url: string, box: PickerBox) => void }) {
	const [url, setUrl] = useState("");
	const [snap, setSnap] = useState<PickerSnapshot | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [hover, setHover] = useState<PickerBox | null>(null);
	const [chosen, setChosen] = useState<PickerBox | null>(null);
	const [scale, setScale] = useState(1);

	async function load(e: FormEvent) {
		e.preventDefault();
		setLoading(true);
		setError(null);
		setSnap(null);
		setChosen(null);
		const res = (await agent.stub.snapshot(url).catch((err: Error) => ({ error: err.message }))) as PickerSnapshot | { error: string };
		setLoading(false);
		if ("error" in res) setError(res.error);
		else setSnap(res);
	}

	function hit(e: React.MouseEvent<HTMLDivElement>): PickerBox | null {
		if (!snap) return null;
		const rect = e.currentTarget.getBoundingClientRect();
		const x = (e.clientX - rect.left) / scale;
		const y = (e.clientY - rect.top) / scale;
		let best: PickerBox | null = null;
		for (const b of snap.boxes) {
			if (x < b.x || y < b.y || x > b.x + b.w || y > b.y + b.h) continue;
			if (!best || b.w * b.h < best.w * best.h) best = b;
		}
		return best;
	}

	const shown = chosen ?? hover;
	return (
		<div className="picker" role="dialog" aria-label="Pick an element">
			<form onSubmit={load} className="picker-bar">
				<input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://..." />
				<button type="submit" disabled={loading || !url}>{loading ? "Loading..." : "Load"}</button>
				<button type="button" className="ghost" onClick={onClose}>Close</button>
			</form>
			{error && <p className="problems">{error}</p>}
			{snap && (
				<div className="picker-stage">
					<div
						className="picker-canvas"
						style={{ width: snap.width * scale, height: snap.height * scale }}
						onMouseMove={(e) => setHover(hit(e))}
						onMouseLeave={() => setHover(null)}
						onClick={(e) => setChosen(hit(e))}
					>
						<img
							src={snap.image}
							alt="Rendered page"
							width={snap.width * scale}
							onLoad={(e) => setScale(Math.min(1, (e.currentTarget.parentElement?.parentElement?.clientWidth ?? snap.width) / snap.width))}
						/>
						{shown && (
							<div
								className={`picker-box ${chosen ? "chosen" : ""}`}
								style={{ left: shown.x * scale, top: shown.y * scale, width: shown.w * scale, height: shown.h * scale }}
							/>
						)}
					</div>
				</div>
			)}
			{chosen && (
				<div className="picker-chosen">
					<code>{chosen.sel}</code>
					<span>"{chosen.text.slice(0, 120)}"</span>
					<button onClick={() => onPick(url, chosen)}>Use this</button>
				</div>
			)}
		</div>
	);
}

type ApproveFn = (r: { id: string; approved: boolean }) => void;

function Message({ message: m, onApprove }: { message: UIMessage; onApprove: ApproveFn }) {
	return (
		<div className={`msg msg-${m.role}`}>
			{m.parts.map((part, i) => {
				if (part.type === "text") return <p key={i} className="text">{part.text}</p>;
				if (!isToolUIPart(part)) return null;
				const name = getToolName(part);
				const state = getToolPartState(part);
				const input = getToolInput(part) as Record<string, unknown> | undefined;
				const output = getToolOutput(part) as Record<string, unknown> | undefined;
				if (state === "waiting-approval") {
					const approval = getToolApproval(part);
					return (
						<div key={i} className="tool approval">
							<p><strong>{name === "save_watch" ? "Save this watch?" : name === "delete_watch" ? "Delete this watch?" : `Allow ${name}?`}</strong></p>
							<code>{JSON.stringify(input)}</code>
							{approval && (
								<div className="actions">
									<button onClick={() => onApprove({ id: approval.id, approved: true })}>Approve</button>
									<button className="ghost" onClick={() => onApprove({ id: approval.id, approved: false })}>Reject</button>
								</div>
							)}
						</div>
					);
				}
				if (name === "draft_watch" && state === "complete" && output) return <DraftCard key={i} draft={output} />;
				return (
					<div key={i} className="tool">
						<span className="pill">{name}</span> {state}
						{state === "error" && <span> -- {String((part as { errorText?: string }).errorText ?? "")}</span>}
					</div>
				);
			})}
		</div>
	);
}

function DraftCard({ draft }: { draft: Record<string, unknown> }) {
	if (draft.error) return <div className="tool draft bad">Draft refused: {String(draft.error)}</div>;
	const problems = (draft.problems as string[] | undefined) ?? [];
	return (
		<div className={`tool draft ${problems.length ? "bad" : ""}`}>
			<p><strong>Draft: {String(draft.name)}</strong> <code>{String(draft.cron)}</code></p>
			<p>{String(draft.explanation)}</p>
			<Values values={(draft.valuesNow as Record<string, unknown>) ?? {}} />
			<p>Right now: {draft.matchesNow === null ? "n/a" : draft.matchesNow ? "matches" : "does not match"} -- {String(draft.summaryNow ?? "")}</p>
			{problems.length > 0 && <ul className="problems">{problems.map((p, i) => <li key={i}>{p}</li>)}</ul>}
		</div>
	);
}

function safeHost(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

function ago(iso: string): string {
	const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
	if (s < 60) return `${s}s ago`;
	if (s < 3600) return `${Math.round(s / 60)}m ago`;
	if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
	return `${Math.round(s / 86_400)}d ago`;
}
