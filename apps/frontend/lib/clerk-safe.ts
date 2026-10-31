import { useAuth, useClerk, useSignIn, useUser } from "@clerk/nextjs";

export const clerkConfigured = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

const unconfiguredUser = { isLoaded: true, isSignedIn: false, user: null };
const unconfiguredSignIn = { fetchStatus: "idle" as const, signIn: null };
const unconfiguredClerk = { signOut: async () => undefined };
const unconfiguredAuth = { getToken: async () => null };

function useUnconfiguredUser() { return unconfiguredUser; }
function useUnconfiguredSignIn() { return unconfiguredSignIn; }
function useUnconfiguredClerk() { return unconfiguredClerk; }
function useUnconfiguredAuth() { return unconfiguredAuth; }

// Select once using build-time configuration so hook calls stay unconditional.
export const useOptionalUser = clerkConfigured ? useUser : useUnconfiguredUser;
export const useOptionalSignIn = clerkConfigured ? useSignIn : useUnconfiguredSignIn;
export const useOptionalClerk = clerkConfigured ? useClerk : useUnconfiguredClerk;
export const useOptionalAuth = clerkConfigured ? useAuth : useUnconfiguredAuth;
