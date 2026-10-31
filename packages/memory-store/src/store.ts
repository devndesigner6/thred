import { randomUUID } from "node:crypto";
import type {
  LongTermMemoryInput,
  MemoryQueryResponse,
  MemoryWriteResponse,
  RecallLongTermMemoryInput,
} from "./types.js";

type MemoryRow = {
  id: string;
  workspaceId: string;
  sessionId: string;
  kind: string;
  text: string;
  semanticKey?: string | null;
  currentKey: string | null;
  value?: string | null;
  isCurrent: boolean;
  createdAt: Date;
};
type MemoryDelegate = {
  createManyAndReturn(args: {
    data: Omit<MemoryRow, "createdAt">[];
    select: { id: true };
  }): Promise<{ id: string }[]>;
  findMany(args: {
    where: {
      workspaceId: string;
      semanticKey?: string;
      isCurrent?: boolean;
      OR?: Array<{ text: { contains: string; mode: "insensitive" } }>;
    };
    orderBy: { createdAt: "desc" };
    take: number;
  }): Promise<MemoryRow[]>;
  updateMany(args: {
    where: { workspaceId: string; id: { in: string[] } };
    data: { isCurrent: false; currentKey: null };
  }): Promise<{ count: number }>;
};
export type MemoryDatabase = {
  memoryFact: MemoryDelegate;
  $transaction<T>(operation: (tx: { memoryFact: MemoryDelegate }) => Promise<T>): Promise<T>;
};

function nonempty(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
}

export function validateMemory(input: LongTermMemoryInput) {
  if (!input || typeof input !== "object") throw new Error("Memory input is required");
  nonempty(input.workspaceId, "workspaceId");
  nonempty(input.sessionId, "sessionId");
  nonempty(input.text, "Memory text");
  if ((input.semanticKey === undefined) !== (input.value === undefined))
    throw new Error("Semantic key and value must be supplied together");
  if (input.semanticKey !== undefined) {
    nonempty(input.semanticKey, "Semantic key");
    nonempty(input.value, "Semantic value");
  }
  if (!["fact", "decision", "lesson", "architecture", "preference"].includes(input.kind))
    throw new Error("Invalid memory kind");
  if (
    typeof input.confidence !== "number" ||
    !Number.isFinite(input.confidence) ||
    input.confidence < 0 ||
    input.confidence > 1
  )
    throw new Error("Confidence must be between 0 and 1");
  for (const values of [input.evidenceEventIds, input.sourceMessageIds, input.files]) {
    if (
      values !== undefined &&
      (!Array.isArray(values) || values.some((value) => typeof value !== "string" || !value.trim()))
    )
      throw new Error("Provenance lists must contain non-empty strings");
  }
  if (
    input.relations !== undefined &&
    (!Array.isArray(input.relations) ||
      input.relations.some(
        (relation) =>
          !relation ||
          !["ABOUT", "FROM_SESSION", "SUPPORTS", "SUPERSEDES", "TOUCHED_FILE"].includes(
            relation.predicate,
          ) ||
          typeof relation.target !== "string" ||
          !relation.target.trim(),
      ))
  )
    throw new Error("Invalid memory relation");
}

export function memoryToSentence(input: LongTermMemoryInput): { text: string } {
  validateMemory(input);
  const provenance = [
    `kind=${input.kind}`,
    `session=${input.sessionId}`,
    `confidence=${input.confidence}`,
    input.evidenceEventIds?.length ? `evidence=${input.evidenceEventIds.join(",")}` : undefined,
    input.sourceMessageIds?.length ? `messages=${input.sourceMessageIds.join(",")}` : undefined,
    input.files?.length ? `files=${input.files.join(",")}` : undefined,
    input.relations?.length
      ? `relations=${input.relations.map((relation) => `${relation.predicate}:${relation.target}`).join("|")}`
      : undefined,
  ]
    .filter(Boolean)
    .join("; ");
  return { text: `${input.text.trim()}\n\n[Thred provenance: ${provenance}]` };
}

const stopWords = new Set(
  "a an and are as at be been by can did do does for from had has have how i if in is it its me my of on or our should that the their them there these they this to was we were what when where which who why will with would you your".split(
    " ",
  ),
);
function keywords(query: string) {
  return [
    ...new Set(
      (query.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_'-]*/gu) ?? []).filter(
        (word) => !stopWords.has(word),
      ),
    ),
  ];
}

