import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db/db";
import { drugCatalog } from "@/lib/db/schema";
import { eq, and, ilike } from "drizzle-orm";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { requireAuth } from "@/lib/auth-utils";

export async function GET(request: NextRequest) {
  try {
    await requireAuth();
    const clinicId = await getCurrentClinicId();

    const { searchParams } = new URL(request.url);
    const query = searchParams.get("q") ?? "";

    if (!query || query.trim().length === 0) {
      return NextResponse.json([]);
    }

    const results = await db
      .select({
        id: drugCatalog.id,
        name: drugCatalog.name,
        dosage: drugCatalog.dosage,
        form: drugCatalog.form,
        category: drugCatalog.category,
        frequency: drugCatalog.frequency,
        instructions: drugCatalog.instructions,
      })
      .from(drugCatalog)
      .where(
        and(
          eq(drugCatalog.clinicId, clinicId),
          eq(drugCatalog.isActive, true),
          ilike(drugCatalog.name, `%${query.trim()}%`),
        )
      )
      .limit(20);

    return NextResponse.json(results);
  } catch {
    return NextResponse.json([]);
  }
}
