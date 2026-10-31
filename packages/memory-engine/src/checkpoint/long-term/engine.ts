import { writeLongTermMemory, type MemoryWriteResponse, type LongTermMemoryInput } from "@repo/memory-store";
import type { LongTermMemoryClaim } from "@repo/memory-extractor";
import { buildStoredMemory } from "./graph/graph-builder.js";
import {
  resolveRevision,
  type ExistingMemory,
  type RevisionDecision,
} from "./revision/revision-resolver.js";

export type MemoryLookup = {
  findCurrentBySemanticKey(input: {
    workspaceId: string;
    subject: string;
    predicate: string;
  }): Promise<ExistingMemory[]>;
  /** Implemented by lookups that track writes before PostgreSQL finishes indexing. */
  recordWrite?(input: {
    workspaceId: string;
    memoryId: string;
    subject: string;
    predicate: string;
    value: string;
  }): void;
};

export type ProcessLongTermClaimInput = {
  signal?: AbortSignal;
  workspaceId: string;
  sessionId: string;
  evidenceEventIds: string[];
  occurredAt?: string;
  claim: LongTermMemoryClaim;
};

export type ProcessedLongTermClaim = {
  decision: RevisionDecision;
  memoryResponse?: MemoryWriteResponse;
};

export type ResolvedLongTermClaim = {
  decision: RevisionDecision;
  memory?: LongTermMemoryInput;
};

/** Resolves a claim without writing it, allowing safe per-session batching. */
export async function resolveLongTermClaim(
  lookup: MemoryLookup,
  input: ProcessLongTermClaimInput,
): Promise<ResolvedLongTermClaim> {
  const existing = await lookup.findCurrentBySemanticKey({
    workspaceId: input.workspaceId,
    subject: input.claim.subject,
    predicate: input.claim.predicate,
  });
  const decision = resolveRevision(input.claim, existing);
  if (decision.operation === "IGNORE") return { decision };
  return {
    decision,
    memory: buildStoredMemory(input.claim, decision, {
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      evidenceEventIds: input.evidenceEventIds,
      occurredAt: input.occurredAt,
    }),
  };
}

/** Resolves a claim before any PostgreSQL write, preserving revision history. */
export async function processLongTermClaim(
  lookup: MemoryLookup,
  input: ProcessLongTermClaimInput,
): Promise<ProcessedLongTermClaim> {
  const resolved = await resolveLongTermClaim(lookup, input);
  input.signal?.throwIfAborted();
  if (!resolved.memory) return { decision: resolved.decision };
  const memoryResponse = await writeLongTermMemory(resolved.memory);
  return { decision: resolved.decision, memoryResponse };
}
