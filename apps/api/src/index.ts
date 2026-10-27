import "dotenv/config";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { clerkClient, clerkMiddleware, getAuth } from "@clerk/express";
import { prisma, upsertLocalUser } from "@repo/db";
import { mcpRouter } from "./mcp-routes.js";
import { getMozaikRun, listMozaikRuns, startMozaikRun } from "./mozaik-orchestrator.js";

const app = express();
const port = Number(process.env.PORT ?? 8080);
const frontendOrigin = process.env.FRONTEND_ORIGIN ?? "http://localhost:3000";
const clerkConfigured = Boolean(process.env.CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY);
const rateLimitWindowMs = 60_000;
const rateLimitMaxRequests = 120;

type RateLimitBucket = { count: number; resetAt: number };
const rateLimitBuckets = new Map<string, RateLimitBucket>();

type AuthenticatedRequest = Request & {
    user?: { id: string; email: string; name: string };
};

if (clerkConfigured) {
    app.use(clerkMiddleware({
        authorizedParties: [frontendOrigin],
        ...(process.env.CLERK_JWT_KEY ? { jwtKey: process.env.CLERK_JWT_KEY } : {}),
    }));
}
app.use(express.json());
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", frontendOrigin);
    res.header("Access-Control-Allow-Credentials", "true");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
});

/**
 * Lightweight per-process protection for the public API. For multi-instance
 * deployments, replace this Map with a shared store (such as Redis).
 */
app.use("/api", (req, res, next) => {
    const now = Date.now();
    const client = req.ip || req.socket.remoteAddress || "unknown";
    const current = rateLimitBuckets.get(client);
    const bucket = !current || current.resetAt <= now
        ? { count: 0, resetAt: now + rateLimitWindowMs }
        : current;

    bucket.count += 1;
    rateLimitBuckets.set(client, bucket);

    if (rateLimitBuckets.size > 10_000) {
        for (const [key, entry] of rateLimitBuckets) {
            if (entry.resetAt <= now) rateLimitBuckets.delete(key);
        }
    }

    res.setHeader("X-RateLimit-Limit", rateLimitMaxRequests);
    res.setHeader("X-RateLimit-Remaining", Math.max(0, rateLimitMaxRequests - bucket.count));
    res.setHeader("X-RateLimit-Reset", Math.ceil(bucket.resetAt / 1000));

    if (bucket.count > rateLimitMaxRequests) {
        res.setHeader("Retry-After", Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)));
        return res.status(429).json({ error: "Too many requests. Please try again shortly." });
    }
    next();
});

/** Validates the Clerk session before protected API handlers run. */
async function requireAuth(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
) {
    try {
        if (!clerkConfigured) {
            return res.status(503).json({ error: "Authentication is not configured" });
        }
        const { isAuthenticated, userId } = getAuth(req);
        if (!isAuthenticated || !userId) {
            return res.status(401).json({ error: "Unauthorized" });
        }

        const clerkUser = await clerkClient.users.getUser(userId);
        const email = clerkUser.primaryEmailAddress?.emailAddress ?? clerkUser.emailAddresses[0]?.emailAddress;
        if (!email) return res.status(401).json({ error: "Clerk user has no email address" });
        const localUser = await upsertLocalUser({
            clerkId: userId,
            name: clerkUser.fullName?.trim() || clerkUser.username?.trim() || email.split("@")[0] || "Thred user",
            email,
            emailVerified: clerkUser.primaryEmailAddress?.verification?.status === "verified",
            image: clerkUser.imageUrl,
        });

        req.user = { id: localUser.id, email: localUser.email, name: localUser.name };
        next();
    } catch (error) {
        next(error);
    }
}

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.use("/api/mcp", mcpRouter);

