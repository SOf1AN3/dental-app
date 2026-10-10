import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db/db";
import { drugCatalog } from "@/lib/db/schema";
import { eq, asc } from "drizzle-orm";
import { requireCurrentClinic } from "@/lib/multi-tenant";
import { requireAuth } from "@/lib/auth-utils";
import * as XLSX from "xlsx";

export async function GET(_request: NextRequest) {
  try {
    await requireAuth();
    const clinicId = await requireCurrentClinic();

    const drugs = await db
      .select()
      .from(drugCatalog)
      .where(eq(drugCatalog.clinicId, clinicId))
      .orderBy(asc(drugCatalog.name));

    const rows = drugs.map((drug) => ({
      Nom: drug.name,
      Dosage: drug.dosage ?? "",
      Forme: drug.form ?? "",
      Catégorie: drug.category ?? "",
      Fréquence: drug.frequency ?? "",
      Instructions: drug.instructions ?? "",
      Statut: drug.isActive ? "Actif" : "Inactif",
    }));

    const worksheet = XLSX.utils.json_to_sheet(rows);
    if (rows.length === 0) {
      XLSX.utils.sheet_add_aoa(worksheet, [["Nom", "Dosage", "Forme", "Catégorie", "Fréquence", "Instructions", "Statut"]]);
    }
    worksheet["!cols"] = [
      { wch: 30 }, // Nom
      { wch: 15 }, // Dosage
      { wch: 15 }, // Forme
      { wch: 20 }, // Catégorie
      { wch: 25 }, // Fréquence
      { wch: 40 }, // Instructions
      { wch: 10 }, // Statut
    ];

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Médicaments");

    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

    return new NextResponse(buffer, {
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition":
          `attachment; filename="catalogue-medicaments-${new Date().toISOString().slice(0, 10)}.xlsx"`,
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Export impossible" },
      { status: 500 }
    );
  }
}