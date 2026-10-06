# hachiko

> Tell it what to wait for. It waits at the station so you don't have to.

hachiko is a web page watcher you talk to. You type something like
"tell me when the sale price on https://... drops under $300", and a
chat agent compiles that sentence into a **deterministic watch**: CSS
or XPath selectors, a type for each value, and a small JS condition. It
saves the watch with a cron schedule.

After that, routine checks never call a model. A scheduled check loads
the page, reads the values, and runs the condition in a sandbox.

When a site changes its markup, the watch notices and tries to **heal
itself** by finding the moved values again. If it cannot, it reports
itself broken. A broken selector is never reported as "condition not
met".

Status: **proof of concept**. See [What has and has not been
verified](#what-has-and-has-not-been-verified) before relying on it.

## How it works

| piece | Cloudflare product | does |
| --- | --- | --- |
| `Hachiko` agent | Agents SDK (a Durable Object with SQLite) | one per user: the chat, the watch registry, cron schedules, notifications, and UI state |
| `CheckWorkflow` | Workflows | one per check: observe, evaluate, heal, record, each a retryable durable step |
| rendering | Browser Run | loads pages, reads selectors, captures screenshots for the picker |
| sandbox | Dynamic Workers | runs the generated condition and regexes with no network, no bindings, and a CPU cap |
| models | Workers AI | the chat orchestrator, the compiler (sentence to spec), the healer (moves broken selectors) |

The design is written up in [docs/design.md](docs/design.md). The full
contract is [docs/spec.md](docs/spec.md): the spec format, the check
pipeline, drift detection, heal gates, every hard limit, and the
sandbox. References and prior art are in
[docs/resources.md](docs/resources.md).

## Requirements

- Node.js 20 or newer (developed on Node 24).
- A Cloudflare account on the **Workers Paid** plan. Dynamic Workers,
  the sandbox, are only available on Paid.
- To run the browser tests, Chromium or Chrome installed locally.

## Setup

```sh
npm install
npx wrangler login        # or set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (below)
```

## Usage

```sh
npm run dev               # full app at http://localhost:5173 (needs Cloudflare auth for Workers AI)
CLOUDFLARE_ENV=offline npm run dev   # everything except the models, no Cloudflare auth needed
npm test                  # unit tests, plus the in-page scripts against a real Chromium
npm run typecheck
npm run deploy            # build, then wrangler deploy
npm run types             # regenerate worker-configuration.d.ts after editing wrangler.jsonc
```

In the UI:

- **Create a watch:** ask in the chat, eg "tell me when the price on
  https://... is under $50, check every hour". The agent compiles the
  request, dry-runs it against the live page, and shows a draft with
  the values it read. Approve the save in the chat.
- **Steer with the picker:** click **Pick**, load a URL, click the
  element you mean, then **Use this**. The selector and text are added
  to your message as a hint.
- **Manage watches:** each card has Run now, Pause/Resume, Details
  (selectors, condition, version history, recent runs), and Delete.
  You can also ask the chat to rename, reschedule, pause, or change
  what a watch checks.
- **Notifications** appear in the inbox at the top, in the chat, and at
  `NOTIFY_WEBHOOK_URL` if you set one.

Schedules are cron, **in UTC**, with a minimum interval of 15 minutes.

### Offline mode

`CLOUDFLARE_ENV=offline` selects the `offline` environment in
`wrangler.jsonc`. It has every binding except Workers AI, which has no
local emulation. Browser Run drives your local Chrome, and Dynamic
Workers and Workflows run in local workerd.

The chat cannot answer in this mode, but the model-free path works over
the agent's RPC:

- `testSpec(spec)` dry-runs a hand-written spec against the live page.
- `createFromSpec({ name, intent, cron, spec })` saves and schedules a
  hand-written spec, if its dry run is clean.

## Environment variables and bindings

### Runtime (the Worker)

| name | kind | required | default | purpose |
| --- | --- | --- | --- | --- |
| `ORCHESTRATOR_MODEL` | var (`wrangler.jsonc`) | yes | `@cf/moonshotai/kimi-k2.6` | Workers AI model for the chat agent; needs multi-turn tool calling |
| `COMPILER_MODEL` | var (`wrangler.jsonc`) | yes | `@cf/zai-org/glm-5.3` | Workers AI model that compiles and heals specs; needs structured output |
| `NOTIFY_WEBHOOK_URL` | secret | no | unset | Discord-compatible webhook for notifications; receives `{ "content": "..." }` |

Bindings, all declared in `wrangler.jsonc` (nothing to create by hand):

| binding | type | purpose |
| --- | --- | --- |
| `AI` | Workers AI | model calls |
| `BROWSER` | Browser Run | page rendering |
| `LOADER` | Worker Loader | the Dynamic Worker sandbox |
| `Hachiko` | Durable Object | the per-user agent |
| `CHECK_WORKFLOW` | Workflow | scheduled checks |

Set the webhook locally by copying `.dev.vars.example` to `.dev.vars`
(gitignored). In production, set it as a secret:

```sh
npx wrangler secret put NOTIFY_WEBHOOK_URL
```

### Tooling (your shell or CI)

| name | needed for | purpose |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | `npm run dev` without `wrangler login`; `npm run deploy` in CI | authenticates wrangler. The token needs permission to edit Workers and use Workers AI and Browser Run on the account. |
| `CLOUDFLARE_ACCOUNT_ID` | same | the account to use when the token can see more than one |
| `CLOUDFLARE_ENV` | optional | `offline` selects the no-models environment |
| `CHROMIUM_PATH` | optional, tests | path to Chromium for `npm test` (default `/usr/bin/chromium`); the browser tests are skipped if it is missing |

## Hard limits

These are enforced in `src/server/limits.ts`; the full table is in
[docs/spec.md](docs/spec.md#6-hard-limits).

- 25 watches per user, 8 fields per watch.
- Conditions are at most 2000 chars.
- Each sandbox run gets 50 ms of CPU, a 2 s wall clock, and no network.
- The minimum schedule interval is 15 min.
- At most 2 heal attempts per run and 3 heals per watch per day.

## What has and has not been verified

**Verified locally**, in offline mode against a live site:

- extraction, coercion, and the sandbox;
- a watch saving, scheduling, and running through the Workflow;
- notifications, including no repeat on a second match;
- the picker.

In the sandbox, `fetch` and an eval-style escape are blocked, and a
promise that never resolves is cut off.

**Not verified yet:**

- Every model path: chat, compiling, and healing. That code typechecks
  but has not run.
- The sandbox CPU cap. The local runtime does not enforce `cpuMs`: a
  `while (true)` condition pinned a core under `vite dev`. Cloudflare's
  docs say production enforces it. Check this on the first deploy,
  before anyone else uses it.

## Auth

None yet. The UI connects to a single agent instance named `me`, so
anyone who can reach a deployment can use it. Put it behind Cloudflare
Access, or add auth, before deploying it anywhere public.

## Layout

```
src/server/   agent, workflow, browser, sandbox, compiler, limits
src/client/   React UI (Vite)
test/         vitest unit tests and HTML fixtures
docs/         design notes, spec, references
```
