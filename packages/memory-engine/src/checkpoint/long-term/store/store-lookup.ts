import { findMemoriesBySemanticKey } from "@repo/memory-store";
import { memorySemanticKey } from "../../../shared/entity/entity-resolver.js";
import type { MemoryLookup } from "../engine.js";
import type { ExistingMemory } from "../revision/revision-resolver.js";

/** Reads exact canonical keys rather than reconstructing claims from display text. */
export class StoreMemoryLookup implements MemoryLookup {
  constructor(private readonly find = findMemoriesBySemanticKey) {}

  async findCurrentBySemanticKey(input: {
    workspaceId: string;
    subject: string;
    predicate: string;
  }): Promise<ExistingMemory[]> {
    const rows = await this.find({
      workspaceId: input.workspaceId,
      semanticKey: memorySemanticKey(input.subject, input.predicate),
    });
    return rows.map((row) => ({
      id: row.id,
      subject: input.subject,
      predicate: input.predicate,
      value: row.value,
      updatedAt: row.createdAt,
    }));
  }
}
