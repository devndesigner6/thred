-- Link existing local users to Clerk identities without changing workspace ownership.
ALTER TABLE "user" ADD COLUMN "clerkId" TEXT;

CREATE UNIQUE INDEX "user_clerkId_key" ON "user"("clerkId");
