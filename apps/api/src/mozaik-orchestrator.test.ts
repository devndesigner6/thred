import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { Responses } from "openai/resources/responses/responses";
import { prisma } from "@repo/db";
import { cancelMozaikRun, getMozaikRun, startMozaikRun } from "./mozaik-orchestrator.js";
import { agentKeys, type AgentKey } from "./mozaik-state.js";

const outputs = {
  product: {
    brief: "Registration plan",
    requirements: ["name/email only"],
    acceptanceCriteria: ["Contract agrees"],
    sources: [],
  },
  frontend: {
    approach: "Use agreed contract",
    screens: ["Form"],
    implementation: ["POST name/email"],
    dependencies: [],
  },
  backend: {
    approach: "Use agreed contract",
    endpoints: ["POST name/email"],
    dataModel: ["Unique email"],
    integrations: [],
  },
  qa: {
    testPlan: ["Check contract"],
    risks: ["No executed tests"],
    releaseGate: "conditional planning only",
    dependencies: [],
  },
};

function database() {
  const rows = new Map<string, any>();
  const replacements: Array<() => void> = [];
  function replace(object: any, name: string, value: any) {
    const old = object[name];
    object[name] = value;
    replacements.push(() => {
      object[name] = old;
    });
  }
  replace(prisma.mozaikRun, "create", async ({ data }: any) => {
    const row = { ...structuredClone(data), startedAt: new Date(), events: [], findings: [] };
    rows.set(row.id, row);
    return row;
  });
  replace(prisma.mozaikRun, "update", async ({ where, data }: any) => {
    const row = rows.get(where.id);
    if (!row) throw new Error("missing row");
    Object.assign(row, structuredClone(data));
    return row;
  });
  replace(prisma.mozaikRun, "findUnique", async ({ where }: any) => rows.get(where.id) ?? null);
  replace(prisma.agentSession, "create", async () => ({ id: "session-1" }));
  replace(prisma.workingCheckpoint, "create", async ({ data }: any) => ({
    ...data,
    id: "checkpoint-1",
  }));
  replace(prisma.workingCheckpoint, "findMany", async () => []);
  replace(prisma.memoryFact, "findMany", async () => []);
  return { rows, restore: () => replacements.reverse().forEach((restore) => restore()) };
}

async function settled(id: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const run = await getMozaikRun(id);
    if (
      !["queued", "running"].includes(run.status) &&
      run.events.some((item) => item.type === `run.${run.status}`)
    )
      return run;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Task did not finish");
}

test("native loops publish once, enforce QA review and replay the complete persisted plan", async () => {
  const db = database();
  const key = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-only";
  const cloudKey = process.env.MOZAIK_API_KEY;
  delete process.env.MOZAIK_API_KEY;
  const stage: Partial<Record<AgentKey, number>> = {};
  const seen = new Set<AgentKey>();
  let runId = "";
  const responses = mock.method(Responses.prototype, "create", (async (body: any) => {
    const role = body.text.format.name.split("_")[0] as AgentKey;
    seen.add(role);
    const step = stage[role] ?? 0;
    stage[role] = step + 1;
    const call = (name: string, args: unknown) => ({
      id: `response-${role}-${step}`,
      status: "completed",
      output: [
        {
          type: "function_call",
          call_id: `call-${role}-${step}`,
          name,
          arguments: JSON.stringify(args),
        },
      ],
    });
    if (step === 0)
      return call("thred_publish_handoff", {
        title: `${role} final`,
        summary: "Agreed name/email contract",
        items: ["POST name/email; no phone"],
      });
    if (role === "qa" && step === 1) return call("thred_read_handoffs", {});
    if (role === "qa" && step === 2) {
      const run = await getMozaikRun(runId);
      return call("thred_set_release_gate", {
        status: "conditional",
        summary: "Plans agree; no deployment approval",
        blockers: ["Implementation and testing required"],
        reviewedHandoffIds: run.handoffs.filter((h) => h.agent !== "qa").map((h) => h.id),
      });
    }
    return {
      id: `response-${role}-${step}`,
      status: "completed",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: JSON.stringify(outputs[role]) }],
        },
      ],
    };
  }) as any);
  try {
    const started = await startMozaikRun("workspace-integration", "Registration contract");
    runId = started.id;
    const run = await settled(runId);
    assert.equal(seen.size, 4);
    assert.equal(run.status, "completed");
    assert.equal(run.handoffs.length, 4);
    assert.equal(run.checkpointId, "checkpoint-1");
    assert.equal(run.releaseGate?.reviewedHandoffIds.length, 3);
    const firstCompletion = run.events.findIndex((event) => event.type === "agent.completed");
    assert.equal(
      run.events.slice(0, firstCompletion).filter((event) => event.type === "agent.started").length,
      4,
    );
    for (const role of agentKeys) assert.equal(run.agents[role].handoffCount, 1);
    const restarted = await import(
      new URL("./mozaik-orchestrator.ts?replay", import.meta.url).href
    );
    const replay = await restarted.getMozaikRun(runId);
    assert.equal(replay.status, "completed");
    assert.equal(replay.checkpointId, "checkpoint-1");
    assert.deepEqual(replay.handoffs, run.handoffs);
    assert.deepEqual(replay.memoryWrites, run.memoryWrites);
    assert.match(replay.finalAnswer, /QA decision: CONDITIONAL/);
  } finally {
    responses.mock.restore();
    db.restore();
    if (key === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = key;
    if (cloudKey === undefined) delete process.env.MOZAIK_API_KEY;
    else process.env.MOZAIK_API_KEY = cloudKey;
  }
});

test("incomplete provider responses fail roles instead of publishing raw truncated JSON", async () => {
  const db = database();
  const key = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-only";
  const responses = mock.method(
    Responses.prototype,
    "create",
    async () =>
      ({
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [],
      }) as any,
  );
  try {
    const started = await startMozaikRun("workspace-incomplete", "Plan");
    const run = await settled(started.id);
    assert.equal(run.status, "failed");
    assert.equal(run.handoffs.length, 0);
    assert.equal(Object.values(run.agents).filter((agent) => agent.status === "failed").length, 4);
    assert.match(run.agents.product.error ?? "", /incomplete/);
  } finally {
    responses.mock.restore();
    db.restore();
    if (key === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = key;
  }
});

test("cancellation aborts active inference and preserves an honest cancelled result", async () => {
  const db = database();
  const key = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-only";
  let notify!: () => void;
  const entered = new Promise<void>((resolve) => {
    notify = resolve;
  });
  const responses = mock.method(Responses.prototype, "create", (async (
    _body: any,
    options: any,
  ) => {
    notify();
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  }) as any);
  try {
    const started = await startMozaikRun("workspace-cancel", "Plan");
    await entered;
    const cancelled = await cancelMozaikRun(started.id);
    assert.equal(cancelled.status, "cancelled");
    await settled(started.id);
    assert.equal(cancelled.findings.length, 0);
    assert.equal(cancelled.releaseGate, undefined);
  } finally {
    responses.mock.restore();
    db.restore();
    if (key === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = key;
  }
});
