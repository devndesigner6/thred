"use client";

import { HandleSSOCallback } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { clerkConfigured } from "@/lib/clerk-safe";

export default function SsoCallbackPage() {
  const router = useRouter();

  if (!clerkConfigured) {
    return (
      <main className="grid min-h-screen place-items-center bg-[#fcfcfb] px-6 text-center text-[#242622]">
        <div>
          <h1 className="text-xl font-medium">Google sign-in is not configured yet.</h1>
          <p className="mt-2 text-sm text-[#70766f]">Add the Clerk keys to the deployment, then try again.</p>
        </div>
      </main>
    );
  }

  return (
    <HandleSSOCallback
      navigateToApp={({ decorateUrl }) => {
        const url = decorateUrl("/dashboard");
        if (url.startsWith("http")) window.location.href = url;
        else router.push(url);
      }}
      navigateToSignIn={() => router.push("/sign-in")}
      navigateToSignUp={() => router.push("/sign-in")}
    />
  );
}
