-- Preserve checkpoint references while removing the external memory provider.
ALTER TABLE "WorkingCheckpoint" RENAME COLUMN "hydraMemoryIds" TO "memoryIds";

CREATE TABLE "MemoryFact" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "semanticKey" TEXT,
    "value" TEXT,
    "currentKey" TEXT,
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MemoryFact_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MemoryFact_workspaceId_createdAt_idx" ON "MemoryFact"("workspaceId", "createdAt");
CREATE INDEX "MemoryFact_workspaceId_semanticKey_createdAt_idx" ON "MemoryFact"("workspaceId", "semanticKey", "createdAt");
-- NULL current keys retain any number of historical revisions.
CREATE UNIQUE INDEX "MemoryFact_workspaceId_currentKey_key" ON "MemoryFact"("workspaceId", "currentKey");
