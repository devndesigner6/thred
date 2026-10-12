import { useClerk, useSignIn, useUser } from "@clerk/nextjs";

export const clerkConfigured = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

// The deployment remains publicly readable while Clerk is being configured.
// Once the publishable key is present, these delegate to the real Clerk hooks.
export function useOptionalUser() {
  if (!clerkConfigured) return { isLoaded: true, isSignedIn: false, user: null };
  return useUser();
}

export function useOptionalSignIn() {
  if (!clerkConfigured) return { fetchStatus: "idle" as const, signIn: null };
  return useSignIn();
}

export function useOptionalClerk() {
  if (!clerkConfigured) return { signOut: async () => undefined };
  return useClerk();
}
