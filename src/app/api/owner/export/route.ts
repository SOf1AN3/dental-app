import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db/db";
import { requirePlatformOwner } from "@/lib/auth-utils";
import * as tableDefs from "@/lib/db/schema";
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
    const table = tableDefs[name];
    let rows: unknown[] = [];
    try {
      rows = await db.select().from(table);
    } catch {
      rows = [];
    }
    result[snakeCase(name as string)] = rows;
  }
  return result;
}

async function exportClinic(
  clinicId: string
): Promise<Record<string, unknown[]>> {
  const result: Record<string, unknown[]> = {};

  for (const name of GLOBAL_TABLES) {
    const table = tableDefs[name];
    let rows: unknown[] = [];
    try {
      rows = await db.select().from(table);
    } catch {
      rows = [];
    }
    result[snakeCase(name as string)] = rows;
  }

  const parentIdsByTable: Partial<Record<TableName, string[]>> = {};

  for (const name of CLINIC_TABLES) {
    const table = tableDefs[name];
    let rows: Record<string, unknown>[] = [];
    try {
      rows = (await db.select().from(table)) as Record<string, unknown>[];
    } catch {
      rows = [];
    }

    const clinicCol = Object.keys(rows[0] ?? {}).find(
      (k) => k === "clinicId" || k.endsWith("ClinicId")
    );

    const filtered = clinicCol
      ? rows.filter((r) => String(r[clinicCol]) === clinicId)
      : rows;

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
