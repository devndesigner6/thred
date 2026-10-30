import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import {
  defineAgentModule,
  defineRuntime,
  type InferenceRequest,
  type InferenceResult,
  type InferenceRunner,
  type SharedState,
  type Tool,
} from "@mozaik-ai/core";
import { createCloudExporter } from "@mozaik-ai/cloud-sdk/exporter";
import OpenAI from "openai";
import { prisma } from "@repo/db";
import { recallLongTermMemory, writeLongTermMemory } from "@repo/hydra";

type AgentKey = "product" | "frontend" | "backend" | "qa";
type AgentStatus = "queued" | "running" | "completed" | "failed";

type Finding = {
  agent: AgentKey;
  text: string;
  createdAt: string;
  memoryId?: string;
  sourceUrl?: string;
  sourceTitle?: string;
};

type Handoff = {
  agent: AgentKey;
  title: string;
  summary: string;
  items: string[];
  createdAt: string;
};

type ReleaseGate = {
  status: "ready" | "blocked" | "conditional";
  summary: string;
  blockers: string[];
  createdAt: string;
};

type RunRecord = {
  id: string;
  workspaceId: string;
  goal: string;
  status: "queued" | "running" | "completed" | "failed";
  startedAt: string;
  finishedAt?: string;
  error?: string;
  finalAnswer?: string;
  agents: Record<AgentKey, { status: AgentStatus; currentAction?: string; toolCalls: number; findingCount: number; memoryWriteCount: number; answer?: string; structured?: Record<string, unknown>; error?: string }>;
  findings: Finding[];
  handoffs: Handoff[];
  releaseGate?: ReleaseGate;
  memoryWrites: Array<{ agent: AgentKey; text: string; memoryId?: string; createdAt: string }>;
  events: Array<{ type: string; agent?: AgentKey; detail: string; createdAt: string }>;
};

type RunSharedState = SharedState & {
  goal: string;
  board: Finding[];
  handoffs: Handoff[];
};

const outputSchemas: Record<AgentKey, Record<string, unknown>> = {
  product: {
    type: "object",
    properties: { brief: { type: "string" }, requirements: { type: "array", items: { type: "string" } }, acceptanceCriteria: { type: "array", items: { type: "string" } }, sources: { type: "array", items: { type: "string" } } },
    required: ["brief", "requirements", "acceptanceCriteria", "sources"],
    additionalProperties: false,
  },
  frontend: {
    type: "object",
    properties: { approach: { type: "string" }, screens: { type: "array", items: { type: "string" } }, implementation: { type: "array", items: { type: "string" } }, dependencies: { type: "array", items: { type: "string" } } },
    required: ["approach", "screens", "implementation", "dependencies"],
    additionalProperties: false,
  },
  backend: {
    type: "object",
    properties: { approach: { type: "string" }, endpoints: { type: "array", items: { type: "string" } }, dataModel: { type: "array", items: { type: "string" } }, integrations: { type: "array", items: { type: "string" } } },
    required: ["approach", "endpoints", "dataModel", "integrations"],
    additionalProperties: false,
  },
  qa: {
    type: "object",
    properties: { testPlan: { type: "array", items: { type: "string" } }, risks: { type: "array", items: { type: "string" } }, releaseGate: { type: "string" }, dependencies: { type: "array", items: { type: "string" } } },
    required: ["testPlan", "risks", "releaseGate", "dependencies"],
    additionalProperties: false,
  },
};

const runs = new Map<string, RunRecord>();
const model = process.env.MOZAIK_MODEL ?? "gpt-5.4-mini";

function now() {
  return new Date().toISOString();
}

function getRun(runId: string) {
  const run = runs.get(runId);
  if (!run) throw new Error("Mozaik run not found");
  return run;
}

function event(run: RunRecord, type: string, detail: string, agent?: AgentKey) {
  run.events.push({ type, detail, ...(agent ? { agent } : {}), createdAt: now() });
  if (run.events.length > 100) run.events.shift();
  void prisma.mozaikEvent.create({ data: { runId: run.id, type, detail, ...(agent ? { agent } : {}) } }).catch(() => undefined);
}

