# Thred + Mozaik TODO

## Real concurrent Mozaik orchestration
- [x] A signed-in workspace can submit one goal to the API.
- [x] The API creates a Mozaik runtime space, joins a human kickoff participant and three agent participants, and sends the kickoff message through the runtime.
- [x] Three specialized agents are created through `defineAgentModule` and run with separate Mozaik loops concurrently.
- [x] Each loop uses the configured model and can call real Thred tools for HydraDB recall, durable memory writes, shared-board reads, and finding publication.
- [x] Agent outputs, tool calls, errors, shared-memory writes, and final synthesis are returned by the status endpoint.

## Dashboard experience
- [x] The dashboard has a visible “Mozaik team run” view with a goal input and start action.
- [x] While a run is active, the dashboard shows all three agents and their current state.
- [x] The dashboard shows findings and memory writes from the API rather than hard-coded showcase data.
- [x] The dashboard shows the final synthesis after the three loops finish and displays actionable configuration errors when model or Hydra credentials are missing.
- [x] Mozaik runs, events, and findings persist in PostgreSQL so a status request can recover after an API restart.
- [x] Each specialized agent returns a strict role-specific JSON brief that the dashboard can inspect.

## Validation and delivery
- [x] API and frontend type checks pass.
- [x] The API health endpoint remains available.
- [x] The new route returns a useful 4xx/5xx explanation when required credentials are absent and does not expose secrets.
- [ ] The change is committed to `origin/main` after checks pass.
