import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db/db";
import { requirePlatformOwner } from "@/lib/auth-utils";
import * as tableDefs from "@/lib/db/schema";
import { getTableColumns } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

type TableModule = typeof tableDefs;
type TableName = {
  [K in keyof TableModule]: TableModule[K] extends PgTable ? K : never;
}[keyof TableModule];

const GLOBAL_TABLES: ReadonlyArray<TableName> = [
  "users",
  "accounts",
  "sessions",
  "verificationTokens",
  "platformOwners",
  "subscriptionPlans",
  "loginAttempts",
];

const CLINIC_TABLES: ReadonlyArray<TableName> = [
  "clinics",
  "clinicMemberships",
  "clinicSchedule",
  "notifications",
  "patients",
  "appointments",
  "waitingRoomEntries",
  "auditLogs",
  "dentalCharts",
  "odontogramStates",
  "treatmentPlans",
  "consultationNotes",
  "medicalHistoryEntries",
  "treatmentCatalog",
  "radiographs",
  "clinicalSessions",
  "prescriptions",
  "documentSequences",
  "invoices",
  "quotes",
  "payments",
  "stockItems",
  "stockAlerts",
  "prosthesisLabs",
  "prosthesisOrders",
  "clinicSubscriptions",
  "supportTickets",
  "drugCatalog",
  "accountTokens",
  "appointmentReminders",
];

interface ChildTableRef {
  table: TableName;
  parentColumn: string;
  parentTable: TableName;
  parentColumnName: string;
}

const CHILD_TABLES: ChildTableRef[] = [
  {
    table: "treatmentPlanItems",
    parentColumn: "planId",
    parentTable: "treatmentPlans",
    parentColumnName: "id",
  },
  {
    table: "clinicalSessionItems",
    parentColumn: "sessionId",
    parentTable: "clinicalSessions",
    parentColumnName: "id",
  },
  {
    table: "prescriptionItems",
    parentColumn: "prescriptionId",
    parentTable: "prescriptions",
    parentColumnName: "id",
  },
  {
    table: "invoiceItems",
    parentColumn: "invoiceId",
    parentTable: "invoices",
    parentColumnName: "id",
  },
  {
    table: "quoteItems",
    parentColumn: "quoteId",
    parentTable: "quotes",
    parentColumnName: "id",
  },
  {
    table: "stockTransactions",
    parentColumn: "itemId",
    parentTable: "stockItems",
    parentColumnName: "id",
  },
];

const ALL_TABLES: ReadonlyArray<TableName> = [
  ...GLOBAL_TABLES,
  ...CLINIC_TABLES,
  ...CHILD_TABLES.map((c) => c.table),
];

/**
 * Tables jamais exportées, quelle que soit la portée ("full" ou "clinic") :
 * - "accountTokens" : tokens de réinitialisation de mot de passe encore valides, en clair.
 * - "loginAttempts" : emails tentés + adresses IP.
 * Exporter ces tables revient à publier du matériel d'authentification.
 */
const NEVER_EXPORTED_TABLES: ReadonlyArray<TableName> = [
  "accountTokens",
  "loginAttempts",
];

function isNeverExported(name: TableName): boolean {
  return NEVER_EXPORTED_TABLES.includes(name);
}

/**
 * Retourne la colonne qui rattache les lignes de `name` à une clinique,
 * ou `null` si la table n'est pas scopée à une clinique.
 * La détection se fait sur le schéma (jamais sur le contenu des lignes) :
 * une table sans colonne `clinicId` n'est jamais exportée en portée "clinic".
 * Cas particulier : la table `clinics` est scopée par sa propre clé primaire.
 */
function getClinicScopeColumn(name: TableName): string | null {
  if (name === "clinics") {
    return "id";
  }
  const columnNames = Object.keys(getTableColumns(tableDefs[name]));
  return (
    columnNames.find((k) => k === "clinicId" || k.endsWith("ClinicId")) ?? null
  );
}