export function createMemoryStore(database: MemoryDatabase) {
  async function writeLongTermMemories(
    inputs: LongTermMemoryInput[],
  ): Promise<MemoryWriteResponse> {
    if (!Array.isArray(inputs)) throw new Error("Memory inputs must be an array");
    if (!inputs.length) return { data: { results: [] } };
    inputs.forEach(validateMemory);
    if (inputs.some((input) => input.workspaceId !== inputs[0]!.workspaceId))
      throw new Error("A batched memory write must use one workspace");
    const data = inputs.map((input) => ({
      id: randomUUID(),
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      kind: input.kind,
      text: memoryToSentence(input).text,
      isCurrent: true,
      currentKey: input.semanticKey ?? null,
      ...(input.semanticKey !== undefined
        ? { semanticKey: input.semanticKey, value: input.value! }
        : {}),
    }));
    const supersededIds = inputs.flatMap((input) =>
      (input.relations ?? [])
        .filter((relation) => relation.predicate === "SUPERSEDES")
        .map((relation) => relation.target.replace(/^memory:/, "")),
    );
    await database.$transaction(async (tx) => {
      if (supersededIds.length)
        await tx.memoryFact.updateMany({
          where: { workspaceId: inputs[0]!.workspaceId, id: { in: supersededIds } },
          data: { isCurrent: false, currentKey: null },
        });
      const saved = await tx.memoryFact.createManyAndReturn({ data, select: { id: true } });
      const ids = new Set(saved.map((row) => row.id));
      if (data.some((row) => !ids.has(row.id)))
        throw new Error("Database did not acknowledge all memory records");
    });
    return { data: { results: data.map(({ id }) => ({ id })) } };
  }

  async function writeLongTermMemory(input: LongTermMemoryInput): Promise<MemoryWriteResponse> {
    return writeLongTermMemories([input]);
  }

  async function recallLongTermMemory(
    input: RecallLongTermMemoryInput,
  ): Promise<MemoryQueryResponse> {
    nonempty(input.workspaceId, "workspaceId");
    nonempty(input.query, "Recall query");
    const maxResults = input.maxResults ?? 12;
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 200)
      throw new Error("maxResults must be an integer between 1 and 200");
    const terms = keywords(input.query).slice(0, 24);
    if (!terms.length) return { data: { chunks: [] } };
    const rows = await database.memoryFact.findMany({
      where: {
        workspaceId: input.workspaceId,
        OR: terms.map((term) => ({ text: { contains: term, mode: "insensitive" as const } })),
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    // shortcut: rank the newest 200 lexical candidates; add indexed full-text search when workspace history grows.
    const ranked = rows
      .map((row) => {
        const claim = row.text.split("\n\n[Thred provenance:")[0]!.toLowerCase();
        const tokens = new Set(keywords(claim));
        const score = terms.filter((term) => tokens.has(term)).length / terms.length;
        return { row, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || b.row.createdAt.getTime() - a.row.createdAt.getTime());
    return {
      data: {
        chunks: ranked
          .slice(0, maxResults)
          .map(({ row, score }) => ({
            id: row.id,
            chunkContent: row.text,
            sourceUploadTime: row.createdAt.toISOString(),
            sourceLastUpdatedTime: row.createdAt.toISOString(),
            relevancyScore: score,
            isCurrent: row.isCurrent,
          })),
      },
    };
  }
  async function findMemoriesBySemanticKey(input: { workspaceId: string; semanticKey: string }) {
    nonempty(input.workspaceId, "workspaceId");
    nonempty(input.semanticKey, "Semantic key");
    const rows = await database.memoryFact.findMany({
      where: { workspaceId: input.workspaceId, semanticKey: input.semanticKey, isCurrent: true },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    return rows
      .filter((row): row is MemoryRow & { value: string } => typeof row.value === "string")
      .map(({ id, value, createdAt }) => ({ id, value, createdAt }));
  }
  return {
    writeLongTermMemory,
    writeLongTermMemories,
    recallLongTermMemory,
    findMemoriesBySemanticKey,
  };
}
