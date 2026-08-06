import { db } from "@/lib/db/db";
import { auditLogs } from "@/lib/db/schema";
import { getCurrentUser } from "@/lib/auth-utils";
import { headers } from "next/headers";

type AuditAction = "create" | "update" | "delete" | "status_change";

export async function logAction(input: {
  clinicId: string | null;
  action: AuditAction;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
}): Promise<void> {
  try {
    const user = await getCurrentUser();
    const headerStore = await headers();
    const ip =
      headerStore.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      headerStore.get("x-real-ip");
    await db.insert(auditLogs).values({
      clinicId: input.clinicId,
      actorUserId: user?.id ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      beforeState: input.before as Record<string, unknown> | undefined,
      afterState: input.after as Record<string, unknown> | undefined,
      ipAddress: ip || null,
    });
  } catch (err) {
    console.error("Audit log failed:", err);
  }
}
