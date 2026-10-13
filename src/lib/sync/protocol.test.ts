import { describe, expect, it } from "vitest";
import {
  FORBIDDEN_PAYLOAD_COLUMNS,
  MAX_PULL_LIMIT,
  MAX_PUSH_OPS,
  TABLE_REGISTRY,
  changeOpSchema,
  getReplicatedTable,
  isForbiddenPayloadColumn,
  pullCursorTables,
  pullRequestSchema,
  pullResponseSchema,
  pushRequestSchema,
  pushResponseSchema,
  serializeRow,
} from "./protocol";

/* -------------------------------------------------------------------------- */
/* Registre                                                                    */
/* -------------------------------------------------------------------------- */

/** Tables du Groupe A : répliquées avec curseur (migration 0019 + 0020). */
const GROUPE_A = [
  "user",
  "clinic",
  "clinic_membership",
  "clinic_schedule",
  "notification",
  "patient",
  "appointment",
  "waiting_room_entry",
  "audit_log",
  "consultation_note",
  "dental_chart",
  "medical_history_entry",
  "odontogram_state",
  "radiograph",
  "treatment_catalog",
  "treatment_plan",
  "clinical_session",
  "prescription",
  "invoice",
  "payment",
  "quote",
  "stock_alert",
  "stock_item",
  "prosthesis_lab",
  "prosthesis_order",
  "drug_catalog",
  "support_ticket",
] as const;

/** Tables du Groupe B : enfants purs, transportés en cascadé (pas de curseur). */
const GROUPE_B: Readonly<Record<string, string>> = {
  invoice_item: "invoice",
  quote_item: "quote",
  prescription_item: "prescription",
  clinical_session_item: "clinical_session",
  treatment_plan_item: "treatment_plan",
  stock_transaction: "stock_item",
};

/** Tables d'infrastructure qui ne doivent JAMAIS figurer au registre. */
const EXCLUDED = [
  "account",
  "session",
  "verificationToken",
  "account_token",
  "login_attempt",
  "document_sequence",
  "platform_owner",
  "subscription_plan",
  "clinic_subscription",
  "appointment_reminder",
  "sync_outbox",
  "sync_state",
  "sync_conflict",
  "sync_merge",
  "sync_applied",
  "device",
] as const;

describe("TABLE_REGISTRY — exhaustivité", () => {
  it("déclare chaque table du Groupe A", () => {
    for (const name of GROUPE_A) {
      expect(TABLE_REGISTRY[name], `table manquante : ${name}`).toBeDefined();
    }
  });

  it("déclare chaque enfant du Groupe B, rattaché à son parent, sans curseur", () => {
    for (const [child, parent] of Object.entries(GROUPE_B)) {
      const entry = TABLE_REGISTRY[child];
      expect(entry, `enfant manquant : ${child}`).toBeDefined();
      expect(entry?.cursor).toBe(false);
      expect(TABLE_REGISTRY[parent]?.children).toContain(child);
    }
  });

  it("ne déclare AUCUNE table d'infrastructure", () => {
    for (const name of EXCLUDED) {
      expect(TABLE_REGISTRY[name], `table d'infrastructure présente : ${name}`)
        .toBeUndefined();
    }
  });

  it("n'a pas de table orpheline : tout enfant déclaré est rattaché à un parent", () => {
    const declaredChildren = new Set<string>();
    for (const entry of Object.values(TABLE_REGISTRY)) {
      for (const child of entry.children ?? []) {
        declaredChildren.add(child);
      }
    }
    const registryChildren = Object.entries(TABLE_REGISTRY)
      .filter(([, entry]) => entry.cursor === false)
      .map(([name]) => name);
    expect(new Set(registryChildren)).toEqual(declaredChildren);
  });

  it("chaque table du Groupe A est déclarée en entrée de curseur", () => {
    for (const name of GROUPE_A) {
      expect(TABLE_REGISTRY[name]?.cursor, `${name} devrait être curseur`).toBe(true);
    }
  });

  it("getReplicatedTable renvoie l'entrée ou undefined", () => {
    expect(getReplicatedTable("patient")?.name).toBe("patient");
    expect(getReplicatedTable("account")).toBeUndefined();
  });
});

