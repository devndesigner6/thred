export type LongTermMemoryKind = "fact" | "decision" | "lesson" | "architecture" | "preference";
export type MemoryRelation = {
  predicate: "ABOUT" | "FROM_SESSION" | "SUPPORTS" | "SUPERSEDES" | "TOUCHED_FILE";
  target: string;
};
export type LongTermMemoryInput = {
  workspaceId: string;
  sessionId: string;
  kind: LongTermMemoryKind;
  text: string;
  confidence: number;
  evidenceEventIds?: string[];
  sourceMessageIds?: string[];
  files?: string[];
  relations?: MemoryRelation[];
  semanticKey?: string;
  value?: string;
};
export type RecallLongTermMemoryInput = { workspaceId: string; query: string; maxResults?: number };
export type MemoryWriteResponse = { data?: { results?: { id?: string }[] } };
export type MemoryChunk = {
  id?: string;
  chunkUuid?: string;
  chunkContent?: string;
  sourceLastUpdatedTime?: string;
  sourceUploadTime?: string;
  relevancyScore?: number;
  isCurrent?: boolean;
};
export type MemoryQueryResponse = { data?: { chunks?: MemoryChunk[] } };
