# hachiko

Lets users create and schedule arbitrary webpage watchers.

Users submit queries related to their watches (CRUD) on a chatbox that is interpreted by an orchestrator LLM agent.

Watches can be arbitrary, including arbitrary conditions ("notify me when product X has a sale price less than Y", "notify me when the ISRO rocket launch date on https://lvg.shar.gov.in/VSCREGISTRATION/index.jsp is updated and is in the future").

## How it works

The user intent is converted and compiled into a deterministic query including CSS selectors, DOM selectors (XPath), and a combination of JS code. It is saved as a durable watch and cron.

After that, routine checks never call a model. A scheduled check loads the page, reads the values, and runs the condition in a sandbox.

Conditions must be simple and hard-limits are placed on the sandbox executing them.

Watchers are self-healing, so if the upstream changes format, we don't silently fail. A check notices the change and tries to find the moved values again. If it can't, it reports itself broken. A broken selector is never reported as "condition not met".

The user experience includes a simple UI to see / manage existing watches. Users can also select a component on a web page to steer the agent.

## Stack

| piece | Cloudflare product | does |
| --- | --- | --- |
| `Hachiko` agent | Durable Objects (Agents SDK) | per-user chat, watch registry, cron, notifications |
| `CheckWorkflow` | Workflows | one durable, retryable run per check: observe, evaluate, heal, record |
| scraper | Browser Run | loads pages, reads selectors, screenshots for the picker |
| sandbox | Dynamic Workers | runs the generated condition, no network, CPU cap |
| models | Workers AI | orchestrator, compiler (sentence to spec), healer |

More in [docs/design.md](docs/design.md), [docs/spec.md](docs/spec.md) and [docs/resources.md](docs/resources.md).

## Hard limits

Enforced in `src/server/limits.ts`:

- 25 watches per user, 8 fields per watch
- Conditions are at most 2000 chars
- Sandbox: 50 ms CPU, 2 s wall clock, no network
- Minimum schedule interval is 15 min, cron is in UTC
- At most 2 heal attempts per run, 3 heals per watch per day

## Setup

Needs Node.js 20+, pnpm, and a Cloudflare account on the **Workers Paid** plan (Dynamic Workers). Chromium is only needed for the browser tests.

```sh
pnpm install
pnpm approve-builds              # allow esbuild/workerd install scripts if prompted
pnpm exec wrangler login         # or set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID
```

## Usage

```sh
pnpm dev                              # http://localhost:5173 (needs Cloudflare auth for Workers AI)
CLOUDFLARE_ENV=offline pnpm dev       # everything except the models, no auth needed
pnpm test
pnpm typecheck
pnpm run deploy                       # not `pnpm deploy`, that's a pnpm built-in
pnpm types                            # after editing wrangler.jsonc
```

- **Create a watch:** ask in the chat. The agent compiles it, dry-runs it against the live page, and shows a draft to approve.
- **Steer with the picker:** click **Pick**, load a URL, click the element, then **Use this**.
- **Manage:** Run now, Pause/Resume, Details, Delete on each card, or ask the chat.
- **Notifications** go to the inbox, the chat, and `NOTIFY_WEBHOOK_URL` if set.

Offline mode has no chat, but `testSpec(spec)` and `createFromSpec({ name, intent, cron, spec })` work over the agent's RPC with a hand-written spec.

## Config

| name | where | default |
| --- | --- | --- |
| `ORCHESTRATOR_MODEL` | `wrangler.jsonc` var | `@cf/moonshotai/kimi-k2.6` (needs multi-turn tool calling) |
| `COMPILER_MODEL` | `wrangler.jsonc` var | `@cf/zai-org/glm-5.3` (needs structured output) |
| `NOTIFY_WEBHOOK_URL` | secret | unset, Discord-compatible, gets `{ "content": "..." }` |
| `CLOUDFLARE_ENV` | shell | `offline` skips models |
| `CHROMIUM_PATH` | shell | `/usr/bin/chromium`, browser tests skip if missing |

Locally, copy `.dev.vars.example` to `.dev.vars`. In production: `pnpm exec wrangler secret put NOTIFY_WEBHOOK_URL`.

None yet. The UI connects to a single agent instance named `me`, so anyone who can reach a deployment can use it. Put it behind Cloudflare Access, or add auth, before deploying publicly.

## Layout

```
src/server/   agent, workflow, browser, sandbox, compiler, limits
src/client/   React UI (Vite)
test/         vitest unit tests and HTML fixtures
docs/         design notes, spec, references
```
