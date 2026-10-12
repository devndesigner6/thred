import { prisma } from "./client.js";

export type LocalUserInput = {
  clerkId: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image?: string | null;
};

/**
 * Maps a Clerk identity to the local User row used by workspace ownership.
 * Existing users are matched by email once so a Better Auth migration does
 * not orphan their workspaces.
 */
export async function upsertLocalUser(input: LocalUserInput) {
  const byClerkId = await prisma.user.findUnique({
    where: { clerkId: input.clerkId },
  });
  const byEmail = await prisma.user.findUnique({
    where: { email: input.email },
  });

  if (byClerkId && byEmail && byClerkId.id !== byEmail.id) {
    throw new Error("Clerk identity and email belong to different local users");
  }

  const existing = byClerkId ?? byEmail;
  const data = {
    clerkId: input.clerkId,
    name: input.name,
    email: input.email,
    emailVerified: input.emailVerified,
    image: input.image ?? null,
    updatedAt: new Date(),
  };

  if (existing) {
    return prisma.user.update({
      where: { id: existing.id },
      data,
    });
  }

  return prisma.user.create({
    data: {
      id: input.clerkId,
      ...data,
      createdAt: new Date(),
    },
  });
}
