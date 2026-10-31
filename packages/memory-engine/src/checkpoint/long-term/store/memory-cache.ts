import { memorySemanticKey } from "../../../shared/entity/entity-resolver.js";
import type { MemoryLookup } from "../engine.js";
import type { ExistingMemory } from "../revision/revision-resolver.js";

/** Reuses resolved claims within one ingestion batch while preserving revision order. */
export class CachedMemoryLookup implements MemoryLookup {
  private readonly base: MemoryLookup;
  private readonly current = new Map<string, ExistingMemory>();

  constructor(base: MemoryLookup) {
    this.base = base;
  }

  async findCurrentBySemanticKey(input: {
    workspaceId: string;
    subject: string;
    predicate: string;
  }): Promise<ExistingMemory[]> {
    const cached = this.current.get(this.key(input.workspaceId, input.subject, input.predicate));
    if (cached) return [cached];
    return this.base.findCurrentBySemanticKey(input);
  }

  recordWrite(input: {
    workspaceId: string;
    memoryId: string;
    subject: string;
    predicate: string;
    value: string;
    updatedAt?: Date;
  }): void {
    this.current.set(this.key(input.workspaceId, input.subject, input.predicate), {
      id: input.memoryId,
      subject: input.subject,
      predicate: input.predicate,
      value: input.value,
      updatedAt: input.updatedAt ?? new Date(),
    });
  }

  private key(workspaceId: string, subject: string, predicate: string): string {
    return `${workspaceId}::${memorySemanticKey(subject, predicate)}`;
  }
}
