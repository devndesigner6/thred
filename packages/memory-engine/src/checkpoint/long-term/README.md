# long-term

Durable facts → PostgreSQL. `engine.ts` is the manager for one claim.

| Path | Job |
|---|---|
| `engine.ts` | Find existing → revision → maybe write. |
| `store/` | Talk to memory store: lookup + write cache. |
| `revision/` | ADD / IGNORE / SUPERSEDE. |
| `graph/` | Claim → object (sentence is built in `@repo/memory-store`). |
