"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AuthPage } from "@/components/ui/auth-page";
import { useOptionalSignIn, useOptionalUser } from "@/lib/clerk-safe";

export default function SignInPage() {
  const router = useRouter();
  const { isLoaded: isUserLoaded, isSignedIn } = useOptionalUser();
  const { fetchStatus, signIn } = useOptionalSignIn();
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const warmApi = () => {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL;
    if (!apiUrl) return;
    void fetch(`${apiUrl.replace(/\/$/, "")}/health`, {
      cache: "no-store",
      mode: "cors",
    }).catch(() => undefined);
  };

  useEffect(() => {
    if (isUserLoaded && isSignedIn) router.replace("/dashboard");
  }, [isUserLoaded, isSignedIn, router]);

  useEffect(() => {
    warmApi();
  }, []); // Warm the API while the visitor is deciding whether to continue.

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);
    warmApi();
    if (fetchStatus === "fetching" || !signIn) {
      setIsSubmitting(false);
      setError("Authentication is still loading. Please try again.");
      return;
    }
    const result = await signIn.sso({
      strategy: "oauth_google",
      redirectCallbackUrl: "/sso-callback",
      redirectUrl: "/dashboard",
    });
    if (result?.error) {
      setIsSubmitting(false);
      setError("Unable to start Google sign-in. Check the Clerk OAuth configuration and try again.");
    }
  }

  if (isSignedIn) return null;
  return <AuthPage mode="sign-in" error={error} isSubmitting={isSubmitting} onSubmit={handleSubmit} />;
}
