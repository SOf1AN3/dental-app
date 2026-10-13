/**
 * Tâche 5.1 — CONTRAT DE FORMAT de la synchronisation local-first.
 *
 * Ce module est la **source unique de vérité** du format échangé entre un
 * poste (base PostgreSQL embarquée) et le serveur central. Il sera consommé
 * par :
 *  - les routes centrales `POST /api/sync/push` et `GET /api/sync/pull`
 *    (étape 5.2) — validation Zod des payloads entrants ;
 *  - l'orchestrateur `electron/sync/runner.ts` (étape 6) — constitution des
 *    lots de push / lecture du curseur de pull.
 *
 * Contraintes respectées ici :
 *  - **Module PUR** : zéro I/O, zéro `process.env`, zéro `console`. Seuls sont
 *    importés : Zod et les *définitions* de tables Drizzle (objets statiques,
 *    sans connexion). Testable hermétiquement (vitest, aucune base).
 *  - **Sécurité — le point le plus sensible du projet** : `serializeRow`
 *    projette chaque ligne sur une **liste blanche** de colonnes déclarée dans
 *    `TABLE_REGISTRY`. Aucun secret ne peut jamais figurer dans un payload :
 *    `user.password_hash` est **interdit** (voir `FORBIDDEN_PAYLOAD_COLUMNS`).
 *
 * ## Registre — Groupes A et B (décision tâche 4.1 / migration 0019 + 0020)
 *
 *  - **Groupe A — tables répliquées « curseur »** : chaque table porte les
 *    colonnes `updated_at`, `device_id`, `rev`, `deleted_at` (tombstone) et un
 *    index `(clinic_id, updated_at, id)` alimentant le **curseur de pull**.
 *    Elles sont des entrées de curseur à part entière (`cursor: true`).
 *  - **Groupe B — enfants purs** (`invoice_item`, `quote_item`,
 *    `prescription_item`, `clinical_session_item`, `treatment_plan_item`,
 *    `stock_transaction`) : ni `updated_at` ni `rev` — ils sont **transportés
 *    en cascadé avec leur parent** (`children` du parent) et ne sont **jamais**
 *    des entrées de curseur (`cursor: false`). Sinon une facture se répliquerait
 *    sans ses lignes.
 *
 * ## Tables EXCLUES de la réplication (et pourquoi)
 *
 *  - `account`, `session`, `verificationToken` — identité NextAuth : gérées par
 *    le bootstrap, jamais poussées (jetsons/identifiants d'auth sensibles).
 *  - `account_token`, `login_attempt` — jetons de réinitialisation et forensic
 *    locale : hors périmètre de la réplication, donnée sensible.
 *  - `document_sequence` — compteur de numérotation : alloué **par bloc** côté
 *    central (route `/api/sync/blocks`, décision D4), jamais répliqué.
 *  - `platform_owner`, `subscription_plan`, `clinic_subscription` — tables
 *    « owner » / abonnements : web uniquement (paiements), non répliquées.
 *  - `appointment_reminder` — rappels générés et envoyés par le cron central.
 *  - Tables du moteur (`sync_outbox`, `sync_state`, `sync_conflict`,
 *    `sync_merge`, `sync_applied`) et `device` — structure d'infrastructure,
 *    jamais répliquées entre postes.
 */

import { z } from "zod";
import type { AnyPgTable } from "drizzle-orm/pg-core";
import {
  appointments,
  auditLogs,
  clinicMemberships,
  clinics,
  clinicSchedule,
  clinicalSessionItems,
  clinicalSessions,
  consultationNotes,
  dentalCharts,
  drugCatalog,
  invoiceItems,
  invoices,
  medicalHistoryEntries,
  notifications,
  odontogramStates,
  patients,
  payments,
  prescriptionItems,
  prescriptions,
  prosthesisLabs,
  prosthesisOrders,
  quoteItems,
  quotes,
  radiographs,
  stockAlerts,
  stockItems,
  stockTransactions,
  supportTickets,
  treatmentCatalog,
  treatmentPlanItems,
  treatmentPlans,
  users,
  waitingRoomEntries,
} from "@/lib/db/schema";

