import assert from "node:assert/strict";
import { test } from "node:test";
import { prisma } from "@repo/db";
import { buildWorkspaceContext } from "./workspace-context.js";

test("large checkpoints expose bounded source excerpts and metadata only", async () => {
  const originalFacts = prisma.memoryFact.findMany;
  const originalCheckpoints = prisma.workingCheckpoint.findMany;
  prisma.memoryFact.findMany = (async () => []) as typeof originalFacts;
  prisma.workingCheckpoint.findMany = (async () => [{
    id: "large", task: "registration", taskKey: "run:large", status: "IN_PROGRESS",
    updatedAt: new Date(), payload: { completed: ["x".repeat(100000)], nextStep: "Implement registration" },
  }]) as unknown as typeof originalCheckpoints;
  try {
    const result = await buildWorkspaceContext({ workspaceId: "own-workspace", query: "registration" });
    assert.equal(result.status, "FOUND");
    assert.ok((result.context?.length ?? 0) <= 5000);
    assert.match(result.context ?? "", /Excerpt truncated; use thread_resume with taskKey "run:large"/);
    assert.match(result.context ?? "", /Next-step source excerpt:\nImplement registration/);
    assert.equal("payload" in result.checkpoints[0]!, false);
  } finally {
    prisma.memoryFact.findMany = originalFacts;
    prisma.workingCheckpoint.findMany = originalCheckpoints;
  }
});

test("workspace checkpoints are selected by workspace alongside local memory", async () => {
  const originalFacts = prisma.memoryFact.findMany;
  prisma.memoryFact.findMany = (async () => []) as typeof originalFacts;
  const originalFindMany = prisma.workingCheckpoint.findMany;
  prisma.workingCheckpoint.findMany = (async (input: any) => {
    assert.equal(input.where.workspaceId, "own-workspace");
    return [
      {
        id: "checkpoint-1",
        task: "registration contract",
        taskKey: "run:backend",
        status: "IN_PROGRESS",
        updatedAt: new Date(),
        payload: { completed: ["POST uses name/email"], blockers: [], nextStep: "Implement" },
      },
    ];
  }) as unknown as typeof originalFindMany;
  try {
    const result = await buildWorkspaceContext({
      workspaceId: "own-workspace",
      query: "registration",
    });
    assert.equal(result.status, "FOUND");
    assert.match(result.context ?? "", /name\/email/);
    assert.equal(result.checkpoints[0]?.id, "checkpoint-1");
    assert.equal(result.longTermAvailable, true);
  } finally {
    prisma.workingCheckpoint.findMany = originalFindMany;
    prisma.memoryFact.findMany = originalFacts;
  }
});

test("unrelated or obsolete checkpoints do not become current context", async () => {
  const originalFacts = prisma.memoryFact.findMany;
  prisma.memoryFact.findMany = (async () => []) as typeof originalFacts;
  const originalFindMany = prisma.workingCheckpoint.findMany;
  prisma.workingCheckpoint.findMany = (async () => [
    { id: "new", task: "billing", taskKey: "same-task", payload: {}, updatedAt: new Date() },
    { id: "old", task: "registration", taskKey: "same-task", payload: {}, updatedAt: new Date(0) },
  ]) as unknown as typeof originalFindMany;
  try {
    const result = await buildWorkspaceContext({
      workspaceId: "own-workspace",
      query: "registration",
    });
    assert.equal(result.status, "NOT_FOUND");
    assert.equal(result.checkpoints.length, 0);
    assert.equal(result.longTermAvailable, true);
  } finally {
    prisma.workingCheckpoint.findMany = originalFindMany;
    prisma.memoryFact.findMany = originalFacts;
  }
});
