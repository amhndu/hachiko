# hachiko -- spec

What hachiko does, stated as rules a test could check. The
[design notes](design.md) are the why; this is the contract. Where they
disagree, this file wins and the README gets fixed.

Checked against the code on 2026-10-05. Paths below are relative to
`src/server/`. Section 15 lists what has not run yet.

## 1. Parts

| part | Cloudflare primitive | file |
| --- | --- | --- |
| Worker entry: routes `/agents/*`, serves the UI | Worker + static assets | `index.ts` |
| `Hachiko`: one per user; chat, registry, schedules, notifications | Agents SDK `AIChatAgent` (Durable Object, SQLite) | `agent.ts` |
| `CheckWorkflow`: one per check | Workflows via `AgentWorkflow` | `workflow.ts` |
| Rendering and extraction | Browser Run binding + `@cloudflare/puppeteer` | `browse.ts`, `inpage.ts` |
| Coercion and condition | plain Worker code, no binding | `coerce.ts`, `condition.ts`, `evaluate.ts` |
| Orchestrator, compiler, healer | Workers AI via `agents/models/ai-sdk` | `agent.ts`, `compile.ts` |

## 2. The watch spec

The compiled, deterministic artifact. Schema: `spec.ts` `WatchSpecSchema`.

```jsonc
{
  "url": "https://...",                  // http(s), public host (section 6)
  "waitFor": "#price",                   // optional; awaited up to 10s, never fatal
  "fields": [{                           // 1..8
    "name": "price",                     // identifier, unique in the spec
    "description": "the sale price",     // words; what the healer re-finds
    "selector": "#sale-price",           // CSS, or "xpath:<expr>"
    "attr": "content",                   // optional: read an attribute, not text
    "type": "number",                    // text | number | date | exists
    "after": "Sale price:",              // optional literal marker: keep what follows
    "before": "(",                       // optional literal marker: keep what precedes
    "dateOrder": "dmy",                  // optional: dmy | mdy | ymd
    "all": false,                        // optional: list of every match
    "required": true,                    // default true
    "anchor": "Sale price"               // optional: label text next to the value
  }],
  "condition": {                         // data, not code (section 7)
    "mode": "all",                       // all | any
    "clauses": [                         // 1..8
      { "left": { "kind": "field", "name": "price" }, "op": "lt",
        "right": { "kind": "value", "value": 300 } }
    ]
  },
  "summary": "Sale price is {price} (was {prev.price})",  // placeholders only
  "notifyOn": "transition"               // transition | every-match
}
```

- **Coercion** (`coerce.ts`). Fully declarative: every regex in it is
  fixed and ours.
  - `after` / `before` cut the text at literal markers
    (case-insensitive). A missing `after` marker is a coercion failure; a
    missing `before` marker is ignored.
  - `number` takes the first numeric run ("In stock (22 available)" is
    22, "Rs. 45,000" is 45000) and handles both `1,299.50` and
    `1.299,50`.
  - `date` produces `YYYY-MM-DD` (or `YYYY-MM-DDTHH:MM:00Z` when a time
    is present) from the first date in the text. It accepts ISO dates,
    numeric dates (it needs
    `dateOrder` unless one side is over 12, and refuses ambiguous ones),
    and month names. Impossible dates are rejected.
  - `exists` is `count > 0` and never fails.
  - `text` is whitespace-collapsed.
  - `all` keeps the matches that coerce.
- **The condition** (`condition.ts`) is evaluated only when every
  required field coerced; otherwise there is no result and the run is
  drift (section 5). Section 7 has the language.
- **The summary** is a template with `{field}`, `{prev.field}` and
  `{today}` placeholders and nothing else. Missing values render as
  `n/a`; the result is cut to 280 chars.
- **Determinism.** Given the same page DOM, the same `prev`, and the same
  `now`, a check produces the same values and the same result. The only
  clock is `now`, the check's start time, fixed once per run.

## 3. Compiling (intent to spec)

`check.ts` `draftWatch`, and `compile.ts` `compileSpec`.

1. The URL passes `checkUrl` and the cron passes `checkCron`, before
   any browser or model work happens.