/* -------------------------------------------------------------------------- */
/* 1. Types de format (schémas Zod — validés côté serveur)                     */
/* -------------------------------------------------------------------------- */

/** Nombre maximum d'opérations par requête de push (décision plan §4.2). */
export const MAX_PUSH_OPS = 100;

/** Taille d'un lot de pull. borné pour tenir le timeout Vercel (plan §3.1). */
export const MAX_PULL_LIMIT = 500;
export const DEFAULT_PULL_LIMIT = 200;

/**
 * Curseur de pull : triplet lexicographique `(clinic_id, updated_at, id)`.
 * `clinicId` est porté par `PullRequest` (scope de la requête) ; le curseur
 * lui-même est `(updated_at, id)`, conforme aux index `*_clinic_updated_id`.
 */
export const cursorSchema = z.object({
  updatedAt: z.iso.datetime(),
  id: z.string().min(1),
});
export type Cursor = z.infer<typeof cursorSchema>;

/** Opération unitaire de synchronisation (aussi bien push que pull). */
export const changeOpSchema = z.object({
  /** UUID généré côté client : garantit l'idempotence du rejeu (table `sync_applied`). */
  opId: z.uuid(),
  /** Nom SQL de la table — doit appartenir à `TABLE_REGISTRY`. */
  table: z.string().min(1),
  rowId: z.string().min(1),
  op: z.enum(["insert", "update", "delete"]),
  /** Projection `serializeRow` — JAMAIS la ligne brute. */
  payload: z.record(z.string(), z.unknown()),
  clinicId: z.string().nullable(),
  /** Version MONOTONE attribuée côté serveur (jamais l'horloge client). */
  rev: z.number().int().nonnegative().optional(),
  /** Horodatage ISO (poste) — `updated_at` de la ligne d'origine. */
  updatedAt: z.iso.datetime(),
  deviceId: z.string().min(1).optional(),
});
export type ChangeOp = z.infer<typeof changeOpSchema>;

export const pushRequestSchema = z.object({
  deviceId: z.string().min(1),
  clinicId: z.string().nullable(),
  ops: z.array(changeOpSchema).min(1).max(MAX_PUSH_OPS),
});
export type PushRequest = z.infer<typeof pushRequestSchema>;

export const pushResponseSchema = z.object({
  accepted: z.array(z.uuid()),
  rejected: z.array(
    z.object({
      opId: z.uuid(),
      reason: z.string().min(1),
    }),
  ),
  conflicts: z.array(
    z.object({
      table: z.string().min(1),
      rowId: z.string().min(1),
      reason: z.string().min(1),
    }),
  ),
});
export type PushResponse = z.infer<typeof pushResponseSchema>;

export const pullRequestSchema = z.object({
  clinicId: z.string().min(1),
  /** `null` = premier pull (pull complet paginé, plan §3.3). */
  cursor: cursorSchema.nullable(),
  limit: z.number().int().positive().max(MAX_PULL_LIMIT).optional(),
});
export type PullRequest = z.infer<typeof pullRequestSchema>;

export const pullResponseSchema = z.object({
  changes: z.array(changeOpSchema),
  /** Nouveau curseur à réutiliser pour l'appel suivant (avant-dernière op). */
  cursor: cursorSchema,
  hasMore: z.boolean(),
});
export type PullResponse = z.infer<typeof pullResponseSchema>;

/* -------------------------------------------------------------------------- */
/* 2. Registre des tables répliquées                                           */
/* -------------------------------------------------------------------------- */

export type SyncDirection = "both" | "push-only" | "pull-only";