function agentAction(run: RunRecord, agent: AgentKey, action: string) {
  run.agents[agent].currentAction = action;
}

function publicUrl(value: unknown) {
  if (typeof value !== "string") throw new Error("A public http(s) URL is required");
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol)) throw new Error("Only http(s) URLs are supported");
  const hostname = url.hostname.toLowerCase();
  if (["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(hostname) || hostname.endsWith(".local")) {
    throw new Error("Private and local hosts are not allowed");
  }
  return url;
}

function toolSchema(properties: Record<string, unknown>, required: string[]) {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function buildTools(run: RunRecord, state: RunSharedState, agent: AgentKey): Tool[] {
  const readMemory: Tool = {
    type: "function",
    name: "thred_recall_memory",
    description: "Search Thred durable workspace memory before making a claim.",
    parameters: toolSchema({ query: { type: "string" } }, ["query"]),
    strict: true,
    invoke: async ({ query }: { query: string }) => {
      run.agents[agent].toolCalls += 1;
      agentAction(run, agent, `Searching Thred memory for “${query}”`);
      event(run, "memory.read", `Searching durable memory for: ${query}`, agent);
      if (!process.env.HYDRA_DB_API_KEY) return { matches: [], note: "HYDRA_DB_API_KEY is not configured" };
      const result = await recallLongTermMemory({ workspaceId: run.workspaceId, query, maxResults: 6 });
      return { matches: result.data?.chunks ?? [] };
    },
  };

  const readBoard: Tool = {
    type: "function",
    name: "thred_read_shared_board",
    description: "Read findings already published by other concurrent agents in this run.",
    parameters: toolSchema({}, []),
    strict: true,
    invoke: async () => {
      run.agents[agent].toolCalls += 1;
      agentAction(run, agent, "Reading the shared Thred board");
      event(run, "board.read", `Read ${state.board.length} shared findings`, agent);
      return { findings: state.board };
    },
  };

  const readHandoffs: Tool = {
    type: "function",
    name: "thred_read_handoffs",
    description: "Read the structured work handoffs already published by the other agents.",
    parameters: toolSchema({}, []),
    strict: true,
    invoke: async () => {
      run.agents[agent].toolCalls += 1;
      agentAction(run, agent, "Reading shared agent handoffs");
      event(run, "handoff.read", `Read ${state.handoffs.length} shared handoffs`, agent);
      return { handoffs: state.handoffs };
    },
  };

  const publishHandoff: Tool = {
    type: "function",
    name: "thred_publish_handoff",
    description: "Publish your concrete work handoff to Thred so the other agents can implement, integrate, or test it.",
    parameters: toolSchema({ title: { type: "string" }, summary: { type: "string" }, items: { type: "array", items: { type: "string" } } }, ["title", "summary", "items"]),
    strict: true,
    invoke: async ({ title, summary, items }: { title: string; summary: string; items: string[] }) => {
      run.agents[agent].toolCalls += 1;
      agentAction(run, agent, "Publishing a concrete handoff to Thred");
      const handoff: Handoff = { agent, title: title.trim().slice(0, 160), summary: summary.trim().slice(0, 1200), items: items.map((item) => item.trim().slice(0, 500)).filter(Boolean).slice(0, 12), createdAt: now() };
      state.handoffs.push(handoff);
      run.handoffs.push(handoff);
      event(run, "handoff.published", `${handoff.title}: ${handoff.items.length} deliverable item(s)`, agent);
      return { published: true, handoff };
    },
  };

  const setReleaseGate: Tool = {
    type: "function",
    name: "thred_set_release_gate",
    description: "Set the final QA release gate after reviewing the product brief and both builder handoffs. Only QA & Release may set it.",
    parameters: toolSchema({ status: { type: "string", enum: ["ready", "blocked", "conditional"] }, summary: { type: "string" }, blockers: { type: "array", items: { type: "string" } } }, ["status", "summary", "blockers"]),
    strict: true,
    invoke: async ({ status, summary, blockers }: { status: ReleaseGate["status"]; summary: string; blockers: string[] }) => {
      run.agents[agent].toolCalls += 1;
      if (agent !== "qa") return { accepted: false, note: "Only QA & Release can set the release gate" };
      const gate: ReleaseGate = { status, summary: summary.trim().slice(0, 1200), blockers: blockers.map((item) => item.trim().slice(0, 500)).filter(Boolean).slice(0, 12), createdAt: now() };
      run.releaseGate = gate;
      agentAction(run, agent, `Release gate: ${status}`);
      event(run, "release.gate", `${status}: ${gate.summary}`, agent);
      return { accepted: true, gate };
    },
  };

  const publishFinding: Tool = {
    type: "function",
    name: "thred_publish_finding",
    description: "Publish a concise finding to the shared board so other agents can build on it.",
    parameters: toolSchema({ text: { type: "string" }, sourceUrl: { type: ["string", "null"] } }, ["text", "sourceUrl"]),
    strict: true,
    invoke: async ({ text, sourceUrl }: { text: string; sourceUrl?: string }) => {
      run.agents[agent].toolCalls += 1;
      run.agents[agent].findingCount += 1;
      agentAction(run, agent, "Publishing evidence to the shared board");
      const finding = { agent, text: text.trim().slice(0, 1800), createdAt: now(), ...(sourceUrl ? { sourceUrl: sourceUrl.slice(0, 500) } : {}) } satisfies Finding;
      state.board.push(finding);
      run.findings.push(finding);
      void prisma.mozaikFinding.create({ data: { runId: run.id, agent, text: finding.text, ...(finding.sourceUrl ? { sourceUrl: finding.sourceUrl } : {}) } }).catch(() => undefined);
      event(run, "finding.published", finding.text, agent);
      return { published: true, finding };
    },
  };

  const writeMemory: Tool = {
    type: "function",
    name: "thred_write_memory",
    description: "Save a durable, evidence-backed finding into Thred workspace memory.",
    parameters: toolSchema(
      {
        text: { type: "string" },
        kind: { type: "string", enum: ["fact", "decision", "lesson", "architecture", "preference"] },
      },
      ["text", "kind"],
    ),
    strict: true,
    invoke: async ({ text, kind }: { text: string; kind: "fact" | "decision" | "lesson" | "architecture" | "preference" }) => {
      run.agents[agent].toolCalls += 1;
      run.agents[agent].memoryWriteCount += 1;
      agentAction(run, agent, `Writing a durable ${kind} memory`);
      const clean = text.trim().slice(0, 1800);
      if (!process.env.HYDRA_DB_API_KEY) {
        event(run, "memory.write.skipped", "HydraDB key is not configured", agent);
        return { written: false, note: "HYDRA_DB_API_KEY is not configured" };
      }
      const result = await writeLongTermMemory({
        workspaceId: run.workspaceId,
        sessionId: run.id,
        kind,
        text: clean,
        confidence: 0.86,
      });
      const memoryId = result.data?.results?.[0]?.id;
      run.memoryWrites.push({ agent, text: clean, ...(memoryId ? { memoryId } : {}), createdAt: now() });
      event(run, "memory.write", `Saved ${kind} memory${memoryId ? ` ${memoryId}` : ""}`, agent);
      return { written: true, memoryId };
    },
  };

  const fetchUrl: Tool = {
    type: "function",
    name: "thred_fetch_public_url",
    description: "Fetch a public webpage for primary evidence. Use this for domain or website research; return the URL, status, title, and a bounded text excerpt.",
    parameters: toolSchema({ url: { type: "string" } }, ["url"]),
    strict: true,
    invoke: async ({ url: value }: { url: string }) => {
      run.agents[agent].toolCalls += 1;
      agentAction(run, agent, `Fetching primary evidence from ${value}`);
      const url = publicUrl(value);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch(url, { signal: controller.signal, redirect: "follow", headers: { "user-agent": "Thred-Mozaik/1.0" } });
        const body = (await response.text()).replace(/\s+/g, " ").trim().slice(0, 7000);
        const title = body.match(/<title[^>]*>(.*?)<\/title>/i)?.[1]?.trim().slice(0, 240);
        event(run, "source.fetched", `${response.status} ${url.href}`, agent);
        return { url: url.href, status: response.status, title: title ?? null, excerpt: body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 5000) };
      } finally {
        clearTimeout(timeout);
      }
    },
  };

  const dnsLookup: Tool = {
    type: "function",
    name: "thred_lookup_dns",
    description: "Resolve public DNS records for a domain and report the addresses or failure as evidence.",
    parameters: toolSchema({ domain: { type: "string" } }, ["domain"]),
    strict: true,
    invoke: async ({ domain }: { domain: string }) => {
      run.agents[agent].toolCalls += 1;
      agentAction(run, agent, `Checking DNS for ${domain}`);
      const host = domain.trim().replace(/^https?:\/\//, "").split("/")[0];
      if (!host || host.includes(" ") || host === "localhost") throw new Error("A public domain is required");
      try {
        const records = await lookup(host, { all: true });
        event(run, "source.dns", `${host} resolved to ${records.map((item) => item.address).join(", ")}`, agent);
        return { domain: host, records };
      } catch (error) {
        const message = error instanceof Error ? error.message : "DNS lookup failed";
        event(run, "source.dns.failed", `${host}: ${message}`, agent);
        return { domain: host, records: [], error: message };
      }
    },
  };

  return [readMemory, readBoard, readHandoffs, publishHandoff, setReleaseGate, fetchUrl, dnsLookup, publishFinding, writeMemory];
}

