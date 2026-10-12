import { currentUser as clerkCurrentUser, auth } from "@clerk/nextjs/server";
import { upsertLocalUser } from "@repo/db";

export async function getCurrentLocalUser() {
  const { userId } = await auth();
  if (!userId) return null;

  const clerkUser = await clerkCurrentUser();
  if (!clerkUser) return null;

  const email =
    clerkUser.primaryEmailAddress?.emailAddress ??
    clerkUser.emailAddresses[0]?.emailAddress;
  if (!email) throw new Error("The signed-in Clerk user has no email address");

  const name =
    clerkUser.fullName?.trim() ||
    clerkUser.username?.trim() ||
    email.split("@")[0] ||
    "Thred user";

  return upsertLocalUser({
    clerkId: userId,
    name,
    email,
    emailVerified: clerkUser.primaryEmailAddress?.verification?.status === "verified",
    image: clerkUser.imageUrl,
  });
}