export interface ReplicatedTable {
  /** Nom SQL de la table — **clé du registre**. */
  name: string;
  /**
   * Sens de réplication :
   *  - `both`       — poussée par le poste **et** tirée du central ;
   *  - `push-only`  — uniquement poussée (ex. `audit_log`) ;
   *  - `pull-only`  — uniquement tirée (ex. `notification`, créée par le central).
   */
  direction: SyncDirection;
  /** Objet table Drizzle (les routes requêtent sans recoder de nom SQL). */
  table: AnyPgTable;
  /**
   * **Liste blanche** des colonnes sérialisées (noms de *propriétés* Drizzle,
   * ex. `clinicId` et non `clinic_id`). Une colonne absente de cette liste
   * ne quitte jamais le poste.
   */
  columns: readonly string[];
  /** Enfants à transporter en cascadé (noms SQL) — Groupe B. */
  children?: readonly string[];
  /** Colonne de rattachement au cabinet (propriété Drizzle) ; `null` si la table n'en a pas. */
  clinicIdColumn?: string | null;
  /**
   * `true` = table du Groupe A : possède les colonnes de curseur (`updated_at`,
   * `rev`, `deleted_at`) et l'index `*_clinic_updated_id` → entrée de curseur
   * légitime. Les enfants du Groupe B sont `false` (transportés en cascadé).
   */
  cursor: boolean;
}

/**
 * Colonnes **jamais sérialisables**, quel que soit le registre. Présence de
 * l'une d'elles dans une liste blanche = bug de déclaration → `serializeRow`
 * lève (défense en profondeur : même un `columns` corrompu ne pourrait pas
 * faire fuiter un secret).
 */
export const FORBIDDEN_PAYLOAD_COLUMNS: ReadonlySet<string> = new Set([
  "passwordHash",
  "password_hash",
  "sessionToken",
  "session_token",
  "refresh_token",
  "refreshToken",
  "access_token",
  "accessToken",
  "id_token",
  "idToken",
  "token",
  "secret",
]);

/** Dit si une colonne est interdite en payload (secret). */
export function isForbiddenPayloadColumn(column: string): boolean {
  return FORBIDDEN_PAYLOAD_COLUMNS.has(column);
}

/**
 * Registre **central et exhaustif** des tables répliquées.
 *
 * Clé = nom SQL. Chaque table du Groupe A (curseur) et chaque enfant du
 * Groupe B y figurent ; aucune table d'infrastructure n'y figure (verrouillé
 * par `protocol.test.ts`).
 */