2. Browser Run loads the page; `OUTLINE_SRC` produces the outline.
   - The outline lists data-bearing meta tags (`og:*`, `product:*`,
     `itemprop`, `description`), then every *visible* element with its
     own text, up to 300 items and 16k chars (sized for the free
     Workers AI neuron budget).
   - Each element comes with a selector that was unique on the live page
     when captured. It prefers ids, `data-testid`, `data-test`, and
     `itemprop`, and skips hashed CSS-in-JS classes (`css-*`, `sc-*`,
     hex runs).
3. The compiler model gets the spec rules, the user's intent, the
   outline, and an optional picked-element hint. It returns
   `{ name, spec, explanation }` as structured output (zod schema).
4. Then `validateSpec`, then a **dry run**: observe and evaluate against
   the live page (section 4).
5. If the dry run reports any problem, the compiler gets one retry, with
   the problems and the values it read fed back.
6. The result is a **draft**: stored in `drafts` for 24h with its
   preview (values, result, problems). A draft with problems **cannot
   be saved** (`saveDraft` refuses it).

## 4. A check

`workflow.ts` `CheckWorkflow`. Each I/O stage is one durable step.

| step | does | retries |
| --- | --- | --- |
| `clock` | fixes `ctx.now` for the run | -- |
| `observe` | Browser Run: load the page, run `EXTRACT_SRC` with the spec's fields | 2, 15s exponential, 2 min timeout |
| (evaluate) | not a step: `evaluate.ts` coerces, evaluates the condition, and runs `assess` for drift. Pure, so a replay recomputes the same answer | -- |
| `heal` | only on drift, and only with budget left (section 5) | 1, 5 min timeout |
| `record` | `Hachiko.recordRun(report)`, the only writer of run results | default |

- **Outcomes:**
  - `ok`: no problems and a result.
  - `healed`: drift was fixed, then a result.
  - `broken`: drift that did not heal. (A condition cannot fail at run
    time: it is type-checked against the fields on save.)
  - `error`: navigation, HTTP 4xx/5xx, or an exception.
- **`EXTRACT_SRC` per field returns `{ count, items: [{ text, attr,
  context }] }`**, up to 20 items of 500 chars each. A selector that
  throws yields `{ error: "selector error: ..." }`.
  - `context` is the text of the **nearest** ancestor (up to 4 levels,
    at most 400 chars) that says more than the element itself. It is
    nearest, not largest, so a sibling row's label cannot vouch for
    this element.
- **Concurrency.** A watch with a check started in the last 15 minutes
  skips new ticks. A run that reports against a superseded spec version
  is recorded but does not move the watch's state.
- Images, fonts, and media are blocked during checks. The viewport is
  1280x900. Navigation waits for `networkidle2`, with a 30s timeout.

## 5. Drift and healing

`health.ts`, and `check.ts` `heal`.

- **Drift kinds**, per field:
  - `missing`: a required field matched nothing. `exists` fields are
    exempt, since 0 is their value.
  - `selector-error`: the selector threw.
  - `anchor-lost`: `anchor` is set and is not in `context`
    (case-insensitive).
  - `unparseable`: a required field did not coerce.
- **Drift never produces `match: false`.** With drift present, the
  condition does not run on a required-field failure, and the outcome
  is `healed` or `broken`, never `ok`.
- **Heal procedure:** one browser session, a fresh outline, then up to
  2 proposals. Each proposal is a patch of `selector`, `attr`, `after`,
  `before`, `anchor`, and `dateOrder`, for the drifted fields only.
  `name`, `type`, `description`, `condition`, `summary`, `url`, and
  `notifyOn` are frozen.
- **A proposal is accepted only if all of these hold on the live page:**
  - `validateSpec` passes;
  - every field reads, every anchor holds, every value coerces;
  - the condition produces a result;
  - every healed value is plausible against the last good value:
    numbers within 10x, dates within 5 years of `now`, text non-empty.
- A rejected proposal is fed back to the next attempt with its reasons.
- **Budget:** 3 healed runs per watch per rolling 24h. With no budget
  left, drift goes straight to `broken`.
- **Versions:** an accepted heal writes spec version N+1 with reason
  `healed: <note>`. Every version is kept: created, edited, healed.

## 6. Hard limits

All of these live in `limits.ts`; change it and this table together.
They are sized for the **Workers Free plan**: Browser Run's 10
browser-minutes a day is the binding quota (a check costs roughly 3-5 s),
then Workers AI's 10,000 neurons a day.

