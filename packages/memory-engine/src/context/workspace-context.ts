import { prisma } from "@repo/db";
import { buildMemoryContext, type MemoryContext } from "./context-builder.js";
import { queryKeywords } from "./rank/query-intent.js";

export async function buildWorkspaceContext(input: { workspaceId: string; query: string }) {
  const rows = await prisma.workingCheckpoint.findMany({
    where: { workspaceId: input.workspaceId },
    orderBy: { updatedAt: "desc" },
    take: 20,
    select: { id: true, task: true, taskKey: true, status: true, payload: true, updatedAt: true },
  });
  const seen = new Set<string>();
  const keywords = queryKeywords(input.query);
  const selected = rows
    .filter((row) => {
      if (seen.has(row.taskKey)) return false;
      seen.add(row.taskKey);
      const text = queryKeywords(`${row.task} ${JSON.stringify(row.payload)}`);
      return keywords.some((keyword) => text.includes(keyword));
    })
    .slice(0, 6);
  const checkpoints = selected.map(({ payload, ...metadata }) => metadata);
  const memory = await buildMemoryContext(input);
  const context = [
    memory.status === "FOUND" ? `Verified long-term memory:\n${memory.context}` : "",
    ...selected.map((row) => {
      const payload = JSON.stringify(row.payload);
      const nextStep = row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
        ? row.payload.nextStep : undefined;
      const nextStepText = typeof nextStep === "string" ? nextStep : "";
      const truncated = payload.length > 3000 || nextStepText.length > 1000 || row.task.length > 200;
      return `Operational checkpoint (not verified facts) [${row.id}] ${row.task.slice(0, 200)}:\n`
        + `Payload source excerpt:\n${payload.slice(0, 3000)}\n`
        + (nextStepText ? `Next-step source excerpt:\n${nextStepText.slice(0, 1000)}\n` : "")
        + (truncated ? `Excerpt truncated; use thread_resume with taskKey ${JSON.stringify(row.taskKey)} for complete checkpoint.` : "");
    }),
  ]
    .filter(Boolean)
    .join("\n\n");
  const result: MemoryContext = context
    ? {
        status: "FOUND",
        query: input.query,
        context,
        memories: memory.status === "FOUND" ? memory.memories : [],
      }
    : memory;
  return { ...result, checkpoints, longTermAvailable: true };
}
