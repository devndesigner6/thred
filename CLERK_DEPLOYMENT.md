# Thred Clerk deployment checklist

This migration replaces Better Auth with Clerk while keeping the existing Thred UI and workspace ownership model.

## 1. Create and configure Clerk

1. Create or open the Clerk application.
2. Enable **Google** under **User & authentication → Social connections**.
3. In Clerk, add these allowed origins / redirect URLs for each environment:
   - `http://localhost:3000`
   - the Vercel production URL
   - the final custom Thred domain, if different
   - the matching `/sso-callback` URL when Clerk asks for callback URLs
4. If using custom Google OAuth credentials, copy Clerk’s displayed redirect URI into Google Cloud Console. Do not put Google client secrets in this repository.
5. Copy the Clerk **Publishable Key** and **Secret Key** from the Clerk API keys page.

The custom Thred button starts Google authentication with Clerk’s `oauth_google` strategy and completes at `/sso-callback`.

## 2. Vercel frontend environment variables

Set these in the Vercel project whose root directory is `apps/frontend`:

```text
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_...
CLERK_SECRET_KEY=sk_live_...
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
NEXT_PUBLIC_APP_URL=https://your-thred-domain.example
NEXT_PUBLIC_API_URL=https://your-render-api.example
DATABASE_URL=<the same PostgreSQL connection string used by Render>
CREDENTIAL_ENCRYPTION_SECRET=<the same random 32+ character secret used by Render>
NODE_ENV=production
```

If you have existing encrypted BYOK credentials from the Better Auth deployment, also keep the old value temporarily:

```text
BETTER_AUTH_SECRET=<old Better Auth secret>
```

New provider credentials are encrypted with `CREDENTIAL_ENCRYPTION_SECRET`. The old variable is only a migration fallback for existing records.

## 3. Render API environment variables

The supplied `render.yaml` deploys PostgreSQL plus `apps/api`. Render creates `DATABASE_URL` from the database automatically. Set these `sync: false` values in the Render dashboard:

```text
FRONTEND_ORIGIN=https://your-thred-domain.example
CLERK_PUBLISHABLE_KEY=pk_live_...
CLERK_SECRET_KEY=sk_live_...
CLERK_JWT_KEY=<optional Clerk JWKS public key for networkless verification>
CREDENTIAL_ENCRYPTION_SECRET=<same value as Vercel>
MODEL_PROVIDER=openai
OPENAI_API_KEY=<required for Studio; also used for OpenAI extraction>
MOZAIK_MODEL=gpt-5.4-mini
```

Optional model variables from `.env.example` can be added when needed:

```text
MEMORY_EXTRACTION_PROVIDER=
MEMORY_EXTRACTION_MODEL=
MODEL_API_KEY=
MODEL_BASE_URL=
GROQ_API_KEY=
GEMINI_API_KEY=
XAI_API_KEY=
OPENROUTER_API_KEY=
```

Keep `BETTER_AUTH_SECRET` on Render too if the existing database contains BYOK records encrypted with it.

Use Node 24+ on both hosts. PostgreSQL stores durable memory, run history, and checkpoint/resume data. For optional Mozaik Cloud telemetry, configure `MOZAIK_API_KEY` and `MOZAIK_PROJECT_ID` from the same Cloud account, plus `MOZAIK_REDACTION=content`. Never expose these credentials in frontend variables or screenshots. Run one API instance until orchestration uses a shared job worker; process-interrupted agent execution does not resume automatically.

## 4. Database migration

The Render Blueprint runs Prisma migrations during pre-deploy. The migration adds a nullable unique `user.clerkId` field. On first Clerk sign-in, Thred matches an existing local user by email and attaches the Clerk ID, preserving workspace ownership. New users are created with their Clerk ID as the local ID.

If applying manually:

```bash
npm ci
npm run db:deploy --workspace=@repo/db
```

## 5. Deployment order

1. Configure the Clerk Google connection and allowed origins.
2. Deploy the Render API and database with the Render variables above.
3. Deploy `apps/frontend` to Vercel with the Vercel variables above.
4. Set `FRONTEND_ORIGIN` in Render to the final Vercel/custom-domain origin.
5. Test `/`, `/sign-in`, Google sign-in, `/sso-callback`, workspace creation, MCP key creation, and provider credentials.

Never commit `.env`, `.env.local`, Clerk secret keys, model keys, database URLs, or BYOK keys.