const roles: Array<{ key: AgentKey; name: string; instruction: string }> = [
  {
    key: "product",
    name: "Product Lead",
    instruction:
      "You are the Product Lead. Turn the user's goal into a clear build brief with requirements, acceptance criteria, and open questions. Read the shared Thred board and existing handoffs first, use evidence tools when the goal references an existing product or website, then call thred_publish_handoff with the brief and definition of done so the builders can implement against one shared contract.",
  },
  {
    key: "frontend",
    name: "Frontend Builder",
    instruction:
      "You are the Frontend Builder. Work in parallel with the Backend Builder. Read the shared Product Lead brief, handoffs, and board, then design the screens, states, responsive behavior, and implementation steps needed to deliver the user's task. Call thred_publish_handoff with concrete deliverables, file-level implementation steps, and backend contracts you need. Never claim files changed unless a tool actually changed them.",
  },
  {
    key: "backend",
    name: "Backend Builder",
    instruction:
      "You are the Backend Builder. Work in parallel with the Frontend Builder. Read the shared Product Lead brief, handoffs, and board, then define API routes, data contracts, persistence, auth, external integrations, and implementation steps. Call thred_publish_handoff with concrete endpoint/data deliverables and flag frontend contracts you need. Never claim files changed unless a tool actually changed them.",
  },
  {
    key: "qa",
    name: "QA & Release",
    instruction:
      "You are QA & Release. Work concurrently with the builders. Read the shared board and handoffs repeatedly, compare the product brief with the frontend and backend handoffs, identify integration conflicts, publish a QA handoff, and call thred_set_release_gate with ready, conditional, or blocked. Never hide unknowns or claim code was changed when the team only produced a plan.",
  },
];

