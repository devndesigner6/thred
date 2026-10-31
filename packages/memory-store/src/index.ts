import { prisma } from "@repo/db";
import { createMemoryStore } from "./store.js";

export const {
  writeLongTermMemory,
  writeLongTermMemories,
  recallLongTermMemory,
  findMemoriesBySemanticKey,
} = createMemoryStore(prisma);
export { memoryToSentence, validateMemory } from "./store.js";
export type {
  LongTermMemoryInput,
  LongTermMemoryKind,
  MemoryRelation,
  RecallLongTermMemoryInput,
  MemoryWriteResponse,
  MemoryQueryResponse,
  MemoryChunk,
} from "./types.js";
