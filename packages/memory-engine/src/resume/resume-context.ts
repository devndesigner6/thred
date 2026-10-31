import { resumeWork, type ResumeHandoff } from "@repo/working-memory";
import { buildWorkspaceContext } from "../context/workspace-context.js";

export type ResumeWithMemory = ResumeHandoff & { memoryContext: Awaited<ReturnType<typeof buildWorkspaceContext>> };

/** Restores operational state and evidence-backed durable context in one handoff. */
export async function resumeWithMemory(input: {
  workspaceId: string;
  taskKey?: string;
}): Promise<ResumeWithMemory | null> {
  const handoff = await resumeWork(input);
  if (!handoff) return null;

  const query = [handoff.task, handoff.payload.nextStep, ...handoff.payload.filesChanged]
    .filter(Boolean)
    .join(" ");
  const memoryContext = await buildWorkspaceContext({ workspaceId: input.workspaceId, query });
  return { ...handoff, memoryContext };
}