describe("TABLE_REGISTRY — directions", () => {
  it("audit_log est push-only", () => {
    expect(TABLE_REGISTRY.audit_log?.direction).toBe("push-only");
  });

  it("notification est pull-only", () => {
    expect(TABLE_REGISTRY.notification?.direction).toBe("pull-only");
  });

  it("support_ticket est bidirectionnel (central gagnant sur status)", () => {
    expect(TABLE_REGISTRY.support_ticket?.direction).toBe("both");
  });

  it("pullCursorTables exclut les push-only et les enfants", () => {
    const names = pullCursorTables().map((entry) => entry.name);
    expect(names).not.toContain("audit_log");
    expect(names).not.toContain("invoice_item");
    expect(names).toContain("patient");
    expect(names).toContain("notification");
  });
});

describe("TABLE_REGISTRY — listes blanches", () => {
  it("user : password_hash / passwordHash JAMAIS déclaré", () => {
    const user = TABLE_REGISTRY.user;
    expect(user).toBeDefined();
    expect(user?.columns).not.toContain("passwordHash");
    expect(user?.columns).not.toContain("password_hash");
    // Colonnes du profil uniquement (décision tâche 5.1).
    expect([...(user?.columns ?? [])].sort()).toEqual(
      ["email", "emailVerified", "id", "image", "name", "tokenVersion"].sort(),
    );
  });

  it("chaque colonne déclarée est unique et non vide", () => {
    for (const entry of Object.values(TABLE_REGISTRY)) {
      expect(new Set(entry.columns).size, `doublon dans ${entry.name}`)
        .toBe(entry.columns.length);
      for (const column of entry.columns) {
        expect(column.length, `colonne vide dans ${entry.name}`).toBeGreaterThan(0);
        expect(
          FORBIDDEN_PAYLOAD_COLUMNS.has(column),
          `secret déclaré dans ${entry.name} : ${column}`,
        ).toBe(false);
      }
    }
  });

  it("chaque table non enfant déclare un clinicIdColumn cohérent", () => {
    for (const entry of Object.values(TABLE_REGISTRY)) {
      if (!entry.cursor) continue;
      const clinicIdColumn = entry.clinicIdColumn;
      if (clinicIdColumn === null) {
        // user, clinic et audit_log : pas de clinic_id au sens curseur.
        expect(["user", "clinic", "audit_log"]).toContain(entry.name);
      } else {
        expect(clinicIdColumn).toBe("clinicId");
        expect(entry.columns).toContain("clinicId");
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/* serializeRow — garde-fou sécurité                                           */
/* -------------------------------------------------------------------------- */

describe("serializeRow — projection sur liste blanche", () => {
  it("une ligne user contenant passwordHash ne contient PLUS ce champ après projection", () => {
    const rawUserRow: Record<string, unknown> = {
      id: "u1",
      name: "Ada",
      email: "ada@example.com",
      emailVerified: null,
      image: null,
      tokenVersion: 3,
      // Volontairement présent : simulateur d'une ligne brute lue en SQL.
      passwordHash: "$2b$10$super-secret-hash",
      password_hash: "$2b$10$super-secret-hash",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      deletedAt: null,
    };
    const projected = serializeRow("user", rawUserRow);
    expect(projected).not.toHaveProperty("passwordHash");
    expect(projected).not.toHaveProperty("password_hash");
    expect(projected).not.toHaveProperty("createdAt");
    expect(projected).toEqual({
      id: "u1",
      name: "Ada",
      email: "ada@example.com",
      emailVerified: null,
      image: null,
      tokenVersion: 3,
    });
  });

  it("projette une table métier sur sa liste blanche (colonnes hors liste retirées)", () => {
    const projected = serializeRow("patient", {
      id: "p1",
      clinicId: "c1",
      firstName: "Zoé",
      lastName: "Martin",
      phone: "0600000000",
      // Hors liste blanche : retiré.
      internalScore: 42,
      notes: null,
    });
    expect(projected).toEqual({
      id: "p1",
      clinicId: "c1",
      firstName: "Zoé",
      lastName: "Martin",
      phone: "0600000000",
      notes: null,
    });
    expect(projected).not.toHaveProperty("internalScore");
  });

  it("throw si la table est inconnue du registre", () => {
    expect(() => serializeRow("account", { userId: "u1" })).toThrow(
      /absente du registre/,
    );
    expect(() => serializeRow("definitely_not_a_table", {})).toThrow(
      /absente du registre/,
    );
  });

  it("throw si le payload n'est pas un objet", () => {
    expect(() => serializeRow("patient", null as unknown as Record<string, unknown>))
      .toThrow(/invalide/);
    expect(() => serializeRow("patient", [] as unknown as Record<string, unknown>))
      .toThrow(/invalide/);
  });

  it("protège contre un registre corrompu : une colonne interdite en liste blanche lève", () => {
    expect(isForbiddenPayloadColumn("passwordHash")).toBe(true);
    expect(isForbiddenPayloadColumn("password_hash")).toBe(true);
    expect(isForbiddenPayloadColumn("secret")).toBe(true);
    expect(isForbiddenPayloadColumn("firstName")).toBe(false);
    expect(isForbiddenPayloadColumn("tokenVersion")).toBe(false);

    // `Object.freeze` est superficiel : on simule une déclaration fautive du
    // registre en ajoutant `passwordHash` à la liste blanche de `user`, on
    // vérifie que serializeRow LÈVE (défense en profondeur), puis on restaure.
    const columns = TABLE_REGISTRY.user?.columns as string[] | undefined;
    expect(columns).toBeDefined();
    if (!columns) return;
    columns.push("passwordHash");
    try {
      expect(() => serializeRow("user", { id: "u1", passwordHash: "leaked" }))
        .toThrow(/interdite/);
    } finally {
      columns.pop();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Schémas Zod du protocole                                                    */
/* -------------------------------------------------------------------------- */

const VALID_OP = {
  opId: "7f5f3a1e-9b3a-4c2d-8e6f-0a1b2c3d4e5f",
  table: "patient",
  rowId: "p1",
  op: "insert" as const,
  payload: { id: "p1", clinicId: "c1" },
  clinicId: "c1",
  updatedAt: "2026-10-13T10:00:00.000Z",
  deviceId: "device-1",
};

describe("schémas Zod du protocole", () => {
  it("valide une opération correcte", () => {
    expect(changeOpSchema.safeParse(VALID_OP).success).toBe(true);
  });

  it("rejette un opId non-uuid", () => {
    const result = changeOpSchema.safeParse({ ...VALID_OP, opId: "not-a-uuid" });
    expect(result.success).toBe(false);
  });

  it("rejette un op hors enum", () => {
    const result = changeOpSchema.safeParse({ ...VALID_OP, op: "upsert" });
    expect(result.success).toBe(false);
  });

  it("valide un PushRequest et borne le nombre d'ops", () => {
    const ok = pushRequestSchema.safeParse({
      deviceId: "device-1",
      clinicId: "c1",
      ops: [VALID_OP],
    });
    expect(ok.success).toBe(true);

    const tooMany = pushRequestSchema.safeParse({
      deviceId: "device-1",
      clinicId: "c1",
      ops: Array.from({ length: MAX_PUSH_OPS + 1 }, () => VALID_OP),
    });
    expect(tooMany.success).toBe(false);
  });

  it("valide un PullRequest avec curseur null (premier pull) ou renseigné", () => {
    expect(
      pullRequestSchema.safeParse({ clinicId: "c1", cursor: null }).success,
    ).toBe(true);
    expect(
      pullRequestSchema.safeParse({
        clinicId: "c1",
        cursor: { updatedAt: "2026-10-13T10:00:00.000Z", id: "p1" },
        limit: 100,
      }).success,
    ).toBe(true);
    expect(
      pullRequestSchema.safeParse({
        clinicId: "c1",
        cursor: { updatedAt: "2026-10-13T10:00:00.000Z", id: "p1" },
        limit: MAX_PULL_LIMIT + 1,
      }).success,
    ).toBe(false);
  });

  it("valide un PullResponse (hasMore + curseur)", () => {
    const result = pullResponseSchema.safeParse({
      changes: [VALID_OP],
      cursor: { updatedAt: "2026-10-13T10:00:00.000Z", id: "p1" },
      hasMore: true,
    });
    expect(result.success).toBe(true);
  });

  it("valide un PushResponse (accepted / rejected / conflicts)", () => {
    const result = pushResponseSchema.safeParse({
      accepted: [VALID_OP.opId],
      rejected: [{ opId: VALID_OP.opId, reason: "unknown-table" }],
      conflicts: [{ table: "invoice", rowId: "i1", reason: "stale-rev" }],
    });
    expect(result.success).toBe(true);
  });
});
