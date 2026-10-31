import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryStore, memoryToSentence, type MemoryDatabase } from "./store.js";
import type { LongTermMemoryInput } from "./types.js";

const input: LongTermMemoryInput = {
  workspaceId: "w1",
  sessionId: "s1",
  kind: "decision",
  text: "Use PostgreSQL for memory.",
  confidence: 0.8,
  evidenceEventIds: ["e1"],
  sourceMessageIds: ["m1"],
  files: ["schema.prisma"],
  relations: [{ predicate: "ABOUT", target: "memory" }],
};

function fixture() {
  const rows: Array<{
    id: string;
    workspaceId: string;
    sessionId: string;
    kind: string;
    text: string;
    semanticKey?: string | null;
    currentKey: string | null;
    value?: string | null;
    isCurrent: boolean;
    createdAt: Date;
  }> = [];
  const db: MemoryDatabase = {
    memoryFact: {
      async createManyAndReturn({ data }) {
        for (const row of data) {
          if (
            row.currentKey &&
            rows.some(
              (existing) =>
                existing.workspaceId === row.workspaceId && existing.currentKey === row.currentKey,
            )
          )
            throw new Error("Unique current key");
          rows.push({ ...row, createdAt: new Date("2026-10-31") });
        }
        return [...data].reverse().map(({ id }) => ({ id }));
      },
      async findMany({ where, take }) {
        return rows
          .filter(
            (row) =>
              row.workspaceId === where.workspaceId &&
              (where.isCurrent === undefined || row.isCurrent === where.isCurrent) &&
              (where.semanticKey
                ? row.semanticKey === where.semanticKey
                : where.OR!.some((term) =>
                    row.text.toLowerCase().includes(term.text.contains.toLowerCase()),
                  )),
          )
          .slice(0, take);
      },
      async updateMany({ where }) {
        let count = 0;
        for (const row of rows)
          if (row.workspaceId === where.workspaceId && where.id.in.includes(row.id)) {
            row.isCurrent = false;
            row.currentKey = null;
            count++;
          }
        return { count };
      },
    },
    async $transaction(operation) {
      const snapshot = rows.map((row) => ({ ...row }));
      try {
        return await operation({ memoryFact: db.memoryFact });
      } catch (error) {
        rows.splice(0, rows.length, ...snapshot);
        throw error;
      }
    },
  };
  return { rows, store: createMemoryStore(db) };
}

test("writes complete provenance and returns durable IDs in input order", async () => {
  const { rows, store } = fixture();
  const result = await store.writeLongTermMemories([
    input,
    { ...input, text: "Use queues for jobs." },
  ]);
  assert.deepEqual(
    result.data?.results?.map((row) => row.id),
    rows.map((row) => row.id),
  );
  assert.equal(rows[0]?.text, memoryToSentence(input).text);
  for (const fragment of [
    "kind=decision",
    "session=s1",
    "confidence=0.8",
    "evidence=e1",
    "messages=m1",
    "files=schema.prisma",
    "relations=ABOUT:memory",
  ])
    assert.ok(rows[0]?.text.includes(fragment));
});

test("superseding writes mark prior rows noncurrent while retaining searchable history", async () => {
  const { store, rows } = fixture();
  const first = await store.writeLongTermMemory({
    ...input,
    semanticKey: "database::uses",
    value: "PostgreSQL",
  });
  const previousId = first.data!.results![0]!.id!;
  await store.writeLongTermMemory({
    ...input,
    text: "Use SQLite instead.",
    semanticKey: "database::uses",
    value: "SQLite",
    relations: [{ predicate: "SUPERSEDES", target: `memory:${previousId}` }],
  });
  assert.equal(rows[0]?.isCurrent, false);
  assert.equal(rows[0]?.currentKey, null);
  assert.equal(rows[1]?.isCurrent, true);
  assert.equal(
    (await store.findMemoriesBySemanticKey({ workspaceId: "w1", semanticKey: "database::uses" }))[0]
      ?.value,
    "SQLite",
  );
  const history = await store.recallLongTermMemory({ workspaceId: "w1", query: "PostgreSQL" });
  assert.equal(history.data?.chunks?.[0]?.isCurrent, false);
});

test("a conflicting current key rolls back superseding updates", async () => {
  const { store, rows } = fixture();
  const first = await store.writeLongTermMemory({ ...input, semanticKey: "a::uses", value: "one" });
  await store.writeLongTermMemory({ ...input, semanticKey: "b::uses", value: "two" });
  await assert.rejects(
    store.writeLongTermMemory({
      ...input,
      semanticKey: "b::uses",
      value: "conflict",
      relations: [{ predicate: "SUPERSEDES", target: `memory:${first.data!.results![0]!.id}` }],
    }),
    /Unique current key/,
  );
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.isCurrent));
  assert.equal(rows[0]?.currentKey, "a::uses");
});

test("semantic lookup preserves dotted values and isolates workspace and exact key", async () => {
  const { store } = fixture();
  const memory = {
    ...input,
    semanticKey: "postgresql::base url",
    value: "https://api.example.com/v1.5",
  };
  await store.writeLongTermMemory(memory);
  await store.writeLongTermMemory({ ...memory, workspaceId: "w2", value: "secret" });
  await store.writeLongTermMemory({ ...memory, semanticKey: "postgresql::other", value: "other" });
  const found = await store.findMemoriesBySemanticKey({
    workspaceId: "w1",
    semanticKey: "postgresql::base url",
  });
  assert.equal(found.length, 1);
  assert.equal(found[0]?.value, memory.value);
  assert.deepEqual(
    await store.findMemoriesBySemanticKey({ workspaceId: "w1", semanticKey: "absent" }),
    [],
  );
});

test("recall scopes workspace, ranks matching claims, and returns no unrelated memories", async () => {
  const { store } = fixture();
  await store.writeLongTermMemory(input);
  await store.writeLongTermMemory({
    ...input,
    text: "PostgreSQL migrations use a versioned schema.",
  });
  await store.writeLongTermMemory({
    ...input,
    workspaceId: "w2",
    text: "PostgreSQL memory elsewhere.",
  });
  const found = await store.recallLongTermMemory({
    workspaceId: "w1",
    query: "PostgreSQL memory",
    maxResults: 1,
  });
  assert.equal(found.data?.chunks?.length, 1);
  assert.match(found.data!.chunks![0]!.chunkContent!, /Use PostgreSQL for memory/);
  assert.deepEqual(
    (await store.recallLongTermMemory({ workspaceId: "w1", query: "dolphins" })).data?.chunks,
    [],
  );
});

test("validates all records before writing and rejects invalid query limits", async () => {
  const { rows, store } = fixture();
  for (const invalid of [
    { workspaceId: "" },
    { sessionId: "" },
    { kind: "unknown" },
    { text: "" },
    { confidence: NaN },
    { confidence: 2 },
    { files: [12] },
    { relations: [{ predicate: "UNKNOWN", target: "x" }] },
  ]) {
    await assert.rejects(
      store.writeLongTermMemory({ ...input, ...invalid } as LongTermMemoryInput),
    );
  }
  await assert.rejects(store.writeLongTermMemories([input, { ...input, workspaceId: "w2" }]));
  assert.equal(rows.length, 0);
  assert.deepEqual(await store.writeLongTermMemories([]), { data: { results: [] } });
  await assert.rejects(
    store.recallLongTermMemory({ workspaceId: "w1", query: "memory", maxResults: 0 }),
  );
});
