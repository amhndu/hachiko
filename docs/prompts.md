* Here's an idea for a project: "AI-based scraper / scheduler". e.g. I want to know when a launch is scheduled for ISRO so I can get a pass and visit.
* It must be done using the following:

    LLM (recommend using Llama 3.3 on Workers AI), or an external LLM of your choice
    Workflow / coordination (recommend using Workflows, Workers or Durable Objects)
    User input via chat or voice (recommend using Pages or Realtime)
    Memory or state

* can I use the cloudflare scraper product in this?

* can I make it so that the scraping can be either / both an LLM-based derivation or based on deterministic extraction logic derived during user query 

* can all of this be built for free? 

* what is the deployment methodology? Can I use gitops or docker images?

* is there an open-source component that a user can use on the Pages to manually select an element and direct the agent? 

-----

* I want to build a project that lets users create and schedule arbitrary webpage watchers. 
Users will submit queries related to their watches (CRUD) on a chatbox that will be interpreted by an orchestrator LLM agent.
Watches can be arbitrary including arbitrary condition ("notify me when product X has a sale price less than Y", "notify me when the ISRO rocket launch date on https://lvg.shar.gov.in/VSCREGISTRATION/index.jsp is updated and is in the future").
These conditions must be simple and hard-limits must be placed on the sandbox executing them.
Convert and compile the user intent into a deterministic query including CSS selectors, DOM selectors, and a combination of JS code. Save as a durable watch and cron. 
Use Cloudflare's scraper product for this. Watchers must be self-healing so that if the upstream changes format, we don't silently fail.
The user experience will also include a simple UI to see / manage existing watches. 
Users should also be able to select a component on a web page to steer the agent. Search for open-source components that can do this. This is optional, if the research doesn't bring up good options, we can put this off. Research when the other core requirements are satisfied.
Use Cloudflare Workflows, Workers or Durable Objects, Workers AI
reference: https://developers.cloudflare.com/agents/

* ensure text and code is readable. 

* For typescript:
  - Explicit typing over inference; avoid `any` (use `unknown`).
  - `const` over `let`, never `var`.
  - Named exports only.
  - Template literals over string concatenation.
  - `for-of` over `.forEach`.
  - Validate inputs early, throw immediately with clear errors; don't add
    defensive handling for scenarios that can't happen.


* use pnpm

* make sure user conditions are evaluated in a sandbox and ensure limits are enforced on it
