"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AuthPage } from "@/components/ui/auth-page";
import { useOptionalUser } from "@/lib/clerk-safe";

/** The post-login onboarding step deliberately reuses the split auth composition. */
export default function WorkspaceOnboardingPage() {
  const router = useRouter();
  const { isLoaded, isSignedIn } = useOptionalUser();
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (isLoaded && !isSignedIn) router.replace("/sign-in");
  }, [isLoaded, isSignedIn, router]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/workspaces", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: form.get("workspaceName") }),
    });
    setIsSubmitting(false);
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: string } | null;
      setError(body?.error ? `Workspace creation failed: ${body.error}` : `Workspace creation failed (HTTP ${response.status}).`);
      return;
    }
    router.push("/dashboard");
  }

  if (!isLoaded || !isSignedIn) return null;
  return <AuthPage mode="workspace" error={error} isSubmitting={isSubmitting} onSubmit={handleSubmit} />;
}
