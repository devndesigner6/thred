"use client";

import { HandleSSOCallback } from "@clerk/nextjs";
import { useRouter } from "next/navigation";

export default function SsoCallbackPage() {
  const router = useRouter();

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
