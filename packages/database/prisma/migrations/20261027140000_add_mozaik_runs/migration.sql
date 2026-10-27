-- CreateTable
CREATE TABLE "MozaikRun" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "goal" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "finalAnswer" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    CONSTRAINT "MozaikRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MozaikEvent" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "agent" TEXT,
    "type" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MozaikEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MozaikFinding" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "agent" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "memoryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MozaikFinding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MozaikRun_workspaceId_startedAt_idx" ON "MozaikRun"("workspaceId", "startedAt");
CREATE INDEX "MozaikEvent_runId_createdAt_idx" ON "MozaikEvent"("runId", "createdAt");
CREATE INDEX "MozaikFinding_runId_createdAt_idx" ON "MozaikFinding"("runId", "createdAt");

-- AddForeignKey
ALTER TABLE "MozaikRun" ADD CONSTRAINT "MozaikRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MozaikEvent" ADD CONSTRAINT "MozaikEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "MozaikRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MozaikFinding" ADD CONSTRAINT "MozaikFinding_runId_fkey" FOREIGN KEY ("runId") REFERENCES "MozaikRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
