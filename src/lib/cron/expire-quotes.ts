import { db } from "@/lib/db/db";
import { quotes } from "@/lib/db/schema";
import { and, eq, isNotNull, lt } from "drizzle-orm";
import { logAction } from "@/lib/audit";

export async function expireOverdueQuotes(): Promise<{ expired: number }> {
  try {
    const updated = await db
      .update(quotes)
      .set({ status: "expired" })
      .where(
        and(
          isNotNull(quotes.validUntil),
          lt(quotes.validUntil, new Date()),
          eq(quotes.status, "sent")
        )
      )
      .returning({ id: quotes.id });

    for (const quote of updated) {
      await logAction({
        clinicId: null,
        action: "update",
        entityType: "quote",
        entityId: quote.id,
        after: { status: "expired" },
      });
    }

    return { expired: updated.length };
  } catch {
    return { expired: 0 };
  }
}
