import { NextResponse } from "next/server";
import { prisma } from "@repo/db";
import { getCurrentLocalUser } from "@/lib/current-user";

export async function POST(_request: Request, context: { params: Promise<{ slug: string; keyId: string }> }) {
  const { slug, keyId } = await context.params;
  const user = await getCurrentLocalUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const key = await prisma.apiKey.findFirst({
    where: { id: keyId, workspace: { slug, ownerId: user.id } },
  });
  if (!key) return NextResponse.json({ error: "API key not found" }, { status: 404 });
  await prisma.apiKey.delete({ where: { id: key.id } });
  return NextResponse.json({ ok: true });
}
