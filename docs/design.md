# hachiko

> **Tell it what to wait for. It waits at the station so you don't have to.**

A web page watcher you talk to. "Tell me when the sale price on <url>
drops under $300." "Tell me when the ISRO launch date on
https://lvg.shar.gov.in/VSCREGISTRATION/index.jsp changes and is still in
the future." A chat agent compiles the sentence into a **deterministic
watch**: CSS/XPath selectors, a typed coercion for each value, and a
small JS predicate. It saves that with a cron schedule. After that, no
model runs on the happy path: a scheduled check loads the page, reads
the values, and runs the predicate in a sandbox. When the site changes
its markup the watch notices, **heals itself**, and says so. It never
reports a broken selector as "condition not met".

Built on Cloudflare: Agents SDK (a Durable Object per user, which holds
the chat, the watch registry, and the cron schedules), Workflows (each
check is a durable observe -> evaluate -> heal -> record run), Browser
Run (rendering), Dynamic Workers (the sandbox), and Workers AI (the
orchestrator, the compiler, the healer).

**Status: poc** -- specced and built 2026-10-05. The contract is
[spec.md](spec.md), and [resources.md](resources.md) collects the
references. Setup and usage are in the [README](../README.md). The build
log, open questions, and graduation gate are at the bottom.

## Name

**`hachiko`** -- Hachiko, the Akita who met his owner's train at
Shibuya station every evening. When the owner died at work in 1925,
Hachiko kept meeting that train every day for almost ten years. That
is the product: a watcher that turns up on schedule, waits for one
specific thing, and never gives up on it. The scheduled visit is the
hop; "watch" and "loyal dog" are the same idea told two ways.

## The itch

Every page-watching tool sits at one of two bad ends:

1. **Diff the whole page** (Visualping, most changedetection.io setups).
   This is noisy. A rotating ad or a timestamp pages you, and "the price
   went *down*" cannot be said at all.
2. **Write the scraper yourself.** You can say exactly what you mean,
   until the site ships a redesign. Then the selector matches nothing,
   the script reads that as "not yet", and you miss the one event you
   cared about. **Silent failure is the default failure mode of every
   scraper.**

The gap: say the condition in English, get the precision of a
hand-written scraper, and have breakage be loud and mostly
self-repairing.

## Decisions

- **Compile once, run deterministically.** The model writes the spec at
  creation time and repairs it at heal time. Ordinary checks never call
  a model. So checks are cheap, reproducible, and auditable (every spec
  version is stored with the reason it exists).
- **Everything the model writes runs caged.** Selectors run in a remote
  Browser Run Chrome, never in our process. Regex patterns and the
  predicate run in a fresh Dynamic Worker with no network
  (`globalOutbound: null`), no bindings, a CPU cap, and a wall-clock
  race. On top of that sits a static AST check (no `fetch`, no
  `Date.now`, no `eval`), which gives early, readable errors. The
  isolate is the actual wall. See spec section 7.
- **Drift is never "no match".** There are four drift signals: the
  selector matches nothing, the selector errors, the value no longer
  coerces, or the *anchor* (a stable label next to the value) is gone.
  The anchor is what catches the nastiest failure, where a selector
  still matches but now points at the wrong element.
- **Heals are gated, not trusted.** The healer may move selectors only:
  names, types, the predicate, and the URL are the user's intent and
  are frozen. A proposed heal is accepted only if it reads every field
  on the live page, its anchors hold, and its values are plausible next
  to the last good ones (numbers within 10x, dates within 5 years).
  "Re-point the price at the shipping cost" fails twice: the anchor
  check and the 10x check.
- **Failed heals are loud.** They mark the watch `broken` and notify
  once. The heal budget is 3 per watch per day, so a site that
  thrashes cannot burn model calls forever.
- **One Durable Object per user** holds the chat, the registry
  (SQLite), and the cron schedules (`this.schedule`), and broadcasts
  state to the UI. **One Workflow per check**, so a browser hiccup
  retries the observation step without redoing anything, and a crash
  after a heal does not heal twice.
