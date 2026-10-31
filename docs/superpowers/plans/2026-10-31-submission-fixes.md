# Thred submission fixes implementation plan

**Goal:** Fix the concrete audit findings, verify the changes, commit and push to the existing repository as requested.

**Architecture:** Keep Next.js, Express, PostgreSQL, the existing memory engine and four native Mozaik loops. Share one canonical board; validate complete outputs; require versioned QA review; persist checkpoints through the same operational memory used by MCP. Use the Cloud client to publish actual lifecycle events. Production service credentials are not invented or changed.

**Tech stack:** TypeScript, Node 24+, Mozaik, OpenAI, Prisma, Next.js, Node test runner.

**Scope/spec:** The nine-section audit in this chat and the user's instruction to fix all findings and commit/push authorize implementation without another design approval round.

## Tasks

- [ ] Restore Git history, compare existing snapshot to origin/main, preserve unrelated differences.
- [ ] Add failing orchestration tests for single publication, versioned gates, invalid output, partial failure and durable snapshots. Implement canonical publication, validated structured output and final artifact synthesis.
- [ ] Connect Studio recall/checkpoints to shared memory functions. PostgreSQL supplies all durable memory through `@repo/memory-store`, with lexical full-text retrieval and application-level revision links. Show actual capabilities.
- [ ] Require initial persistence; serialize progress snapshots; bound runs; support cancellation, interruption detection and successful write counters; restore complete persisted records.
- [ ] Publish actual agent/inference/tool events and participant IDs through Mozaik Cloud client; retain project/session references without asserting successful viewing.
- [ ] Add safe pinned-DNS public evidence fetching with redirect/address/size/time validation and tests. Delegate this independent module.
- [ ] Fix Studio UX, errors, metrics, latest handoffs, readable synthesis and responsive overflow. Delegate frontend files only.
- [ ] Document exact install/auth/database/model/MCP/Cloud setup, honest planning scope and benchmark limits. Delegate documentation/config only.
- [ ] Run all tests, API/frontend type checks, production frontend build, lint and local UI checks where possible. Fresh reviewer checks integrated diff.
- [ ] Commit explicit files and push; verify remote commit. Report credentials/deployment checks that remain unverified.

## Review focus

Late tool completion after cancellation must not mutate shared state. A revised handoff invalidates any prior gate. Invalid/refused/incomplete model outputs never count as successful agents. Snapshot writes preserve ordering and surface failures. Public URLs cannot use redirects or DNS rebinding to reach private addresses.

## Progress

- Baseline audit: 37 tests and API/frontend types passed. Cloud link did not show run. No local .env supplied.
- User direction: remove the external memory provider entirely. PostgreSQL owns durable memory, checkpoint/resume, and run history; deployment requires no separate memory-service credentials.
- Parallel work is limited to independent frontend, docs/config, and evidence-fetch modules. Main agent owns orchestrator, shared context, API routes and integration.