| limit | value |
| --- | --- |
| watches per user | 5 |
| fields per spec | 8 |
| selector / marker / anchor length | 300 / 80 / 80 |
| condition | 8 clauses; string literals up to 200 chars |
| summary template / rendered summary | 200 / 280 chars |
| navigation / waitFor timeout | 30 s / 10 s |
| text per matched element / matches per field | 500 chars / 20 |
| outline | 300 items, 16k chars |
| minimum schedule interval | 60 min, checked over the next 50 cron fires |
| heal attempts per run / heals per day | 2 / 3 |
| errors in a row before notifying | 3 |
| runs kept per watch | 200 |
| draft lifetime | 24 h |
| picker | 3000 px tall, 1500 boxes |

- **URLs** (`checkUrl`): http(s) only, no credentials, no localhost,
  `.local`, `.internal`, RFC 1918, link-local, or IP-literal IPv6
  hosts. The browser runs on Cloudflare, so this is about intent, not
  reachability.
- **Cron** is UTC. If any gap between the next 50 fires is under 60
  minutes, the cron is rejected; that catches bursts like
  `0,30 9 * * *`.

## 7. The condition language

`condition.ts`. A condition is data, evaluated by a small interpreter.
Nothing model-written is compiled or executed anywhere in hachiko; the
only model output that reaches a runtime is selectors, which run in
Browser Run's remote Chrome.

- **Shape:** `{ mode: "all" | "any", clauses: Clause[] }`, 1 to 8
  clauses, one level deep. A clause is `{ left, op, right? }`.
- **Operands:**

  | operand | value |
  | --- | --- |
  | `{ kind: "field", name, agg? }` | the field's coerced value now |
  | `{ kind: "prev", name, agg? }` | its value on the last ok run; null on the first run |
  | `{ kind: "value", value }` | a literal number, boolean, or string (200 chars max); `YYYY-MM-DD` strings are dates |
  | `{ kind: "today", offsetDays? }` | today's UTC date from `now`, optionally shifted |

  `agg` (`first`, `min`, `max`, `count`) turns a list field
  (`all: true`) into one value, and is rejected on scalars.
- **Operators:**
  - `lt`, `lte`, `gt`, `gte`: two numbers, or two dates (compared by
    instant).
  - `eq`, `ne`: two values of the same type. Text is compared
    case-insensitively.
  - `contains`, `not_contains`: a text field (or text list) against a
    text value, case-insensitive.
  - `changed`: one field operand. True when the value differs from the
    last ok run; false on the first run.
  - `exists`, `missing`: one field operand. Non-null or null.
- **Checked on save** (`checkCondition`, called by `validateSpec`):
  unknown fields, type mismatches, a missing or extra right operand,
  `agg` on scalars, lists without `agg`, and `changed` on anything but
  a field. Each problem is a sentence the compiler can act on, so a
  condition that saves cannot fail at run time.
- **At run time:** a null operand satisfies no comparison (an absent
  optional field never makes a condition true by accident); only
  `missing` is true for it.
- **Bounded:** evaluation is one pass over at most 8 clauses with fixed
  operators. There are no loops, calls, regexes, or recursion, so no
  input can make it run long. This interpreter is what the brief calls
  the sandbox, and the limits are structural.

## 8. Scheduling

- A saved watch gets `this.schedule(cron, "tick", { watchId })`. That
  schedule is persisted in the agent's SQLite and survives restarts and
  deploys.
- `tick` calls `startCheck`, which snapshots the current spec version,
  `prev`, `lastMatch`, and the heal budget into the Workflow params.
- **Saving runs the first check immediately**, so `ctx.prev` has a
  baseline before the first scheduled fire.
- Pausing cancels the schedule; resuming re-creates it. Rescheduling
  cancels the old schedule and creates a new one. Deleting cancels the
  schedule and removes the watch, its versions, runs, and notices.

## 9. Notifications

`Hachiko.notify`. Each notification goes to three places: the
`notices` table (the inbox, capped at 50), an assistant message
appended to the chat (`persistMessages`, which does not trigger a model
turn), and `NOTIFY_WEBHOOK_URL` if set (a Discord-style `{ content }`
body).

