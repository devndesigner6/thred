import { test } from "node:test";
import assert from "node:assert/strict";
import { StoreMemoryLookup } from "./store-lookup.js";
import { resolveRevision } from "../revision/revision-resolver.js";

test("canonical alias lookup preserves full URL and supports idempotent revisions", async () => {
  const lookup = new StoreMemoryLookup(async (input) => {
    assert.deepEqual(input, { workspaceId: "w1", semanticKey: "postgresql::base url" });
    return [{ id: "m1", value: "https://api.example.com/v1.5", createdAt: new Date("2026-10-31") }];
  });
  const memories = await lookup.findCurrentBySemanticKey({
    workspaceId: "w1",
    subject: "Postgres",
    predicate: "base_url",
  });
  const claim = {
    kind: "decision" as const,
    subject: "PostgreSQL",
    predicate: "base url",
    value: "https://api.example.com/v1.5",
    confidence: 0.9,
    sourceMessageIds: [],
    files: [],
  };
  assert.equal(resolveRevision(claim, memories).operation, "IGNORE");
  assert.equal(
    resolveRevision({ ...claim, value: "https://api.example.com/v2.5" }, memories).operation,
    "SUPERSEDE",
  );
});