export const TABLE_REGISTRY: Readonly<Record<string, ReplicatedTable>> =
  Object.freeze({
    /* ---------------------------- Groupe A ------------------------------- */

    /**
     * `user` — bidirectionnel mais **colonnes limitées au profil** :
     * `password_hash` est INTERDIT (colonnes auth hors réplication, seule la
     * fiche profil se synchronise). `tokenVersion` voyage pour que la révocation
     * de session (changement de mot de passe) se propage aux postes.
     */
    user: {
      name: "user",
      direction: "both",
      table: users,
      columns: ["id", "name", "email", "emailVerified", "image", "tokenVersion"],
      clinicIdColumn: null,
      cursor: true,
    },
    clinic: {
      name: "clinic",
      direction: "both",
      table: clinics,
      columns: [
        "id",
        "name",
        "slug",
        "email",
        "phone",
        "address",
        "wilayaCode",
        "timezone",
        "status",
        "logoUrl",
        "headerUrl",
        "legalInfo",
        "watermarkEnabled",
        "documentBranding",
        "defaultTaxRate",
        "openingTime",
        "closingTime",
        "createdAt",
        "updatedAt",
        "deletedAt",
        "deviceId",
        "rev",
      ],
      clinicIdColumn: null,
      cursor: true,
    },
    clinic_membership: {
      name: "clinic_membership",
      direction: "both",
      table: clinicMemberships,
      columns: [
        "id",
        "userId",
        "clinicId",
        "role",
        "minGapMinutes",
        "invitedAt",
        "joinedAt",
        "createdAt",
        "updatedAt",
        "deviceId",
        "rev",
        "deletedAt",
      ],
      clinicIdColumn: "clinicId",
      cursor: true,
    },
    clinic_schedule: {
      name: "clinic_schedule",
      direction: "both",
      table: clinicSchedule,
      columns: [
        "id",
        "clinicId",
        "dayOfWeek",
        "openTime",
        "closeTime",
        "isClosed",
        "isWeekend",
        "createdAt",
        "updatedAt",
        "deviceId",
        "rev",
        "deletedAt",
      ],
      clinicIdColumn: "clinicId",
      cursor: true,
    },
    /** Créées par le central (broadcast / maintenance) : tirées, jamais poussées. */
    notification: {
      name: "notification",
      direction: "pull-only",
      table: notifications,
      columns: [
        "id",
        "clinicId",
        "category",
        "title",
        "message",
        "link",
        "refKey",
        "readAt",
        "createdBy",
        "createdAt",
        "updatedAt",
        "deviceId",
        "rev",
        "deletedAt",
      ],
      clinicIdColumn: "clinicId",
      cursor: true,
    },
    patient: {
      name: "patient",
      direction: "both",
      table: patients,
      columns: [
        "id",
        "clinicId",
        "firstName",
        "lastName",
        "dateOfBirth",
        "gender",
        "phone",
        "email",
        "address",
        "wilayaCode",
        "emergencyContact",
        "emergencyPhone",
        "insuranceProvider",
        "insuranceNumber",
        "notes",
        "createdAt",
        "updatedAt",
        "deletedAt",
        "deviceId",
        "rev",
      ],
      clinicIdColumn: "clinicId",
      cursor: true,
    },
    appointment: {
      name: "appointment",
      direction: "both",
      table: appointments,
      columns: [
        "id",
        "clinicId",
        "patientId",
        "dentistId",
        "startTime",
        "endTime",
        "type",
        "status",
        "notes",
        "color",
        "createdAt",
        "updatedAt",
        "deviceId",
        "rev",
        "deletedAt",
      ],
      clinicIdColumn: "clinicId",
      cursor: true,
    },
    waiting_room_entry: {
      name: "waiting_room_entry",
      direction: "both",
      table: waitingRoomEntries,
      columns: [
        "id",
        "clinicId",
        "appointmentId",
        "patientId",
        "status",
        "arrivedAt",
        "calledAt",
        "notes",
        "updatedAt",
        "deviceId",
        "rev",
        "deletedAt",
      ],
      clinicIdColumn: "clinicId",
      cursor: true,
    },
    /**
     * `audit_log` — **push-only** : chaque poste journalise ses actions et les
     * pousse ; le central n'en crée pas pour le compte des cabinets. Curseur
     * `(updated_at, id)` SANS clinic_id (nullable ici, décision tâche 4.1).
     */
    audit_log: {
      name: "audit_log",
      direction: "push-only",
      table: auditLogs,
      columns: [
        "id",
        "clinicId",
        "actorUserId",
        "action",
        "entityType",
        "entityId",
        "beforeState",
        "afterState",
        "ipAddress",
        "createdAt",
        "updatedAt",
        "deviceId",
        "rev",
        "deletedAt",
      ],
      clinicIdColumn: null,
      cursor: true,
    },
    consultation_note: {
      name: "consultation_note",
      direction: "both",
      table: consultationNotes,
      columns: [
        "id",
        "clinicId",
        "patientId",
        "appointmentId",
        "dentistId",
        "diagnosis",
        "notes",
        "createdAt",
        "updatedAt",
        "deviceId",
        "rev",
        "deletedAt",
      ],
      clinicIdColumn: "clinicId",
      cursor: true,
    },
    dental_chart: {
      name: "dental_chart",
      direction: "both",
      table: dentalCharts,
      columns: [
        "id",
        "clinicId",
        "patientId",
        "toothNumber",
        "quadrant",
        "surface",
        "conditionCode",
        "conditionLabel",
        "notes",
        "createdAt",
        "updatedAt",
        "deviceId",
        "rev",
        "deletedAt",
      ],
      clinicIdColumn: "clinicId",
      cursor: true,
    },
    medical_history_entry: {
      name: "medical_history_entry",
      direction: "both",
      table: medicalHistoryEntries,
      columns: [
        "id",
        "clinicId",
        "patientId",
        "condition",
        "diagnosisDate",
        "notes",
        "isActive",
        "createdAt",
        "updatedAt",
        "deviceId",
        "rev",
        "deletedAt",
      ],
      clinicIdColumn: "clinicId",
      cursor: true,
    },
    odontogram_state: {
      name: "odontogram_state",
      direction: "both",
      table: odontogramStates,
      columns: [
        "id",
        "clinicId",
        "patientId",
        "state",
        "version",
        "createdAt",
        "updatedAt",
        "deviceId",
        "rev",
        "deletedAt",
      ],
      clinicIdColumn: "clinicId",
      cursor: true,
    },
    /**
     * `radiograph` — seules les **métadonnées + fileKey** sont répliquées ;
     * l'octet du fichier lui-même transite par `/api/files/[...key]`, hors
     * périmètre du protocole.
     */
    radiograph: {
      name: "radiograph",
      direction: "both",
      table: radiographs,
      columns: [
        "id",
        "clinicId",
        "patientId",
        "fileKey",
        "fileType",
        "toothNumber",
        "region",
        "notes",
        "uploadedBy",
        "takenAt",
        "createdAt",
        "deletedAt",
        "updatedAt",
        "deviceId",
        "rev",
      ],
      clinicIdColumn: "clinicId",
      cursor: true,
    },
    treatment_catalog: {
      name: "treatment_catalog",
      direction: "both",
      table: treatmentCatalog,
      columns: [
        "id",
        "clinicId",
        "name",
        "code",
        "category",
        "price",
        "description",
        "isActive",
        "createdAt",
        "updatedAt",
        "deviceId",
        "rev",
        "deletedAt",
      ],
      clinicIdColumn: "clinicId",
      cursor: true,
    },
    treatment_plan: {
      name: "treatment_plan",
      direction: "both",
      table: treatmentPlans,
      columns: [
        "id",
        "clinicId",
        "patientId",
        "title",
        "description",
        "status",
        "totalAmount",
        "discount",
        "createdBy",
        "createdAt",
        "updatedAt",
        "deviceId",
        "rev",
        "deletedAt",
      ],
      children: ["treatment_plan_item"],
      clinicIdColumn: "clinicId",
      cursor: true,
    },
    clinical_session: {
      name: "clinical_session",
      direction: "both",
      table: clinicalSessions,
      columns: [
        "id",
        "clinicId",
        "patientId",
        "appointmentId",
        "dentistId",
        "status",
        "totalAmount",
        "notes",
        "startedAt",
        "completedAt",
        "createdAt",
        "updatedAt",
        "deviceId",
        "rev",
        "deletedAt",
      ],
      children: ["clinical_session_item"],
      clinicIdColumn: "clinicId",
      cursor: true,
    },
    prescription: {
      name: "prescription",
      direction: "both",
      table: prescriptions,
      columns: [
        "id",
        "clinicId",
        "patientId",
        "dentistId",
        "sessionId",
        "date",
        "status",
        "notes",
        "createdAt",
        "updatedAt",
        "deviceId",
        "rev",
        "deletedAt",
      ],
      children: ["prescription_item"],
      clinicIdColumn: "clinicId",
      cursor: true,
    },
    invoice: {
      name: "invoice",
      direction: "both",
      table: invoices,
      columns: [
        "id",
        "clinicId",
        "patientId",
        "sessionId",
        "number",
        "date",
        "dueDate",
        "status",
        "subtotal",
        "taxTotal",
        "discountTotal",
        "total",
        "notes",
        "createdAt",
        "updatedAt",
        "deviceId",
        "rev",
        "deletedAt",
      ],
      children: ["invoice_item"],
      clinicIdColumn: "clinicId",
      cursor: true,
    },
    payment: {
      name: "payment",
      direction: "both",
      table: payments,
      columns: [
        "id",
        "clinicId",
        "patientId",
        "invoiceId",
        "amount",
        "method",
        "reference",
        "date",
        "notes",
        "createdBy",
        "createdAt",
        "updatedAt",
        "deviceId",
        "rev",
        "deletedAt",
      ],
      clinicIdColumn: "clinicId",
      cursor: true,
    },
    quote: {
      name: "quote",
      direction: "both",
      table: quotes,
      columns: [
        "id",
        "clinicId",
        "patientId",
        "number",
        "date",
        "validUntil",
        "status",
        "subtotal",
        "taxTotal",
        "discountTotal",
        "total",
        "notes",
        "generatedFromTreatmentPlanId",
        "convertedInvoiceId",
        "createdAt",
        "updatedAt",
        "deviceId",
        "rev",
        "deletedAt",
      ],
      children: ["quote_item"],
      clinicIdColumn: "clinicId",
      cursor: true,
    },
    stock_alert: {
      name: "stock_alert",
      direction: "both",
      table: stockAlerts,
      columns: [
        "id",
        "clinicId",
        "itemId",
        "threshold",
        "triggeredAt",
        "resolvedAt",
        "status",
        "updatedAt",
        "deviceId",
        "rev",
        "deletedAt",
      ],
      clinicIdColumn: "clinicId",
      cursor: true,
    },
    stock_item: {
      name: "stock_item",
      direction: "both",
      table: stockItems,
      columns: [
        "id",
        "clinicId",
        "name",
        "category",
        "description",
        "currentQty",
        "minQty",
        "unit",
        "supplierId",
        "purchasePrice",
        "sellingPrice",
        "createdAt",
        "updatedAt",
        "deviceId",
        "rev",
        "deletedAt",
      ],
      children: ["stock_transaction"],
      clinicIdColumn: "clinicId",
      cursor: true,
    },
    prosthesis_lab: {
      name: "prosthesis_lab",
      direction: "both",
      table: prosthesisLabs,
      columns: [
        "id",
        "clinicId",
        "name",
        "contactPerson",
        "phone",
        "email",
        "address",
        "notes",
        "createdAt",
        "updatedAt",
        "deviceId",
        "rev",
        "deletedAt",
      ],
      clinicIdColumn: "clinicId",
      cursor: true,
    },
    prosthesis_order: {
      name: "prosthesis_order",
      direction: "both",
      table: prosthesisOrders,
      columns: [
        "id",
        "clinicId",
        "patientId",
        "labId",
        "orderNumber",
        "description",
        "toothNumber",
        "material",
        "color",
        "deliveryDate",
        "status",
        "cost",
        "notes",
        "createdBy",
        "createdAt",
        "updatedAt",
        "deviceId",
        "rev",
        "deletedAt",
      ],
      clinicIdColumn: "clinicId",
      cursor: true,
    },
    drug_catalog: {
      name: "drug_catalog",
      direction: "both",
      table: drugCatalog,
      columns: [
        "id",
        "clinicId",
        "name",
        "dosage",
        "form",
        "category",
        "frequency",
        "instructions",
        "isActive",
        "createdAt",
        "updatedAt",
        "deviceId",
        "rev",
        "deletedAt",
      ],
      clinicIdColumn: "clinicId",
      cursor: true,
    },
    /**
     * `support_ticket` — bidirectionnel avec **central gagnant sur `status`**
     * (décision client, commentaire tâche 4.2 dans support.ts).
     */
    support_ticket: {
      name: "support_ticket",
      direction: "both",
      table: supportTickets,
      columns: [
        "id",
        "clinicId",
        "subject",
        "description",
        "status",
        "priority",
        "createdBy",
        "assignedTo",
        "createdAt",
        "resolvedAt",
        "updatedAt",
        "deviceId",
        "rev",
        "deletedAt",
      ],
      clinicIdColumn: "clinicId",
      cursor: true,
    },

    /* --------------------- Groupe B — enfants purs ----------------------- */
    /* Transportés en cascadé avec leur parent (jamais des entrées de        */
    /* curseur : ni updated_at, ni rev, ni index de curseur).                */

    invoice_item: {
      name: "invoice_item",
      direction: "both",
      table: invoiceItems,
      columns: [
        "id",
        "invoiceId",
        "description",
        "quantity",
        "unitPrice",
        "taxRate",
        "discount",
        "total",
      ],
      clinicIdColumn: null,
      cursor: false,
    },
    quote_item: {
      name: "quote_item",
      direction: "both",
      table: quoteItems,
      columns: [
        "id",
        "quoteId",
        "description",
        "quantity",
        "unitPrice",
        "taxRate",
        "discount",
        "total",
      ],
      clinicIdColumn: null,
      cursor: false,
    },
    prescription_item: {
      name: "prescription_item",
      direction: "both",
      table: prescriptionItems,
      columns: [
        "id",
        "prescriptionId",
        "type",
        "name",
        "dosage",
        "form",
        "frequency",
        "duration",
        "quantity",
        "instructions",
        "orderIndex",
      ],
      clinicIdColumn: null,
      cursor: false,
    },
    clinical_session_item: {
      name: "clinical_session_item",
      direction: "both",
      table: clinicalSessionItems,
      columns: [
        "id",
        "sessionId",
        "toothNumber",
        "surface",
        "procedureCode",
        "description",
        "fee",
        "quantity",
        "discount",
        "taxRate",
        "orderIndex",
        "createdAt",
      ],
      clinicIdColumn: null,
      cursor: false,
    },
    treatment_plan_item: {
      name: "treatment_plan_item",
      direction: "both",
      table: treatmentPlanItems,
      columns: [
        "id",
        "planId",
        "toothNumber",
        "surface",
        "procedureCode",
        "description",
        "fee",
        "quantity",
        "discount",
        "taxRate",
        "orderIndex",
      ],
      clinicIdColumn: null,
      cursor: false,
    },
    stock_transaction: {
      name: "stock_transaction",
      direction: "both",
      table: stockTransactions,
      columns: [
        "id",
        "itemId",
        "type",
        "qty",
        "unitPrice",
        "reference",
        "notes",
        "createdBy",
        "createdAt",
      ],
      clinicIdColumn: null,
      cursor: false,
    },
  });

