# checkpoint

`thread_checkpoint` write path. `ingest.ts` is the manager: LLM extract → long-term memory store → short-term Postgres.

| Path | Store | Job |
|---|---|---|
| `ingest.ts` | both | Orchestrator. Does not write itself. | 
| `long-term/` | PostgreSQL | Durable facts: revisions, then ingest. |
| `short-term/` | Postgres | Current-task handoff (`WorkingCheckpoint`). |

