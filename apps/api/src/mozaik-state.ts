import { randomUUID } from "node:crypto";

export const agentKeys = ["product", "frontend", "backend", "qa"] as const;
export type AgentKey = (typeof agentKeys)[number];
export type AgentStatus = "queued" | "running" | "completed" | "failed";
export type RunStatus = AgentStatus | "partial" | "cancelled" | "interrupted";
export type Finding = {
  id: string;
  agent: AgentKey;
  text: string;
  createdAt: string;
  sourceUrl?: string;
};
export type Handoff = {
  id: string;
  agent: AgentKey;
  title: string;
  summary: string;
  items: string[];
  createdAt: string;
};
export type ReleaseGate = {
  status: "ready" | "blocked" | "conditional";
  summary: string;
  blockers: string[];
  reviewedHandoffIds: string[];
  createdAt: string;
};
export type RunRecord = {
  id: string;
  workspaceId: string;
  goal: string;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  persistenceError?: string;
  finalAnswer?: string;
  checkpointId?: string;
  cloudSessionUrl?: string;
  cloudProjectId?: string;
  agents: Record<
    AgentKey,
    {
      status: AgentStatus;
      currentAction?: string;
      toolCalls: number;
      findingCount: number;
      handoffCount: number;
      memoryWriteCount: number;
      answer?: string;
      structured?: Record<string, unknown>;
      error?: string;
    }
  >;
  findings: Finding[];
  handoffs: Handoff[];
  releaseGate?: ReleaseGate;
  handoffReads: Partial<Record<AgentKey, string[]>>;
  memoryWrites: Array<{ agent: AgentKey; text: string; memoryId: string; createdAt: string }>;
  events: Array<{ type: string; agent?: AgentKey; detail: string; createdAt: string }>;
};

export function createRunRecord(workspaceId: string, goal: string): RunRecord {
  return {
    id: randomUUID(),
    workspaceId,
    goal,
    status: "queued",
    startedAt: new Date().toISOString(),
    agents: Object.fromEntries(
      agentKeys.map((key) => [
        key,
        { status: "queued", toolCalls: 0, findingCount: 0, handoffCount: 0, memoryWriteCount: 0 },
      ]),
    ) as RunRecord["agents"],
    findings: [],
    handoffs: [],
    handoffReads: {},
    memoryWrites: [],
    events: [],
  };
}

function text(value: string, limit: number) {
  if (typeof value !== "string" || !value.trim()) throw new Error("Non-empty text is required");
  if (value.length > limit)
    throw new Error(`Text exceeds ${limit} characters; shorten it without truncating the contract`);
  return value.trim();
}

export function publishFinding(run: RunRecord, agent: AgentKey, value: string, sourceUrl?: string) {
  const finding: Finding = {
    id: randomUUID(),
    agent,
    text: text(value, 3000),
    createdAt: new Date().toISOString(),
    ...(sourceUrl ? { sourceUrl } : {}),
  };
  run.findings.push(finding);
  run.agents[agent].findingCount += 1;
  return finding;
}

export function publishHandoff(
  run: RunRecord,
  agent: AgentKey,
  title: string,
  summary: string,
  items: string[],
) {
  if (!Array.isArray(items) || !items.length || items.length > 16)
    throw new Error("A handoff needs 1–16 complete deliverable items");
  const handoff: Handoff = {
    id: randomUUID(),
    agent,
    title: text(title, 200),
    summary: text(summary, 2000),
    items: items.map((item) => text(item, 2000)),
    createdAt: new Date().toISOString(),
  };
  run.handoffs.push(handoff);
  run.agents[agent].handoffCount += 1;
  delete run.releaseGate;
  return handoff;
}

export function latestHandoffs(run: RunRecord) {
  return agentKeys
    .map((agent) => run.handoffs.filter((handoff) => handoff.agent === agent).at(-1))
    .filter((handoff): handoff is Handoff => Boolean(handoff));
}

export function readHandoffs(run: RunRecord, agent: AgentKey) {
  run.handoffReads[agent] = run.handoffs.map((handoff) => handoff.id);
  return { latest: latestHandoffs(run), history: [...run.handoffs] };
}