/** Starts a real concurrent Mozaik team run for one Thred workspace. */
app.post("/api/workspaces/:slug/mozaik/runs", requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try {
        const workspace = await workspaceForUser(req.user!.id, param(req, "slug"));
        if (!workspace) return res.status(404).json({ error: "Workspace not found" });
        const goal = typeof req.body?.goal === "string" ? req.body.goal : "";
        const run = startMozaikRun(workspace.id, goal);
        res.status(202).json({ run });
    } catch (error) {
        if (error instanceof Error && /Add an AI provider key|Goal is required|Goal must be/.test(error.message)) {
            return res.status(400).json({ error: error.message });
        }
        next(error);
    }
});

/** Lists recent investigations so the workspace can reopen and replay real runs. */
app.get("/api/workspaces/:slug/mozaik/runs", requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try {
        const workspace = await workspaceForUser(req.user!.id, param(req, "slug"));
        if (!workspace) return res.status(404).json({ error: "Workspace not found" });
        res.json({ runs: await listMozaikRuns(workspace.id) });
    } catch (error) { next(error); }
});

/** Returns live Mozaik agent states, findings, memory writes, and final synthesis. */
app.get("/api/workspaces/:slug/mozaik/runs/:runId", requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try {
        const workspace = await workspaceForUser(req.user!.id, param(req, "slug"));
        if (!workspace) return res.status(404).json({ error: "Workspace not found" });
        const run = await getMozaikRun(param(req, "runId"));
        if (run.workspaceId !== workspace.id) return res.status(404).json({ error: "Mozaik run not found" });
        res.json({ run });
    } catch (error) {
        if (error instanceof Error && error.message === "Mozaik run not found") {
            return res.status(404).json({ error: error.message });
        }
        next(error);
    }
});

app.get("/api/me", requireAuth, (req: AuthenticatedRequest, res) => {
    res.json({ user: req.user });
});

function slugify(value: string) {
    return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
}

/** Reads a URL param like :slug as a plain string ("" if missing). */
function param(req: Request, name: string): string {
    const value = req.params[name];
    return typeof value === "string" ? value : "";
}

const supportedProviders = new Set(["openai", "groq", "xai", "openrouter", "ollama", "custom"]);

function credentialEncryptionKey() {
    const secret = process.env.CREDENTIAL_ENCRYPTION_SECRET ?? process.env.BETTER_AUTH_SECRET;
    if (!secret || secret.length < 32) {
        throw new Error("CREDENTIAL_ENCRYPTION_SECRET must be at least 32 characters");
    }
    return createHash("sha256").update(secret).digest();
}

function encryptProviderKey(value: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", credentialEncryptionKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return `${iv.toString("base64url")}.${ciphertext.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}`;
}

async function workspaceForUser(userId: string, slug: string) {
    return prisma.workspace.findFirst({
        where: { slug, ownerId: userId },
    });
}

/** Lists workspaces the signed-in person can open in the product. */
app.get("/api/workspaces", requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try {
        const workspaces = await prisma.workspace.findMany({
            where: { ownerId: req.user!.id },
            select: { id: true, name: true, slug: true, createdAt: true },
            orderBy: { updatedAt: "desc" },
        });
        res.json({ workspaces });
    } catch (error) { next(error); }
});

/** Creates the first/minimal workspace and gives its creator ownership. */
app.post("/api/workspaces", requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try {
        const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
        if (!name) return res.status(400).json({ error: "Workspace name is required" });
        const base = slugify(name) || "workspace";
        let slug = base;
        let attempt = 2;
        while (await prisma.workspace.findUnique({ where: { slug }, select: { id: true } })) slug = `${base}-${attempt++}`;
        const workspace = await prisma.workspace.create({
            data: { name, slug, ownerId: req.user!.id },
            select: { id: true, name: true, slug: true },
        });
        res.status(201).json({ workspace });
    } catch (error) { next(error); }
});

