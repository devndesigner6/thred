# PostgreSQL memory store

Durable claims live in the application's `MemoryFact` table. Writes preserve claim text, session, confidence, evidence IDs, source messages, files, and revision relations in a readable provenance block. A bulk write is atomic and accepts one workspace; returned IDs follow input order.

Revision-aware claims also store a canonical semantic key and the complete value separately from display text. Exact semantic lookup reads current rows without parsing punctuation or matching aliases in prose. Superseding a claim clears its current key and marks it historical in the same transaction that inserts its replacement; a database uniqueness constraint rejects conflicting current claims. Recall includes the current flag so normal context can exclude obsolete claims while history preserves them.

Recall is workspace-scoped lexical search, not embeddings or hybrid retrieval. It searches up to 24 distinct query terms, ranks the newest 200 matching candidates by whole-token overlap, and returns up to `maxResults` (default 12, maximum 200). Empty matches return no memories. Large histories can miss older relevant claims outside that candidate window; indexed full-text search is the next upgrade.

The public adapter uses `@repo/db` and requires the `MemoryFact` database migration and regenerated Prisma client. Tests inject a database delegate and require no database or external services.