export function setGate(
  run: RunRecord,
  agent: AgentKey,
  status: ReleaseGate["status"],
  summary: string,
  blockers: string[],
  reviewedHandoffIds: string[],
) {
  if (agent !== "qa") throw new Error("Only QA may set the gate");
  if (!["conditional", "blocked"].includes(status))
    throw new Error(
      "This planning team cannot approve a software release; use conditional or blocked",
    );
  const current = latestHandoffs(run).filter((handoff) => handoff.agent !== "qa");
  if (current.length !== 3 || current.some((handoff) => !reviewedHandoffIds.includes(handoff.id)))
    throw new Error(
      "Review and cite the current Product, Frontend and Backend handoffs before setting a gate",
    );
  if (current.some((handoff) => !run.handoffReads.qa?.includes(handoff.id)))
    throw new Error("QA must read the current handoffs before setting a gate");
  if (current.some((handoff) => run.agents[handoff.agent].status === "failed"))
    throw new Error("A failed role cannot supply an accepted handoff");
  run.releaseGate = {
    status,
    summary: text(summary, 3000),
    blockers: blockers.map((item) => text(item, 2000)),
    reviewedHandoffIds: current.map((handoff) => handoff.id),
    createdAt: new Date().toISOString(),
  };
  return run.releaseGate;
}

const fields: Record<AgentKey, Record<string, "string" | "list">> = {
  product: { brief: "string", requirements: "list", acceptanceCriteria: "list", sources: "list" },
  frontend: { approach: "string", screens: "list", implementation: "list", dependencies: "list" },
  backend: { approach: "string", endpoints: "list", dataModel: "list", integrations: "list" },
  qa: { testPlan: "list", risks: "list", releaseGate: "string", dependencies: "list" },
};

export function parseAgentOutput(agent: AgentKey, value: string): Record<string, unknown> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Agent returned incomplete or invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Agent output must be a JSON object");
  for (const [key, kind] of Object.entries(fields[agent])) {
    if (
      kind === "string"
        ? typeof parsed[key] !== "string" || !String(parsed[key]).trim()
        : !Array.isArray(parsed[key]) ||
          (parsed[key] as unknown[]).some((item) => typeof item !== "string" || !item.trim())
    )
      throw new Error(`Agent output has invalid ${key}`);
  }
  if (Object.keys(parsed).some((key) => !(key in fields[agent])))
    throw new Error("Agent output contains unexpected fields");
  return parsed;
}

export function finishRun(run: RunRecord) {
  if (["cancelled", "interrupted"].includes(run.status)) return;
  const count = Object.values(run.agents).filter((agent) => agent.status === "completed").length;
  run.status = count === 4 && run.releaseGate ? "completed" : count ? "partial" : "failed";
  run.finishedAt = new Date().toISOString();
}

export function synthesizeRun(run: RunRecord) {
  const current = latestHandoffs(run).filter(
    (handoff) => run.agents[handoff.agent].status !== "failed",
  );
  const gate = run.releaseGate;
  return [
    `Coordinated implementation plan: ${run.goal}`,
    "No code was written or tested. This result is a planning handoff, not deployment approval.",
    gate
      ? `QA decision: ${gate.status.toUpperCase()}\n${gate.summary}\nReviewed handoffs: ${gate.reviewedHandoffIds.join(", ")}`
      : "QA decision: NOT REVIEWED — no valid review of all current builder handoffs.",
    ...(gate?.blockers.length
      ? [`Unresolved conditions:\n${gate.blockers.map((item) => `- ${item}`).join("\n")}`]
      : []),
    ...current.map(
      (handoff) =>
        `${handoff.agent.toUpperCase()}: ${handoff.title}\n${handoff.summary}\n${handoff.items.map((item) => `- ${item}`).join("\n")}`,
    ),
    ...agentKeys
      .filter((agent) => run.agents[agent].status === "failed")
      .map((agent) => `Missing perspective — ${agent}: ${run.agents[agent].error ?? "failed"}`),
    `Evidence: ${run.findings.length} findings; ${run.handoffs.length} handoff versions; ${run.memoryWrites.length} confirmed memory writes.`,
  ].join("\n\n");
}