/** Renames a workspace without changing its stable MCP slug. */
app.patch("/api/workspaces/:slug", requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try {
        const slug = param(req, "slug");
        const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
        if (!name || name.length > 80) {
            return res.status(400).json({ error: "Use a workspace name between 1 and 80 characters." });
        }
        const workspace = await workspaceForUser(req.user!.id, slug);
        if (!workspace) return res.status(404).json({ error: "Workspace not found" });
        const updated = await prisma.workspace.update({
            where: { id: workspace.id },
            data: { name },
            select: { id: true, name: true, slug: true },
        });
        res.json({ workspace: updated });
    } catch (error) { next(error); }
});

/** Dashboard data stays operational: checkpoints/evals live in Postgres; durable memory remains in HydraDB. */
app.get("/api/workspaces/:slug/overview", requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try {
        const slug = param(req, "slug");
        if (!slug) return res.status(400).json({ error: "Workspace slug is required" });
        const workspace = await workspaceForUser(req.user!.id, slug);
        if (!workspace) return res.status(404).json({ error: "Workspace not found" });
        const [agentCount, checkpointCount, latestSessions, latestCheckpoints] = await Promise.all([
            prisma.agentSession.count({ where: { workspaceId: workspace.id } }),
            prisma.workingCheckpoint.count({ where: { workspaceId: workspace.id, status: { in: ["IN_PROGRESS", "BLOCKED"] } } }),
            prisma.agentSession.findMany({ where: { workspaceId: workspace.id }, orderBy: { startedAt: "desc" }, take: 3, select: { id: true, agent: true, startedAt: true, endedAt: true } }),
            prisma.workingCheckpoint.findMany({ where: { workspaceId: workspace.id, status: { in: ["IN_PROGRESS", "BLOCKED"] } }, orderBy: { updatedAt: "desc" }, take: 3, select: { id: true, task: true, status: true, updatedAt: true, payload: true, session: { select: { agent: true } } } }),
        ]);
        res.json({ metrics: { agentCount, checkpointCount }, latestSessions, latestCheckpoints });
    } catch (error) { next(error); }
});

/** Lists safe metadata for workspace model-provider credentials. */
app.get("/api/workspaces/:slug/providers", requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try {
        const workspace = await workspaceForUser(req.user!.id, param(req, "slug"));
        if (!workspace) return res.status(404).json({ error: "Workspace not found" });
        const providers = await prisma.providerCredential.findMany({
            where: { workspaceId: workspace.id },
            orderBy: { updatedAt: "desc" },
            select: { id: true, provider: true, label: true, model: true, baseUrl: true, keyHint: true, createdAt: true, updatedAt: true },
        });
        res.json({ providers });
    } catch (error) { next(error); }
});

/** Saves an encrypted model-provider key without ever returning the secret. */
app.put("/api/workspaces/:slug/providers", requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try {
        const workspace = await workspaceForUser(req.user!.id, param(req, "slug"));
        if (!workspace) return res.status(404).json({ error: "Workspace not found" });
        const provider = typeof req.body?.provider === "string" ? req.body.provider.trim().toLowerCase() : "";
        const key = typeof req.body?.key === "string" ? req.body.key.trim() : "";
        const model = typeof req.body?.model === "string" ? req.body.model.trim() : "";
        const label = typeof req.body?.label === "string" && req.body.label.trim() ? req.body.label.trim().slice(0, 80) : provider;
        const baseUrl = typeof req.body?.baseUrl === "string" && req.body.baseUrl.trim() ? req.body.baseUrl.trim().replace(/\/$/, "") : null;
        if (!supportedProviders.has(provider) || !model || (!["custom", "ollama"].includes(provider) && !key)) {
            return res.status(400).json({ error: "Provider, model, and API key are required (except Ollama/custom local endpoints)." });
        }
        if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
            return res.status(400).json({ error: "Base URL must start with http:// or https://" });
        }
        const saved = await prisma.providerCredential.upsert({
            where: { workspaceId_provider: { workspaceId: workspace.id, provider } },
            create: { workspaceId: workspace.id, provider, label, model, baseUrl, encryptedKey: encryptProviderKey(key || "local"), keyHint: key ? `…${key.slice(-4)}` : "local" },
            update: { label, model, baseUrl, ...(key ? { encryptedKey: encryptProviderKey(key), keyHint: `…${key.slice(-4)}` } : {}) },
            select: { id: true, provider: true, label: true, model: true, baseUrl: true, keyHint: true, createdAt: true, updatedAt: true },
        });
        res.json({ provider: saved });
    } catch (error) { next(error); }
});

