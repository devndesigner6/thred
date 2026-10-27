# Thred + Mozaik TODO

## Real evidence-driven Mozaik orchestration
- [x] A signed-in workspace can submit one goal to the API.
- [x] The API creates a Mozaik runtime space, joins a human kickoff participant and three agent participants, and sends the kickoff message through the runtime.
- [x] Three specialized agents are created through `defineAgentModule` and run with separate Mozaik loops concurrently.
- [x] Each agent can use bounded public URL fetch and DNS lookup tools in addition to Thred memory and shared-board tools, with source metadata and persisted tool events.
- [x] A single failed agent does not erase completed findings; the run reports partial completion and identifies missing roles.
- [x] Agent outputs, tool calls, errors, shared-memory writes, and final synthesis are returned by the status endpoint.

## Full investigation workspace
- [x] The dashboard shows live current action, tool-call count, finding count, memory state, and structured role briefs instead of raw JSON only.
- [x] The dashboard shows a complete activity timeline, source/evidence cards, shared board, durable memory state, synthesis, and actionable warnings in the existing Thred palette and typography.
- [x] A user can start a fresh run without losing the current run and can reopen prior runs from workspace history.
- [x] Run history is available through an authenticated API endpoint and backed by the existing PostgreSQL persistence.

## Validation and delivery
- [x] API and frontend type checks pass before the deeper change.
- [x] API and frontend type checks pass after the deeper change.
- [x] The API health endpoint remains available.
- [ ] Render database migration/deployment succeeds if the schema changes.
- [ ] The change is committed to `origin/main` after checks pass.