- **The picker uses a screenshot plus boxes, not an injected script.**
  Browser Run renders the page; the UI draws clickable element boxes
  over the screenshot. Third-party HTML never runs in our origin. This
  is the changedetection.io Visual Selector approach; see resources.md
  for why the open-source in-page pickers did not fit.
- **Auth: tier 1** (users plus per-device API tokens, invite-only) when
  this serves anyone but me. The poc has no auth: the
  agent instance is named `me`, and anyone who can reach the dev
  server can use it.

## Build log

2026-10-05: named, specced, built. Platform check against the current
Cloudflare docs (Agents 0.26, Browser Run, Dynamic Workers, Workflows,
Workers AI catalog). Dynamic Workers turned out to be the right sandbox:
`globalOutbound: null` plus `limits: { cpuMs, subRequests }` is exactly
the hard-limit primitive the brief asked for.

2026-10-05: poc built. 57 unit and integration tests
pass, including the in-page extractor and outline scripts against a
real Chromium. Fixture pages cover the redesign case: the old spec
reports `missing` (not "no match"), a heal onto the right element
passes every gate, and a heal onto the shipping cost is rejected by
both the anchor check and the plausibility check.

The tests caught two bugs before anything ran live:
- "Rs. 45,000" parsed as 0.45, because the number cleaner kept the dot
  after "Rs".
- The anchor context climbed to the largest small ancestor, so a
  sibling row's label could vouch for the wrong element. It now uses
  the nearest ancestor that says more than the element itself.

2026-10-05: verified end to end under `vite dev` (offline env, local
Chrome, local workerd), driven over the agent's WebSocket RPC and
through the UI with Playwright:
- A hand-written spec against books.toscrape.com read price 51.77 and
  stock 22.
- `createFromSpec` saved the watch and scheduled it, and its first
  Workflow run recorded `ok` and match true.
- The match notice landed in the inbox and in the chat.
- A second run did not re-notify (transition semantics).
- The picker rendered the page, hit-tested the price, and handed
  `p.price_color:nth-of-type(1)` to the composer.

The sandbox probes:
- `fetch` was rejected statically.
- A `constructor.constructor("return fetch")` escape died with "Code
  generation from strings disallowed".
- A never-settling promise was cut off.
- **A `while (true)` loop was not stopped locally.** Local workerd does
  not enforce the Dynamic Worker `cpuMs` cap, and the loop pinned a
  core until the dev server was killed. Production enforces `cpuMs`
  according to Cloudflare's docs. That is unverified here, and it is
  the first thing to check on deploy.

Live example.com had lost its `<h1>`, and the watch reported it as
`missing` drift. That is the right behavior, observed by accident.

**Not verified** (no Cloudflare credentials on this machine): every
model path (chat orchestration, `draft_watch` compile, heal proposals,
structured output on the chosen Workers AI models) and the deployed
`cpuMs` enforcement. The code for those paths typechecks against the
current SDK types, but has not run.

## Open questions

- **Model choice.** `@cf/moonshotai/kimi-k2.6` for the orchestrator
  (multi-turn tool calling) and `@cf/zai-org/glm-5.3` for compile and
  heal (structured output). Both are picked from the catalog, not
  measured. Both are vars in `wrangler.jsonc`, so swapping is a config
  change.
- **Pages behind bot walls.** Browser Run identifies itself as a bot.
  Some retail sites will serve a challenge page, which shows up as
  drift (good, loud) but can never heal (bad, permanent). Maybe classify
  "challenge page" as its own outcome.
- **Notification channels.** Today there is an in-app inbox, the chat,
  and one optional Discord-compatible webhook. Email via the Agents
  email channel, or push, are the obvious next ones.
- **Offline chat hangs.** Without the AI binding, a chat turn throws
  server-side and the UI shows "..." forever. It would be better to
  surface the error.
- **Run history.** 200 runs per watch is plenty for a poc. Long-lived
  watches will want rollups.

## Graduation gate

Deploy it, point three real watches at three real sites (one retail
price, one government page, one that changes often), and leave them
for two weeks. It graduates if no real event is missed, at least one
heal happens and is correct, and every breakage that does not heal is
reported rather than silent. It dies if heals are wrong more often
than right.