function createOpenAIInferenceRunner(): InferenceRunner {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const functionCalls = new Map<string, Record<string, unknown>>();
  const responseIds = new Map<string, string>();
  return {
    async run(request: InferenceRequest): Promise<InferenceResult> {
      const toolResult = [...request.context.items].reverse().find((item: any) => item.type === "tool_use_result") as any;
      const previousResponseId = toolResult ? responseIds.get(toolResult.requestId) : undefined;
      const input = previousResponseId
        ? [{ type: "function_call_output", call_id: toolResult.requestId, output: toolResult.result?.text ?? JSON.stringify(toolResult.result) }]
        : request.context.items.map((item: any) => {
        if (item.type === "developer_message" || item.type === "system_message") {
          return { role: "system", content: item.text };
        }
        if (item.type === "user_message") {
          return { role: "user", content: item.text };
        }
        if (item.type === "model_message") {
          return { role: "assistant", content: item.text };
        }
        if (item.type === "tool_use_request") {
          return functionCalls.get(item.requestId) ?? { type: "function_call", id: item.requestId, call_id: item.requestId, name: item.toolName, arguments: item.toolArguments };
        }
        if (item.type === "tool_use_result") {
          return { type: "function_call_output", call_id: item.requestId, output: item.result?.text ?? JSON.stringify(item.result) };
        }
        if (item.type === "reasoning") {
          if (item.openaiItem) return item.openaiItem;
          return { type: "reasoning", summary: item.summary?.map((summary: any) => ({ type: "summary_text", text: summary.text })) ?? [] };
        }
          return { role: "user", content: String(item.text ?? "") };
        });
      const response = await client.responses.create({
        model: request.model,
        input,
        ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
        max_output_tokens: request.maxOutputTokens,
        parallel_tool_calls: false,
        ...(request.reasoningEffort ? { reasoning: { effort: request.reasoningEffort } } : {}),
        ...(request.tools?.length ? { tools: request.tools.map((tool) => ({ type: "function" as const, name: tool.name, description: tool.description, parameters: tool.parameters, strict: tool.strict })) } : {}),
        ...(request.structuredOutput ? { text: { format: { type: "json_schema" as const, name: request.structuredOutput.name ?? "agent_brief", strict: request.structuredOutput.strict ?? true, schema: request.structuredOutput.schema } } } : {}),
      } as any);
      const items: any[] = [];
      for (const item of response.output ?? []) {
        if (item.type === "message") {
          const text = item.content?.map((content: any) => content.text ?? "").join("").trim();
          if (text) items.push({ type: "model_message", text });
        } else if (item.type === "function_call") {
          functionCalls.set(item.call_id, item as unknown as Record<string, unknown>);
          responseIds.set(item.call_id, response.id);
          items.push({ type: "tool_use_request", requestId: item.call_id, toolName: item.name, toolArguments: item.arguments });
        } else if (item.type === "reasoning") {
          items.push({ type: "reasoning", encryptedContent: item.encrypted_content, summary: item.summary ?? [], openaiItem: item });
        }
      }
      return { items, tokenUsage: undefined, rowResponse: response };
    },
    async *stream() {
      throw new Error("Streaming is not enabled for the Thred GPT-6 compatibility runner yet.");
    },
  };
}