| kind | when |
| --- | --- |
| `match` | `ok` or `healed` with `match: true`, and either `notifyOn: every-match` or the previous state was not a match |
| `healed` | every accepted heal, naming the new version and the healer's note |
| `broken` | on the transition into `broken`, once |
| `error` | when the error streak reaches 3, once (health becomes `error` from 3 on) |

## 10. Chat orchestrator

`Hachiko.onChatMessage`. The model is `ORCHESTRATOR_MODEL`, with up to
8 tool steps per turn. It never writes selectors or code itself.

| tool | approval | does |
| --- | --- | --- |
| `list_watches` | -- | summaries from state |
| `inspect_page` | -- | outline of a URL (12k chars) |
| `draft_watch` | -- | section 3; `replaceWatchId` for edits; `hint` for picked elements |
| `save_watch` | **user** | draft to watch (or a new version of `replaceWatchId`) |
| `update_watch` | -- | rename, reschedule, pause, resume |
| `delete_watch` | **user** | section 8 |
| `run_watch_now` | -- | `startCheck(manual)` |
| `watch_history` | -- | versions and the last 30 runs |

An edit through `draft_watch` + `save_watch` writes a new version with
reason `edited: <intent>`, and clears `prev` and the match state,
because those belonged to the old question.

## 11. UI

A Vite + React single page, synced over the agent WebSocket (`useAgent`
state plus `@callable` RPC).

- **Watch cards** show health (`new`, `ok`, `healed`, `broken`,
  `error`), paused, checking, and match; the last summary and values;
  the schedule, last run, last ok, and version; and buttons for Run
  now, Pause/Resume, Details, and Delete.
- **Details** show the intent, the fields table (selector and anchor
  per field), the condition (read back as one line) and summary
  template, the version history, and recent runs with
  their problems.
- **The chat** renders approvals as Approve/Reject, and `draft_watch`
  results as a draft card (values read now, match now, problems).
- **The inbox** shows the last 5 notices, with "Dismiss all".
- **Manual path** (callables, not yet in the UI): `testSpec(spec)` dry
  runs a hand-written spec, and `createFromSpec({ name, intent, cron,
  spec })` saves one if its dry run is clean. These are the escape
  hatch when the model is wrong or unavailable.

## 12. Picker

`snapshot(url)` callable, `BOXES_SRC`, and `Picker` in `App.tsx`.

- Browser Run loads the page with images allowed, captures a JPEG of the
  top 3000 px, and lists up to 1500 boxes: elements with 1..300 chars of
  visible text, each with a unique selector and page coordinates.
- The UI draws the screenshot and hit-tests the **smallest** box under
  the cursor, so the user can pick a value or its container.
- "Use this" appends
  `[picked element on <url>: selector <sel>, text "<text>"]` to the chat
  composer. The orchestrator passes that to `draft_watch` as `hint`.
- The third-party page never loads in the user's browser or in our
  origin.

## 13. Storage

The agent's SQLite. Tables: `watches`, `watch_versions` (spec JSON plus
reason), `runs`, `drafts`, and `notices`. The chat history is the
AI-chat agent's own, with at most 200 messages persisted. UI state is
derived from SQLite on every change (`refresh`). Nothing is kept
outside the Durable Object.

## 14. Auth

The poc has none: the client connects to the instance named `me`. When
it serves anyone else it needs auth (users plus per-device API
tokens, invite-only, no roles), with one `Hachiko` instance
per user id, never per a name the client chooses.

## 15. Not verified yet

- Every model call: orchestration, compile, heal, and structured output
  on `glm-4.7-flash` and `llama-3.3-70b-instruct-fp8-fast`. The code
  typechecks against `ai@7` / `agents@0.26` but has not run (the poc
  was built without Cloudflare credentials). Llama 3.3 is on Workers
  AI's JSON-mode list; whether the AI SDK provider requests JSON mode
  for it is unconfirmed.
- **The Free plan's 10 ms CPU limit** per invocation and per Workflow
  step. Checks are I/O-bound and evaluation is tiny, but chat turns, the
  picker screenshot (a ~300 KB base64 string), and zod parsing of large
  outlines have not been profiled on a deployed Free account.
- Browser Run in production. Locally, the binding drove the machine's
  Chrome.