/** Supprime le hash de mot de passe d'une ligne `users` avant export. */
function withoutPasswordHash(row: unknown): Record<string, unknown> {
  if (typeof row !== "object" || row === null) {
    return {};
  }
  const sanitized: Record<string, unknown> = {
    ...(row as Record<string, unknown>),
  };
  delete sanitized.passwordHash;
  return sanitized;
}

function snakeCase(name: string): string {
  return name.replace(/([A-Z])/g, "_$1").toLowerCase().replace(/^_/, "");
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

export async function GET(request: NextRequest) {
  try {
    await requirePlatformOwner();

    const clinicId = request.nextUrl.searchParams.get("clinicId");

    let scope = "full" as "full" | "clinic";
    let tables: Record<string, unknown[]> = {};

    if (clinicId) {
      if (!/^[a-zA-Z0-9-]+$/.test(clinicId) || clinicId.length > 100) {
        return NextResponse.json(
          { error: "Identifiant de clinique invalide" },
          { status: 400 }
        );
      }
      scope = "clinic";
      tables = await exportClinic(clinicId);
    } else {
      tables = await exportAll();
    }

    const payload = {
      format: "dentalcare-backup",
      version: "1.0",
      scope,
      clinicId: scope === "clinic" ? clinicId : undefined,
      exportDate: new Date().toISOString(),
      tables,
    };

    const filename =
      scope === "clinic"
        ? `dentalcare-clinic-${clinicId}.json`
        : `dentalcare-export-${new Date().toISOString().slice(0, 10)}.json`;

    const json = JSON.stringify(payload, null, 2);

    return new NextResponse(json, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Export impossible" },
      { status: 500 }
    );
  }
}

async function exportAll(): Promise<Record<string, unknown[]>> {
  const result: Record<string, unknown[]> = {};
  for (const name of ALL_TABLES) {
    if (isNeverExported(name)) continue;
    const table = tableDefs[name];
    let rows: unknown[] = [];
    try {
      rows = await db.select().from(table);
    } catch {
      rows = [];
    }
    result[snakeCase(name as string)] =
      name === "users" ? rows.map(withoutPasswordHash) : rows;
  }
  return result;
}

async function exportClinic(
  clinicId: string
): Promise<Record<string, unknown[]>> {
  const result: Record<string, unknown[]> = {};

  const parentIdsByTable: Partial<Record<TableName, string[]>> = {};

  const scopedTables: ReadonlyArray<TableName> = [
    ...GLOBAL_TABLES,
    ...CLINIC_TABLES,
  ];

  for (const name of scopedTables) {
    if (isNeverExported(name)) continue;

    const scopeColumn = getClinicScopeColumn(name);
    if (!scopeColumn) {
      // Table non scopée à une clinique : refuser de l'exporter plutôt que
      // d'exporter l'intégralité des lignes de la plateforme.
      continue;
    }

    const table = tableDefs[name];
    let rows: Record<string, unknown>[] = [];
    try {
      rows = (await db.select().from(table)) as Record<string, unknown>[];
    } catch {
      rows = [];
    }

    const filtered = rows.filter((r) => String(r[scopeColumn]) === clinicId);

    result[snakeCase(name as string)] = filtered;
    parentIdsByTable[name] = filtered.map((r) => String(r.id));
  }

  for (const child of CHILD_TABLES) {
    let childRows: Record<string, unknown>[] = [];
    try {
      childRows = (await db.select().from(tableDefs[child.table])) as Record<
        string,
        unknown
      >[];
    } catch {
      childRows = [];
    }

    const parentIds = parentIdsByTable[child.parentTable];
    const idSet = new Set(isStringArray(parentIds) ? parentIds : []);

    result[snakeCase(child.table as string)] = childRows.filter((r) =>
      idSet.has(String(r[child.parentColumn]))
    );
  }

  return result;
}
