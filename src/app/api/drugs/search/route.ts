import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db/db";
import { drugCatalog } from "@/lib/db/schema";
import { eq, and, ilike } from "drizzle-orm";
import { requireCurrentClinic } from "@/lib/multi-tenant";
import { requireAuth } from "@/lib/auth-utils";

/**
 * Échappe les métacaractères d'un pattern LIKE/ILIKE (`%`, `_`, et le
 * caractère d'échappement lui-même) pour que la saisie utilisateur soit
 * recherchée littéralement (`q=%` ne doit pas balayer tout le catalogue).
 *
 * PostgreSQL utilise `\` comme caractère d'échappement par défaut de LIKE,
 * aucune clause `ESCAPE` n'est donc nécessaire (même convention que le helper
 * `escapeLike` de `src/lib/actions/patient.ts`, qui n'est pas exporté —
 * copie locale assumée pour ne pas dupliquer un export depuis un fichier
 * `use server`).
 */
function escapeLike(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export async function GET(request: NextRequest) {
  try {
    await requireAuth();
    const clinicId = await requireCurrentClinic();

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
          ilike(drugCatalog.name, `%${escapeLike(query.trim())}%`),
        )
      )
      .limit(20);

    return NextResponse.json(results);
  } catch {
    return NextResponse.json([]);
  }
}