/** Removes the selected workspace provider and its encrypted key. */
app.delete("/api/workspaces/:slug/providers", requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try {
        const workspace = await workspaceForUser(req.user!.id, param(req, "slug"));
        if (!workspace) return res.status(404).json({ error: "Workspace not found" });
        const provider = typeof req.query.provider === "string" ? req.query.provider.trim().toLowerCase() : "";
        if (!provider || !supportedProviders.has(provider)) return res.status(400).json({ error: "Unknown provider" });
        await prisma.providerCredential.deleteMany({ where: { workspaceId: workspace.id, provider } });
        res.json({ ok: true });
    } catch (error) { next(error); }
});

/** Lists only safe API-key metadata. The secret is returned exactly once at creation. */
app.get("/api/workspaces/:slug/api-keys", requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try {
        const slug = param(req, "slug");
        if (!slug) return res.status(400).json({ error: "Workspace slug is required" });
        const workspace = await workspaceForUser(req.user!.id, slug);
        if (!workspace) return res.status(404).json({ error: "Workspace not found" });
        const apiKeys = await prisma.apiKey.findMany({
            where: { workspaceId: workspace.id },
            orderBy: { createdAt: "desc" },
            select: { id: true, name: true, keyPrefix: true, createdAt: true, lastUsedAt: true, revokedAt: true },
        });
        res.json({ apiKeys });
    } catch (error) { next(error); }
});

/** Creates a workspace-scoped MCP key. Persist only its SHA-256 hash. */
app.post("/api/workspaces/:slug/api-keys", requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try {
        const slug = param(req, "slug");
        if (!slug) return res.status(400).json({ error: "Workspace slug is required" });
        const workspace = await workspaceForUser(req.user!.id, slug);
        if (!workspace) return res.status(404).json({ error: "Workspace not found" });
        const name = typeof req.body?.name === "string" && req.body.name.trim() ? req.body.name.trim().slice(0, 80) : "MCP key";
        const secret = `thrd_sk_${randomBytes(24).toString("base64url")}`;
        const apiKey = await prisma.apiKey.create({
            data: {
                workspaceId: workspace.id,
                name,
                keyPrefix: secret.slice(0, 15),
                keyHash: createHash("sha256").update(secret).digest("hex"),
            },
            select: { id: true, name: true, keyPrefix: true, createdAt: true, lastUsedAt: true, revokedAt: true },
        });
        res.status(201).json({ apiKey, secret });
    } catch (error) { next(error); }
});

/** Revocation is reversible only by issuing a replacement key. */
app.post("/api/workspaces/:slug/api-keys/:keyId/revoke", requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try {
        const slug = param(req, "slug");
        const keyId = param(req, "keyId");
        if (!slug || !keyId) return res.status(400).json({ error: "Workspace slug and key ID are required" });
        const workspace = await workspaceForUser(req.user!.id, slug);
        if (!workspace) return res.status(404).json({ error: "Workspace not found" });
        const key = await prisma.apiKey.findFirst({ where: { id: keyId, workspaceId: workspace.id } });
        if (!key) return res.status(404).json({ error: "API key not found" });
        await prisma.apiKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } });
        res.json({ ok: true });
    } catch (error) { next(error); }
});

app.use((_req, res) => res.status(404).json({ error: "Not found" }));
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
});

app.listen(port, () => {
    console.log(`Backend running on http://localhost:${port}`);
});
