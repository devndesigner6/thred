import { clerkMiddleware } from "@clerk/nextjs/server";

export default clerkMiddleware({
  signInUrl: process.env.NEXT_PUBLIC_CLERK_SIGN_IN_URL ?? "/sign-in",
  signUpUrl: process.env.NEXT_PUBLIC_CLERK_SIGN_UP_URL ?? "/sign-up",
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
    "/__clerk/(.*)",
  ],
};
