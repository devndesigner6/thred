import { randomUUID } from "node:crypto";
import {
  defineAgentModule,
  defineRuntime,
  type InferenceRequest,
  type InferenceResult,
  type InferenceRunner,
  type SharedState,
  type Tool,
} from "@mozaik-ai/core";
import OpenAI from "openai";
import { prisma } from "@repo/db";
import { recallLongTermMemory, writeLongTermMemory } from "@repo/hydra";

type AgentKey = "researcher" | "architect" | "critic";
type AgentStatus = "queued" | "running" | "completed" | "failed";

type Finding = {
  agent: AgentKey;
  text: string;
  createdAt: string;
  memoryId?: string;
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
  agents: Record<AgentKey, { status: AgentStatus; answer?: string; structured?: Record<string, unknown>; error?: string }>;
  findings: Finding[];
  memoryWrites: Array<{ agent: AgentKey; text: string; memoryId?: string; createdAt: string }>;
  events: Array<{ type: string; agent?: AgentKey; detail: string; createdAt: string }>;
};

type RunSharedState = SharedState & {
  goal: string;
  board: Finding[];
};

const outputSchemas: Record<AgentKey, Record<string, unknown>> = {
  researcher: {
    type: "object",
    properties: { facts: { type: "array", items: { type: "string" } }, unknowns: { type: "array", items: { type: "string" } }, sources: { type: "array", items: { type: "string" } } },
    required: ["facts", "unknowns", "sources"],
    additionalProperties: false,
  },
  architect: {
    type: "object",
    properties: { proposal: { type: "string" }, steps: { type: "array", items: { type: "string" } }, tradeoffs: { type: "array", items: { type: "string" } } },
    required: ["proposal", "steps", "tradeoffs"],
    additionalProperties: false,
  },
  critic: {
    type: "object",
    properties: { risks: { type: "array", items: { type: "string" } }, unsupportedClaims: { type: "array", items: { type: "string" } }, recommendation: { type: "string" } },
    required: ["risks", "unsupportedClaims", "recommendation"],
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
      event(run, "board.read", `Read ${state.board.length} shared findings`, agent);
      return { findings: state.board };
    },
  };

  const publishFinding: Tool = {
    type: "function",
    name: "thred_publish_finding",
    description: "Publish a concise finding to the shared board so other agents can build on it.",
    parameters: toolSchema({ text: { type: "string" } }, ["text"]),
    strict: true,
    invoke: async ({ text }: { text: string }) => {
      const finding = { agent, text: text.trim().slice(0, 1800), createdAt: now() } satisfies Finding;
      state.board.push(finding);
      run.findings.push(finding);
      void prisma.mozaikFinding.create({ data: { runId: run.id, agent, text: finding.text } }).catch(() => undefined);
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

  return [readMemory, readBoard, publishFinding, writeMemory];
}

const roles: Array<{ key: AgentKey; name: string; instruction: string }> = [
  {
    key: "researcher",
    name: "Researcher",
    instruction:
      "You are the Researcher. Investigate the user's goal using Thred recall first. Separate known facts from assumptions. Publish your strongest evidence to the shared board and write one durable fact when useful.",
  },
  {
    key: "architect",
    name: "Architect",
    instruction:
      "You are the Architect. Work concurrently with the other agents. Read the shared board, turn evidence into a practical plan, call out dependencies and tradeoffs, publish the plan, and write a durable decision.",
  },
  {
    key: "critic",
    name: "Critic",
    instruction:
      "You are the Critic. Work concurrently, inspect Thred memory and the shared board, challenge weak claims, identify risks, and publish a concise recommendation. Write a durable lesson if you find one.",
  },
];

function createOpenAIInferenceRunner(): InferenceRunner {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const functionCalls = new Map<string, Record<string, unknown>>();
  return {
    async run(request: InferenceRequest): Promise<InferenceResult> {
      const input = request.context.items.map((item: any) => {
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
        max_output_tokens: request.maxOutputTokens,
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

function answerFromLoop(loop: { completedOperations: readonly any[] }) {
  const messages = loop.completedOperations
    .filter((operation) => operation.type === "inference")
    .flatMap((operation) => operation.result?.items ?? [])
    .filter((item) => item.type === "model_message" && item.text)
    .map((item) => item.text!.trim());
  return messages.at(-1) ?? "The agent completed without a text answer.";
}

function structuredFromLoop(loop: { completedOperations: readonly any[] }) {
  const text = answerFromLoop(loop).replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
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
  const fallbackAgents = { researcher: { status: persisted.status }, architect: { status: persisted.status }, critic: { status: persisted.status } };
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
    findings: persisted.findings.map((finding) => ({ agent: finding.agent as AgentKey, text: finding.text, createdAt: finding.createdAt.toISOString(), ...(finding.memoryId ? { memoryId: finding.memoryId } : {}) })),
    memoryWrites: [],
    events: persisted.events.map((item) => ({ type: item.type, ...(item.agent ? { agent: item.agent as AgentKey } : {}), detail: item.detail, createdAt: item.createdAt.toISOString() })),
  } satisfies RunRecord;
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
      researcher: { status: "queued" },
      architect: { status: "queued" },
      critic: { status: "queued" },
    },
    findings: [],
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
  event(run, "run.started", "Three Mozaik agent loops are starting concurrently");

  const { initializeRuntime, createSpace, createParticipant, join, sendMessage } = defineRuntime<RunSharedState>();
  const sharedState: RunSharedState = { goal: run.goal, board: run.findings };
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
      return { key, agent, tools, instruction };
    }),
  );

  await sendMessage(space.getId(), human.getId(), run.goal);
  event(run, "runtime.kickoff", `Space ${space.getId()} received the human goal`);

  const requests = agents.map(({ key, agent, tools, instruction }) => {
    run.agents[key].status = "running";
    event(run, "agent.started", `${agent.name} entered its own Mozaik loop`, key);
    const request: InferenceRequest = {
      model,
      maxOutputTokens: 700,
      streaming: false,
      tools,
      structuredOutput: { name: `${key}_brief`, schema: outputSchemas[key], strict: true },
      context: {
        items: [
          { type: "developer_message", text: instruction },
          { type: "user_message", text: `Shared goal: ${run.goal}\n\nRun concurrently. Use the Thred tools. Publish a finding before your final answer. Return only the requested JSON object.` },
        ],
      },
    };
    return { key, agent, request };
  });

  const loops = await Promise.all(requests.map(({ agent, request }) => agentModule.createLoop({ subject: run.goal, agentId: agent.id, request })));
  const completed = await Promise.all(
    loops.map(async (loop, index) => {
      const requestEntry = requests[index]!;
      const key = requestEntry.key;
      try {
        const finishedLoop = await agentModule.runLoop(loop.id);
        const answer = answerFromLoop(finishedLoop);
        const structured = structuredFromLoop(finishedLoop);
        run.agents[key] = { status: "completed", answer, ...(structured ? { structured } : {}) };
        event(run, "agent.completed", "Agent returned its answer", key);
        return { key, answer, structured };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Agent failed";
        run.agents[key] = { status: "failed", error: message };
        event(run, "agent.failed", message, key);
        return { key, answer: `Agent failed: ${message}` };
      }
    }),
  );

  run.finalAnswer = [
    `Thred ran ${completed.length} Mozaik agents concurrently on: “${run.goal}”`,
    ...completed.map(({ key, answer }) => `\n${roles.find((role) => role.key === key)!.name}:\n${answer}`),
    run.findings.length ? `\nShared evidence published during the run: ${run.findings.length} finding(s).` : "\nNo shared finding was published; inspect the agent answers for details.",
  ].join("\n");
  run.status = "completed";
  run.finishedAt = now();
  await prisma.mozaikRun.update({ where: { id: run.id }, data: { status: run.status, finalAnswer: JSON.parse(JSON.stringify({ goal: run.goal, agents: run.agents, finalAnswer: run.finalAnswer })), finishedAt: run.finishedAt } }).catch(() => undefined);
  event(run, "run.completed", "All concurrent Mozaik loops finished");
}
