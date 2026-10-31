import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import type { Server } from "node:http";

// This check writes and removes only its own namespace in an explicitly selected test database.
if (!process.env.THRED_VERIFY_DATABASE_URL)
  throw new Error(
    "Set THRED_VERIFY_DATABASE_URL to a disposable PostgreSQL database with Thred migrations applied.",
  );
process.env.DATABASE_URL = process.env.THRED_VERIFY_DATABASE_URL;
const { prisma } = await import("../packages/database/src/index.js");
const { buildMemoryContext, buildMemoryHistory, processLongTermClaim, StoreMemoryLookup } =
  await import("../packages/memory-engine/src/index.js");
const { saveCheckpoint } = await import("../packages/working-memory/src/index.js");
const namespace = `verify-${randomUUID()}`;
let server: Server | undefined;
try {
  const now = new Date();
  await prisma.user.create({
    data: {
      id: namespace,
      name: "Database verification",
      email: `${namespace}@example.invalid`,
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    },
  });
  await prisma.workspace.create({
    data: { id: namespace, name: "Database verification", slug: namespace, ownerId: namespace },
  });
  const session = await prisma.agentSession.create({
    data: { workspaceId: namespace, agent: "OTHER", externalId: namespace },
  });
  const lookup = new StoreMemoryLookup();
  const claim = {
    kind: "decision" as const,
    subject: "Registration database",
    predicate: "uses",
    value: "PostgreSQL",
    confidence: 0.9,
    sourceMessageIds: ["verification-message"],
    files: [],
  };
  const first = await processLongTermClaim(lookup, {
    workspaceId: namespace,
    sessionId: session.id,
    evidenceEventIds: ["verification-event"],
    claim,
  });
  assert.equal(first.decision.operation, "ADD");
  const second = await processLongTermClaim(lookup, {
    workspaceId: namespace,
    sessionId: session.id,
    evidenceEventIds: ["verification-event"],
    claim: { ...claim, value: "Neon PostgreSQL" },
  });
  assert.equal(second.decision.operation, "SUPERSEDE");
  const memoryId = second.memoryResponse?.data?.results?.[0]?.id;
  assert.ok(memoryId);
  const context = await buildMemoryContext({
    workspaceId: namespace,
    query: "Registration database uses",
    expandQuery: false,
  });
  assert.equal(context.status, "FOUND");
  if (context.status === "FOUND") {
    assert.match(context.context, /Neon PostgreSQL/);
    assert.equal(context.memories.length, 1);
  }
  const history = await buildMemoryHistory({
    workspaceId: namespace,
    query: "Registration database uses",
  });
  assert.equal(history.timeline.length, 2);
  assert.ok(JSON.stringify(history).includes("PostgreSQL"));
  const dotted = {
    ...claim,
    subject: "postgres",
    predicate: "base URL",
    value: "https://api.example.com/v1.5",
  };
  await processLongTermClaim(lookup, {
    workspaceId: namespace,
    sessionId: session.id,
    evidenceEventIds: ["verification-event"],
    claim: dotted,
  });
  const unchanged = await processLongTermClaim(lookup, {
    workspaceId: namespace,
    sessionId: session.id,
    evidenceEventIds: ["verification-event"],
    claim: { ...dotted, subject: "PostgreSQL" },
  });
  assert.equal(unchanged.decision.operation, "IGNORE");
  const isolated = await buildMemoryContext({
    workspaceId: `${namespace}-other`,
    query: "Registration database uses",
    expandQuery: false,
  });
  assert.equal(isolated.status, "NOT_FOUND");
  const checkpoint = await saveCheckpoint({
    workspaceId: namespace,
    sessionId: session.id,
    taskKey: namespace,
    task: "Registration database integration",
    status: "IN_PROGRESS",
    payload: {
      completed: ["Database contract revised to Neon PostgreSQL"],
      filesChanged: [],
      tests: ["Real PostgreSQL revision and isolation checks passed"],
      blockers: [],
      nextStep: "Implement registration API",
    },
    memoryIds: [memoryId],
  });
  const secret = `thrd_sk_${randomBytes(24).toString("base64url")}`;
  await prisma.apiKey.create({
    data: {
      workspaceId: namespace,
      name: "Temporary verification",
      keyPrefix: secret.slice(0, 15),
      keyHash: createHash("sha256").update(secret).digest("hex"),
    },
  });
  process.env.CLERK_PUBLISHABLE_KEY = "";
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "";
  process.env.CLERK_SECRET_KEY = "";
  const { app } = await import("../apps/api/src/index.js");
  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, "127.0.0.1", resolve);
    server.once("error", reject);
  });
  const address = server!.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(`${base}/health`)).status, 200);
  const request = async (route: string, body: unknown) => {
    const response = await fetch(`${base}/api/mcp/${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const throughApi = await request("context", { query: "Registration database uses" });
  assert.equal(throughApi.status, "FOUND");
  assert.match(throughApi.context, /Neon PostgreSQL/);
  const resumed = await request("resume", { taskKey: namespace });
  assert.equal(resumed.checkpointId, checkpoint.id);
  assert.equal(resumed.payload.nextStep, "Implement registration API");
  console.log(
    "Real PostgreSQL + HTTP MCP verification passed: write, revision, current/history retrieval, workspace isolation, checkpoint and resume.",
  );
} finally {
  if (server) server.closeAllConnections();
  if (server)
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
  await prisma.memoryFact.deleteMany({ where: { workspaceId: namespace } });
  await prisma.workspace.deleteMany({ where: { id: namespace } });
  await prisma.user.deleteMany({ where: { id: namespace } });
  await prisma.$disconnect();
}
