import { createDecipheriv, createHash } from "node:crypto";
import { prisma } from "@repo/db";
import { OpenAIMemoryExtractionModel } from "@repo/memory-extractor";
import type { MemoryExtractionModel } from "@repo/memory-extractor";

function encryptionKey(secret: string) {
  if (secret.length < 32) throw new Error("Credential encryption secret must be at least 32 characters");
  return createHash("sha256").update(secret).digest();
}

function decrypt(value: string) {
  const [ivPart, ciphertextPart, tagPart] = value.split(".");
  if (!ivPart || !ciphertextPart || !tagPart) throw new Error("Invalid encrypted provider key");
  const iv = Buffer.from(ivPart, "base64url");
  const ciphertext = Buffer.from(ciphertextPart, "base64url");
  const tag = Buffer.from(tagPart, "base64url");
  const secrets = [process.env.CREDENTIAL_ENCRYPTION_SECRET, process.env.BETTER_AUTH_SECRET]
    .filter((secret): secret is string => Boolean(secret && secret.length >= 32));
  let lastError: unknown;
  for (const secret of [...new Set(secrets)]) {
    try {
      const decipher = createDecipheriv("aes-256-gcm", encryptionKey(secret), iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Unable to decrypt provider key");
}

export async function extractionModelForWorkspace(workspaceId: string): Promise<MemoryExtractionModel> {
  const credential = await prisma.providerCredential.findFirst({
    where: { workspaceId },
    orderBy: { updatedAt: "desc" },
    select: { provider: true, model: true, baseUrl: true, encryptedKey: true },
  });

  if (!credential) return new OpenAIMemoryExtractionModel();

  const apiKey = decrypt(credential.encryptedKey);
  return new OpenAIMemoryExtractionModel({
    provider: credential.provider,
    model: credential.model,
    baseURL: credential.baseUrl || undefined,
    apiKey: apiKey === "local" ? undefined : apiKey, // local models need no real key
  });
}
