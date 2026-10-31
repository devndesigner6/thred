import type { CheckpointStatus } from "@repo/db";
import type { CheckpointPayload } from "./schema.js";
import { findLatestResumableCheckpoint } from "./resolver.js";

type ResumeWorkInput = {
  workspaceId: string;
  taskKey?: string;
};

export type ResumeHandoff = {
  checkpointId: string;
  task: string;
  taskKey: string;
  status: CheckpointStatus;
  payload: CheckpointPayload;
  memoryIds: string[];
  updatedAt: Date;
};

/**
 * Produces a compact, provider-neutral handoff. The MCP layer can add
 * long-term PostgreSQL context using `memoryIds` in a later step.
 */
export async function resumeWork(input: ResumeWorkInput): Promise<ResumeHandoff | null> {
  const checkpoint = await findLatestResumableCheckpoint(input);

  if (!checkpoint) return null;

  return {
    checkpointId: checkpoint.id,
    task: checkpoint.task,
    taskKey: checkpoint.taskKey,
    status: checkpoint.status,
    payload: checkpoint.payload as CheckpointPayload,
    memoryIds: checkpoint.memoryIds,
    updatedAt: checkpoint.updatedAt,
  };
}