function rawAnswerFromLoop(loop: { completedOperations: readonly any[] }) {
  const messages = loop.completedOperations
    .filter((operation) => operation.type === "inference")
    .flatMap((operation) => operation.result?.items ?? [])
    .filter((item) => item.type === "model_message" && item.text)
    .map((item) => item.text!.trim());
  return messages.at(-1) ?? "The agent completed without a text answer.";
}

function answerFromLoop(loop: { completedOperations: readonly any[] }) {
  const answer = rawAnswerFromLoop(loop);
  try {
    const candidate = answer.match(/\{[\s\S]*\}/)?.[0] ?? answer.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    const parsed = JSON.parse(candidate) as Record<string, unknown>;
    return Object.entries(parsed)
      .map(([key, value]) => {
        const label = key.replace(/([A-Z])/g, " $1").replace(/^./, (letter) => letter.toUpperCase());
        if (Array.isArray(value)) return `${label}:\n${value.map((item) => `- ${String(item)}`).join("\n")}`;
        return `${label}: ${String(value)}`;
      })
      .join("\n\n");
  } catch {
    return answer;
  }
}

function structuredFromLoop(loop: { completedOperations: readonly any[] }) {
  const text = rawAnswerFromLoop(loop).replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function ensureHandoff(run: RunRecord, state: RunSharedState, agent: AgentKey, structured?: Record<string, unknown>) {
  if (!structured || run.handoffs.some((handoff) => handoff.agent === agent)) return;
  const entries = Object.entries(structured);
  const summaryValue = structured.brief ?? structured.approach ?? structured.releaseGate ?? "Structured work output captured from the agent loop.";
  const items = entries.flatMap(([, value]) => Array.isArray(value) ? value.map(String) : []).filter(Boolean).slice(0, 12);
  const handoff: Handoff = {
    agent,
    title: `${roles.find((role) => role.key === agent)?.name ?? agent} handoff`,
    summary: String(summaryValue).slice(0, 1200),
    items,
    createdAt: now(),
  };
  state.handoffs.push(handoff);
  run.handoffs.push(handoff);
  event(run, "handoff.recovered", `${handoff.title} recovered from structured loop output`, agent);
}

async function runNativeMozaikLoop(
  agentModule: ReturnType<typeof defineAgentModule>,
  run: RunRecord,
  agent: AgentKey,
  participantAgent: { id: string },
  tools: Tool[],
  instruction: string,
) {
  const loop = await agentModule.createLoop({
    agentId: participantAgent.id,
    subject: `Thred investigation: ${run.goal}`,
    request: {
      model,
      maxOutputTokens: 700,
      reasoningEffort: "medium",
      tools,
      structuredOutput: { name: `${agent}_brief`, strict: true, schema: outputSchemas[agent] },
      context: {
        items: [
          { type: "developer_message", text: instruction },
          {
            type: "user_message",
            text: `Shared goal: ${run.goal}\n\nYou are one of four concurrent Thred participants. Use Thred memory, shared-board, handoff, release-gate, and public evidence tools. Publish a finding and a concrete handoff before your final answer. Return only the requested JSON object.`,
          },
        ],
      },
    },
  });
  event(run, "agent.loop.created", `Native Mozaik loop ${loop.id} created`, agent);
  const completed = await agentModule.runLoop(loop.id);
  event(run, "agent.loop.completed", `Native Mozaik loop ${completed.id} reached ${completed.stateId}`, agent);
  return { answer: answerFromLoop(completed), structured: structuredFromLoop(completed) };
}

export async function getMozaikRun(runId: string) {
  const live = runs.get(runId);
  if (live) return live;
  const persisted = await prisma.mozaikRun.findUnique({
    where: { id: runId },
    include: { events: { orderBy: { createdAt: "asc" } }, findings: { orderBy: { createdAt: "asc" } } },
  });
  if (!persisted) throw new Error("Mozaik run not found");
  const payload = persisted.finalAnswer && typeof persisted.finalAnswer === "object" ? persisted.finalAnswer as Record<string, any> : {};
  const fallbackAgents = {
    product: { status: persisted.status, toolCalls: 0, findingCount: 0, memoryWriteCount: 0 },
    frontend: { status: persisted.status, toolCalls: 0, findingCount: 0, memoryWriteCount: 0 },
    backend: { status: persisted.status, toolCalls: 0, findingCount: 0, memoryWriteCount: 0 },
    qa: { status: persisted.status, toolCalls: 0, findingCount: 0, memoryWriteCount: 0 },
  };
  return {
    id: persisted.id,
    workspaceId: persisted.workspaceId,
    goal: persisted.goal,
    status: persisted.status as RunRecord["status"],
    startedAt: persisted.startedAt.toISOString(),
    ...(persisted.finishedAt ? { finishedAt: persisted.finishedAt.toISOString() } : {}),
    ...(payload.error ? { error: String(payload.error) } : {}),
    ...(payload.finalAnswer ? { finalAnswer: String(payload.finalAnswer) } : {}),
    agents: payload.agents ?? fallbackAgents,
    handoffs: Array.isArray(payload.handoffs) ? payload.handoffs : [],
    ...(payload.releaseGate ? { releaseGate: payload.releaseGate } : {}),
    findings: persisted.findings.map((finding) => ({ agent: finding.agent as AgentKey, text: finding.text, createdAt: finding.createdAt.toISOString(), ...(finding.memoryId ? { memoryId: finding.memoryId } : {}), ...(finding.sourceUrl ? { sourceUrl: finding.sourceUrl } : {}) })),
    memoryWrites: [],
    events: persisted.events.map((item) => ({ type: item.type, ...(item.agent ? { agent: item.agent as AgentKey } : {}), detail: item.detail, createdAt: item.createdAt.toISOString() })),
  } satisfies RunRecord;
}

export async function listMozaikRuns(workspaceId: string) {
  const persisted = await prisma.mozaikRun.findMany({
    where: { workspaceId },
    orderBy: { startedAt: "desc" },
    take: 12,
    select: { id: true, goal: true, status: true, startedAt: true, finishedAt: true, finalAnswer: true },
  });
  return persisted.map((run) => ({
    id: run.id,
    goal: run.goal,
    status: run.status,
    startedAt: run.startedAt.toISOString(),
    ...(run.finishedAt ? { finishedAt: run.finishedAt.toISOString() } : {}),
    hasSynthesis: Boolean(run.finalAnswer),
  }));
}

export function startMozaikRun(workspaceId: string, goal: string) {
  const trimmedGoal = goal.trim();
  if (!trimmedGoal) throw new Error("Goal is required");
  if (trimmedGoal.length > 2000) throw new Error("Goal must be 2,000 characters or fewer");
  if (!process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY && !process.env.GEMINI_API_KEY) {
    throw new Error("Add an AI provider key to Render first (OPENAI_API_KEY, ANTHROPIC_API_KEY, or GEMINI_API_KEY). Set MOZAIK_MODEL to the matching model.");
  }

  const run: RunRecord = {
    id: randomUUID(),
    workspaceId,
    goal: trimmedGoal,
    status: "queued",
    startedAt: now(),
    agents: {
      product: { status: "queued", toolCalls: 0, findingCount: 0, memoryWriteCount: 0 },
      frontend: { status: "queued", toolCalls: 0, findingCount: 0, memoryWriteCount: 0 },
      backend: { status: "queued", toolCalls: 0, findingCount: 0, memoryWriteCount: 0 },
      qa: { status: "queued", toolCalls: 0, findingCount: 0, memoryWriteCount: 0 },
    },
    findings: [],
    handoffs: [],
    memoryWrites: [],
    events: [],
  };
  runs.set(run.id, run);
  void executeMozaikRun(run).catch((error) => {
    run.status = "failed";
    run.error = error instanceof Error ? error.message : "Mozaik run failed";
    run.finishedAt = now();
    void prisma.mozaikRun.update({ where: { id: run.id }, data: { status: run.status, finalAnswer: { error: run.error }, finishedAt: run.finishedAt } }).catch(() => undefined);
    event(run, "run.failed", run.error);
  });
  return run;
}

async function executeMozaikRun(run: RunRecord) {
  await prisma.mozaikRun.upsert({
    where: { id: run.id },
    create: { id: run.id, workspaceId: run.workspaceId, goal: run.goal, status: "running" },
    update: { status: "running" },
  }).catch(() => undefined);
  run.status = "running";
  event(run, "run.started", "Four specialized build agents are starting concurrently");

  const { initializeRuntime, createSpace, createParticipant, join, sendMessage } = defineRuntime<RunSharedState>();
  const sharedState: RunSharedState = { goal: run.goal, board: run.findings, handoffs: run.handoffs };
  initializeRuntime({ state: sharedState });
  const space = await createSpace(`Thred run ${run.id}`);
  const human = await createParticipant("Human kickoff", ["goal-setting"], [], { role: "human", runId: run.id });
  await join(space.getId(), human);

  const agentModule = defineAgentModule({ inferenceRunnerConfig: { runner: createOpenAIInferenceRunner() } });
  const agents = await Promise.all(
    roles.map(async ({ key, name, instruction }) => {
      const tools = buildTools(run, sharedState, key);
      const agent = await agentModule.createAgent({ name, instruction, tools });
      const participant = await createParticipant(name, ["inference", "thred-memory", "concurrent-collaboration"], [], agent);
      await join(space.getId(), participant);
      return { key, agent, participant, tools, instruction };
    }),
  );

  const cloud = process.env.MOZAIK_API_KEY
    ? createCloudExporter({
      endpoint: process.env.MOZAIK_CLOUD_ENDPOINT ?? "https://api.app.jigjoy.ai",
      projectKey: process.env.MOZAIK_API_KEY,
      participants: () => [human, ...agents.map(({ participant }) => participant)] as any,
      redaction: (process.env.MOZAIK_REDACTION as "none" | "content" | "all" | undefined) ?? "content",
      onSessionUrl: (url) => event(run, "mozaik.cloud.session", `Live observability: ${url}`),
      onError: (error) => event(run, "mozaik.cloud.error", error.message),
    })
    : undefined;
  if (cloud) {
    await join(space.getId(), cloud.participant as any);
    event(run, "mozaik.cloud.connected", `Mozaik Cloud session ${cloud.sessionId} is observing this runtime`);
  } else {
    event(run, "mozaik.cloud.disabled", "Set MOZAIK_API_KEY on the API service to stream this runtime to Mozaik Cloud");
  }

  await sendMessage(space.getId(), human.getId(), run.goal);
  event(run, "runtime.kickoff", `Space ${space.getId()} received the human goal`);

  const completed = await Promise.all(
    agents.map(async ({ key, agent, tools, instruction }) => {
    run.agents[key].status = "running";
    agentAction(run, key, "Starting a native Mozaik loop");
    event(run, "agent.started", `${agent.name} entered a native Mozaik loop`, key);
      try {
        const { answer, structured } = await runNativeMozaikLoop(agentModule, run, key, agent, tools, instruction);
        ensureHandoff(run, sharedState, key, structured);
        if (key === "qa" && !run.releaseGate && structured?.releaseGate) {
          const gateText = String(structured.releaseGate);
          const blockers = Array.isArray(structured.risks) ? structured.risks.map(String).slice(0, 12) : [];
          run.releaseGate = { status: /block|fail|not ready/i.test(gateText) ? "blocked" : blockers.length ? "conditional" : "ready", summary: gateText.slice(0, 1200), blockers, createdAt: now() };
          event(run, "release.gate.recovered", `${run.releaseGate.status}: ${run.releaseGate.summary}`, key);
        }
        run.agents[key] = { ...run.agents[key], status: "completed", currentAction: "Answer assembled", answer, ...(structured ? { structured } : {}) };
        event(run, "agent.completed", "Agent returned its answer", key);
        return { key, answer, structured };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Agent failed";
        run.agents[key] = { ...run.agents[key], status: "failed", currentAction: "Stopped with an error", error: message };
        event(run, "agent.failed", message, key);
        return { key, answer: `Agent failed: ${message}` };
      }
    }),
  );

  run.finalAnswer = [
    `Thred ran ${completed.length} Mozaik agents concurrently on: “${run.goal}”`,
    ...completed.map(({ key, answer }) => `\n${roles.find((role) => role.key === key)!.name}:\n${answer}`),
    `\nShared handoffs: ${run.handoffs.length} concrete handoff(s) are available to the team.`,
    run.releaseGate ? `\nRelease gate: ${run.releaseGate.status.toUpperCase()} — ${run.releaseGate.summary}${run.releaseGate.blockers.length ? `\nBlockers:\n${run.releaseGate.blockers.map((item) => `- ${item}`).join("\n")}` : ""}` : "\nRelease gate: NOT SET — QA did not produce a gate.",
    run.findings.length ? `\nShared evidence published during the run: ${run.findings.length} finding(s).` : "\nNo shared finding was published; inspect the agent answers for details.",
  ].join("\n");
  const completedCount = Object.values(run.agents).filter((agent) => agent.status === "completed").length;
  run.status = completedCount > 0 ? "completed" : "failed";
  run.finishedAt = now();
  await prisma.mozaikRun.update({ where: { id: run.id }, data: { status: run.status, finalAnswer: JSON.parse(JSON.stringify({ goal: run.goal, agents: run.agents, handoffs: run.handoffs, releaseGate: run.releaseGate, finalAnswer: run.finalAnswer })), finishedAt: run.finishedAt } }).catch(() => undefined);
  event(run, run.status === "completed" ? "run.completed" : "run.failed", `${completedCount} of ${roles.length} agents completed; ${roles.length - completedCount} failed`);
  if (cloud) await cloud.end().catch((error) => event(run, "mozaik.cloud.error", error instanceof Error ? error.message : "Mozaik Cloud session could not close"));
}
