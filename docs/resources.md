# hachiko -- resources

Every link says *why it's here*. An uncaptioned link is a bookmark,
ie lost.

## Platform (read 2026-10-05)

- **https://developers.cloudflare.com/agents/** -- the brief's
  reference. The Agent class is a Durable Object with SQLite
  (`this.sql`), synced state (`setState`), `@callable` RPC, and
  `this.schedule(cron, ...)`. That one class is the registry, the
  scheduler, and the chat. The page's `llms.txt` lists every doc as
  raw markdown, which is the fast way to read it.
- **https://developers.cloudflare.com/agents/runtime/execution/run-workflows/**
  -- `AgentWorkflow` and `this.runWorkflow`. A workflow's `this.agent`
  is an RPC stub back to the originating agent, which is how
  `recordRun` gets called. Note: `terminate()` and `pause()` do not
  work under `wrangler dev`.
- **https://developers.cloudflare.com/agents/runtime/execution/schedule-tasks/**
  -- cron schedules are idempotent on (cron, callback, payload) and
  persisted, so they survive restarts.
- **https://developers.cloudflare.com/agents/communication-channels/chat/chat-agents/**
  -- `AIChatAgent`, `useAgentChat`, `needsApproval` tools, and
  `persistMessages` (which injects a message without a model turn; this
  is how notifications reach the chat).
- **https://developers.cloudflare.com/agents/models/ai-sdk/** --
  `createAI` from `agents/models/ai-sdk` (beta). Its
  `languageModel(id)` takes an id string from config.
- **https://developers.cloudflare.com/dynamic-workers/** -- the
  sandbox. `globalOutbound: null` cuts the network, and
  `limits: { cpuMs, subRequests }` (the usage/limits page) is the hard
  cap. `get(id, cb)` caches by id, so the id is a hash of the predicate.
  A Durable Object can have 10 distinct Dynamic Workers in flight.
- **https://developers.cloudflare.com/browser-run/** -- what used to
  be called Browser Rendering. It offers Quick Actions (`/scrape`,
  `/content`, `/json`) and Puppeteer/Playwright sessions. Picked
  Puppeteer over `/scrape` because a check needs the extract, the
  outline, and the screenshot in one session, plus `waitFor`. Pricing:
  10 browser-hours a month on Paid, then $0.09/h. That cost is why the
  minimum interval is 15 min and images are blocked during checks.
- **https://developers.cloudflare.com/browser-run/reference/browser-binding-api/**
  -- the `browser` binding. Under `vite dev` with `remote: false` it
  drives a local Chrome.
- **https://developers.cloudflare.com/workers-ai/models/** -- where
  `kimi-k2.6` (multi-turn tool calling, 262k context) and `glm-5.3`
  (structured output, function calling) came from. They were picked
  from the catalog, not benchmarked.

## Prior art

- **https://github.com/dgtlmoon/changedetection.io** -- the big
  open-source watcher. It has per-watch CSS/XPath filters, "restock"
  and price-threshold processors, and the Visual Selector. It has no
  natural-language compile and no self-healing: a filter that stops
  matching is reported as a change or as an error, depending on
  settings. hachiko's whole pitch is that gap.
- **https://mintlify.wiki/dgtlmoon/changedetection.io/features/visual-selector**
  -- how their Visual Selector works: the server renders the page,
  captures a screenshot plus element positions, and the UI lets you
  click boxes. hachiko's picker copies the shape (section 12 of the
  spec), because Browser Run gives the same two outputs.
- Visualping, Distill.io -- the hosted whole-page differs. Noisy by
  construction; you cannot say "price went *down*".

## Element pickers (researched 2026-10-05, for the optional steering feature)

All of these run *inside* the target page's DOM. That needs either a
browser extension or the third-party page proxied into our origin, and
a cross-origin iframe cannot be scripted at all. That is why the poc
uses screenshot + boxes instead. They stay here for an
extension-based picker later.

- **https://github.com/usertour/openpicker** -- the most complete: a
  browser extension plus a small SDK, a hover highlight, an editable
  selector, a DOM tree, and a live match count. The best base if
  hachiko ever ships an extension ("watch this" from any tab).
- **https://github.com/hmarr/pick-dom-element** -- a small TypeScript
  `ElementPicker` with onHover/onClick callbacks. Good for a
  bookmarklet.
- **https://github.com/jamesbechet/element-picker** -- vanilla JS
  hover-and-click. Minimal.
- **https://www.npmjs.com/package/html-element-picker** -- vanilla,
  configurable highlight.
- **https://github.com/fczbkk/css-selector-generator** -- a unique
  selector for an element, including shadow DOM. Worth swapping in for
  `inpage.ts`'s hand-rolled `cssPath` if shadow-DOM sites show up; it
  would need bundling into a string for `page.evaluate`.
