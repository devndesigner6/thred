# Thred + Mozaik implementation plan

## Goal
Turn Thred from a shared-memory product into a working collaborative-agent runtime for the JigJoy hackathon. A user submits one goal; three specialized Mozaik agents run concurrently, use tools to read/write Thred memory, and return evidence plus a final synthesis.

## Implementation
- Add `@mozaik-ai/core` to the API workspace.
- Add `apps/api/src/mozaik-orchestrator.ts` using the installed Mozaik v4 beta APIs: `defineRuntime` for a shared space, `defineAgentModule` for agents and loops, `createParticipant`/`join`/`sendMessage` for runtime membership and a human kickoff, and parallel `runLoop` calls for genuine concurrency.
- Provide each agent with Thred tools for reading HydraDB memory, writing durable findings, reading the shared run board, and publishing a finding. Tools are invoked inside Mozaik loops, not simulated in the UI.
- Keep a bounded in-process map for low-latency live status, persist Mozaik runs, events, and findings in PostgreSQL for restart-safe history, and persist durable findings to HydraDB when `HYDRA_DB_API_KEY` is available. Return a clear run error when the configured model credentials are missing.
- Request strict role-specific JSON briefs from each agent and expose the structured output beside the human-readable answer.
- Add a dashboard view that starts a multi-agent run and polls the backend status, showing live agent states, findings, shared-memory writes, and final synthesis.
- Keep the existing Clerk, Vercel, Render, Prisma, and MCP flows intact.

## Project structure
- `apps/api/src/mozaik-orchestrator.ts`: Mozaik runtime, agent tools, concurrent execution, status aggregation.
- `apps/api/src/index.ts`: authenticated workspace routes for starting and reading runs.
- `apps/frontend/app/dashboard/page.tsx`: user-facing multi-agent view and polling UI.
- `apps/frontend/components/dashboard-sidebar.tsx`: navigation entry.

## Design
- **Style options:** quiet laboratory notebook (0.07), dark control-room console (0.05), collaborative paper workspace (0.08).
- **Chosen movement:** collaborative paper workspace with a live evidence rail.
- **Core principles:** make concurrency visible; keep evidence beside claims; use restrained Thred paper/ink colors; show real states instead of decorative progress.
- **Color philosophy:** Thred's warm paper background keeps the product human while ink, moss, and amber accents distinguish runtime, memory, and waiting states.
- **Layout paradigm:** a left setup rail and a wide evidence canvas, with agent cards arranged as a working team rather than a generic centered dashboard grid.
- **Signature elements:** ruled paper dividers, small status dots, and memory chips that appear when HydraDB is written.
- **Interaction:** one clear goal input starts the team; the page polls status and makes each agent's actual result inspectable.
- **Animation:** only subtle pulse on active agent states and a short fade-in for new findings; no looping decoration.
- **Typography:** keep the existing Thred typography and monospace code/status labels.
- **Brand essence:** Thred is the shared memory layer that lets concurrent AI agents build on one another's work; calm, curious, dependable.
- **Voice:** direct and human. Example lines: “Give the team one goal.” and “They worked in parallel. Thred kept the evidence.”
- **Wordmark/logo:** reuse the existing Thred mark.
- **Signature brand color:** existing moss green used for durable memory.

## Serving
The API remains the Render Express service. The Next.js frontend calls the existing API base URL through the current authenticated request helper. No secrets are shipped to the browser.
