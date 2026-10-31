import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createRunRecord,
  publishHandoff,
  publishFinding,
  readHandoffs,
  setGate,
  parseAgentOutput,
  finishRun,
  synthesizeRun,
} from "./mozaik-state.js";

test("one publication creates one finding and one versioned handoff", () => {
  const run = createRunRecord("workspace", "Agree on an API");
  publishFinding(run, "frontend", "Use name, never fullName");
  const handoff = publishHandoff(run, "frontend", "API", "Use name", ["POST /registrations"]);
  assert.equal(run.findings.length, 1);
  assert.equal(run.agents.frontend.findingCount, 1);
  assert.equal(run.handoffs.length, 1);
  assert.equal(run.agents.frontend.handoffCount, 1);
  assert.ok(handoff.id);
});

test("QA must read and cite all current handoffs; revisions invalidate review", () => {
  const run = createRunRecord("workspace", "Agree on an API");
  for (const role of ["product", "frontend", "backend"] as const)
    publishHandoff(run, role, role, "Contract v1", ["name"]);
  const ids = run.handoffs.map((handoff) => handoff.id);
  assert.throws(() => setGate(run, "qa", "conditional", "Reviewed", [], ids), /read/i);
  readHandoffs(run, "qa");
  assert.throws(() => setGate(run, "frontend", "ready", "Trust me", [], ids), /Only QA/);
  assert.throws(() => setGate(run, "qa", "ready", "Ship", [], ids), /planning/i);
  setGate(run, "qa", "conditional", "Plan reviewed, not deployment approval", [], ids);
  assert.equal(run.releaseGate?.reviewedHandoffIds.length, 3);
  const revision = publishHandoff(run, "backend", "v2", "Changed contract", ["fullName"]);
  assert.equal(run.releaseGate, undefined);
  assert.throws(() => setGate(run, "qa", "conditional", "Old review", [], ids), /current/i);
  assert.throws(
    () => setGate(run, "qa", "conditional", "Unread revision", [], [...ids, revision.id]),
    /read/i,
  );
  readHandoffs(run, "qa");
  assert.equal(
    setGate(
      run,
      "qa",
      "blocked",
      "Contract disagreement",
      ["name vs fullName"],
      [...ids, revision.id],
    ).status,
    "blocked",
  );
});

test("incomplete or wrongly shaped model output cannot become a completed artifact", () => {
  assert.throws(() => parseAgentOutput("product", '{"brief":"cut off'), /JSON/i);
  assert.throws(() => parseAgentOutput("product", '{"brief":"no requirements"}'), /requirements/i);
  const result = parseAgentOutput(
    "product",
    JSON.stringify({
      brief: "Plan",
      requirements: ["name"],
      acceptanceCriteria: ["matches"],
      sources: [],
    }),
  );
  assert.equal(result.brief, "Plan");
});

test("partial failure and missing QA gate never report full completion", () => {
  const run = createRunRecord("workspace", "Agree");
  for (const role of ["product", "frontend", "backend", "qa"] as const)
    run.agents[role].status = "completed";
  finishRun(run);
  assert.equal(run.status, "partial");
  run.agents.backend.status = "failed";
  finishRun(run);
  assert.equal(run.status, "partial");
  for (const agent of Object.values(run.agents)) agent.status = "failed";
  finishRun(run);
  assert.equal(run.status, "failed");
});

test("synthesis uses only latest handoffs and labels missing review", () => {
  const run = createRunRecord("workspace", "Agree");
  publishHandoff(run, "backend", "Old contract", "obsolete fullName", ["old"]);
  publishHandoff(run, "backend", "Final contract", "name", ["POST /registrations"]);
  const answer = synthesizeRun(run);
  assert.ok(answer.includes("Final contract"));
  assert.ok(!answer.includes("obsolete fullName"));
  assert.match(answer, /NOT REVIEWED/);
  assert.match(answer, /No code was written or tested/);
});