/* -------------------------------------------------------------------------- */
/* 3. Garde-fou de sérialisation                                               */
/* -------------------------------------------------------------------------- */

/**
 * Projette `row` sur la **liste blanche** de `TABLE_REGISTRY[table]`.
 *
 * - Table inconnue → **throw** (pas de réplication sauvage).
 * - Colonne absente de la liste blanche → **silencieusement retirée** (y
 *   compris un secret tel `passwordHash` : il ne peut pas atteindre le payload).
 * - Colonne interdite détectée dans le **résultat** → **throw** : cela n'est
 *   possible que si une liste blanche du registre avait été mal déclarée
 *   (défense en profondeur contre une future régression du registre).
 *
 * C'est le **point de sécurité le plus sensible** du protocole : aucun secret
 * ne doit jamais partir dans un payload. Le serveur central doit également
 * re-projeter les payloads entrants (un client compromis pourrait pousser un
 * payload contenant `passwordHash` : la projection le retire).
 */
export function serializeRow(
  table: string,
  row: Record<string, unknown>,
): Record<string, unknown> {
  const entry = TABLE_REGISTRY[table];
  if (!entry) {
    throw new Error(
      `sync/protocol : table « ${table} » absente du registre de réplication — opération refusée.`,
    );
  }
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new Error(
      `sync/protocol : payload de « ${table} » invalide (objet attendu).`,
    );
  }
  const projected: Record<string, unknown> = {};
  for (const column of entry.columns) {
    if (Object.prototype.hasOwnProperty.call(row, column)) {
      projected[column] = row[column];
    }
  }
  // Garde-fou : le résultat ne peut contenir une colonne interdite QUE si le
  // registre lui-même la déclarait — bug de configuration, pas d'exécution.
  for (const column of Object.keys(projected)) {
    if (isForbiddenPayloadColumn(column)) {
      throw new Error(
        `sync/protocol : colonne interdite « ${column} » déclarée dans la liste blanche de « ${table} » — secret jamais sérialisable.`,
      );
    }
  }
  return projected;
}

/** Entrée du registre, `undefined` si la table n'est pas répliquée. */
export function getReplicatedTable(
  name: string,
): ReplicatedTable | undefined {
  return TABLE_REGISTRY[name];
}

/**
 * Tables servant d'**entrée de curseur** pour le pull : Groupe A, à l'exception
 * des `push-only` (le central ne sert jamais `audit_log`). Les enfants du
 * Groupe B n'y figurent pas (transportés en cascadé).
 */
export function pullCursorTables(): ReplicatedTable[] {
  return Object.values(TABLE_REGISTRY).filter(
    (entry) => entry.cursor && entry.direction !== "push-only",
  );
}
