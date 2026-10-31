# Memory store

PostgreSQL reads used during checkpoint (not the ingest itself — that’s `@repo/memory-store`).

| File | TLDR |
|---|---|
| `store-lookup.ts` | Ask memory store: do we already have this subject + predicate? |
| `memory-cache.ts` | Remember IDs just written, because memory store indexes slowly. |
