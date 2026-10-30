# Thred + Mozaik implementation plan

## Goal
Turn Thred into a real collaborative-agent workspace. A user submits one task; four named Mozaik jobs—Product Lead, Frontend Builder, Backend Builder, and QA & Release—run concurrently through native loops, read and publish to the same shared board, stream the same runtime to Mozaik Cloud when configured, expose their work as inspectable handoffs, and return a readable synthesis rather than raw JSON.

## Implementation
- Keep `@mozaik-ai/core` as the runtime layer: `defineRuntime` creates the shared space, `defineAgentModule` creates specialized participants, and each participant now runs through native `createLoop`/`runLoop` state transitions rather than a custom OpenAI tool loop.
- Stream the live runtime to Mozaik Cloud through the official exporter when `MOZAIK_API_KEY` is configured; the existing runtime notebook exposes the real session link and reports Cloud connection errors honestly.
- Expand the real tool surface beyond memory-only orchestration: public URL fetch with bounded text extraction, DNS lookup, durable memory recall/write, shared-board read, and finding publication. Every tool call emits a persisted runtime event and records source metadata when applicable.
- Make the run model inspectable: expose each agent's current action, tool-call count, finding count, memory-write count, structured brief, errors, and the full event timeline. Persist runs, events, findings, and source metadata in PostgreSQL where the existing schema supports it; keep the in-process map for low-latency polling and restart recovery.
- Treat partial failure as a valid collaborative outcome: one failed agent must not erase completed evidence. The run completes with a warning when at least one agent produces a result, and the synthesis explicitly identifies failed roles and missing evidence.
- Add a workspace run-history endpoint so completed investigations can be reopened and replayed rather than disappearing after one screen.
- Redesign only the existing Thred Mozaik view: use the current paper/ink/moss palette and typography, but present named job cards for Product, Frontend, Backend, and QA & Release; keep the workflow rail, live activity timeline, evidence/source cards, readable handoff sections, memory state, synthesis, run history, quick-start goals, and a clear new-run action. No fake or decorative progress.
- Keep Clerk authentication, Vercel routing, Render API/DB, Prisma migrations, and MCP flows intact. No secrets are shipped to the browser.

## Project structure
- `apps/api/src/mozaik-orchestrator.ts`: runtime, public evidence tools, shared-memory tools, event aggregation, partial-failure handling, and persisted status.
- `apps/api/src/index.ts`: authenticated Mozaik start/status/history routes.
- `apps/frontend/app/dashboard/page.tsx`: Thred-native investigation workspace, live polling, run history, evidence/source presentation, and synthesis.
- `packages/database/prisma/schema.prisma`: existing Mozaik persistence entities, extended only where needed.

## Design
- **Movement:** collaborative paper workspace with a live evidence rail.
- **Principles:** make concurrency visible; keep evidence beside claims; show real states; make failure informative; keep Thred calm and human.
- **Palette:** warm paper background, ink text, moss for durable memory and verified findings, amber for active work, muted red for warnings.
- **Layout:** a left workflow rail and a wide evidence canvas; agent cards, source cards, and the timeline are working surfaces rather than generic dashboard tiles.
- **Signature elements:** ruled dividers, small status dots, source chips, memory chips, and an event trail that reads like a lab notebook.
- **Interaction:** one goal starts the team; the user can inspect every call, reopen prior runs, begin a fresh run, and understand exactly what is known, unknown, and blocked.
- **Animation:** only subtle pulse on active agents and short insertion fades for events/findings.
- **Typography:** reuse existing Thred typography and monospace status labels.
- **Brand essence:** Thred is the shared memory layer that lets concurrent AI agents build on one another's live evidence; calm, curious, dependable.
- **Voice:** direct and human: “Give the team one goal.” “They worked in parallel. Thred kept the evidence.” “A failed role is visible; it does not erase the useful work.”

## Serving
The API remains the Render Express service. The Next.js frontend calls it through the existing authenticated request helper. Public evidence fetching happens server-side with bounded timeouts and no secret exposure.
