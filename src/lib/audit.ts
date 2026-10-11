import { db } from "@/lib/db/db";
import { auditLogs } from "@/lib/db/schema";
import { getCurrentUser } from "@/lib/auth-utils";
import { headers } from "next/headers";

type AuditAction = "create" | "update" | "delete" | "status_change";

/**
 * Z-75 — état de santé du journal d'audit, tenu EN MÉMOIRE DE PROCESSUS
 * (best-effort, remis à zéro à chaque redémarrage / pour chaque isolate).
 *
 * `logAction` doit rester NON BLOQUANT : une action déjà commitee ne doit
 * jamais être annulée par l'échec d'écriture de son propre journal. La
 * contrepartie (Z-75) est qu'un échec ne doit pas non plus disparaître : ce
 * compteur le rend DETECTABLE programmatiquement, en plus du journal
 * structuré `[audit]` écrit dans les logs serveur.
 *
 * Aucune donnée avant/après (données de santé) n'y est conservée : seule la
 * MÉTADONNÉE de l'échec l'est, jamais le contenu de l'opération.
 */
export type AuditLogHealth = {
  failureCount: number;
  lastFailureAt: string | null;
  lastFailure: {
    action: AuditAction;
    entityType: string;
    entityId: string;
    clinicId: string | null;
    reason: string;
  } | null;
};

const auditLogHealth: AuditLogHealth = {
  failureCount: 0,
  lastFailureAt: null,
  lastFailure: null,
};

/**
 * Z-75 — exposition en lecture des échecs d'audit du processus courant
 * (copie défensive). Destinée à un point de surveillance/health-check : si
 * `failureCount` augmente, des actions sensibles se sont produites SANS trace
 * dans `audit_log` et la valeur probante du journal est entamée.
 *
 * Non bloquant par construction : cette fonction ne lève jamais.
 */
export function getAuditLogHealth(): AuditLogHealth {
  const last = auditLogHealth.lastFailure;
  return {
    failureCount: auditLogHealth.failureCount,
    lastFailureAt: auditLogHealth.lastFailureAt,
    lastFailure: last ? { ...last } : null,
  };
}

/**
 * Écrit une entrée dans `audit_log`.
 *
 * Comportement inchangé pour l'appelant (Z-75) : retourne `Promise<void>`,
 * ne lève JAMAIS d'exception, donc jamais de rollback d'une transaction dans
 * laquelle un appelant l'invoque (`createInvoice`, `recordPayment`,
 * `addToWaitingRoom`, …) et jamais d'échec d'action causé par le journal.
 */
export async function logAction(input: {
  clinicId: string | null;
  action: AuditAction;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
}): Promise<void> {
  // Relève hors du `try` pour être rapportable dans le journal d'échec
  // ci-dessous (aucune donnée de santé, seulement l'identifiant d'acteur).
  let actorUserId: string | null = null;

  try {
    const user = await getCurrentUser();
    actorUserId = user?.id ?? null;
    const headerStore = await headers();

    // Z-74 — provenance de l'adresse IP journalisée.
    //
    // `x-forwarded-for` et `x-real-ip` sont des en-têtes SOUS CONTRÔLE DU
    // CLIENT : n'importe quel client peut les envoyer directement, et tout
    // relais qui ne les réécrit pas les transmet tels quels. La valeur lue
    // ici n'est FIABLE QUE derrière un proxy de confiance (reverse proxy du
    // déploiement) qui :
    //   • se place sur TOUS les chemins d'accès à l'application (aucune route
    //     directe ne le contourne), et
    //   • écrase/normalise l'en-tête à l'entrée (il ne « préfixe » pas une
    //     liste fournie par le client sans la remplacer).
    // Même dans ce cas, elle désigne une ADRESSE RÉSEAU observée — pas une
    // identité : elle est falsifiable de façon native (spoofable), peut être
    // celle d'un NAT/VPN/autre proxy, et ne constitue JAMAIS une preuve
    // d'identité, ni un indicateur d'authenticité ou de responsabilité.
    // Elle n'est qu'un indice de recoupement, à traiter comme tel lors
    // d'une investigation (la preuve d'identité reste la session
    // authentifiée : `actorUserId`).
    const ip =
      headerStore.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      headerStore.get("x-real-ip");

    await db.insert(auditLogs).values({
      clinicId: input.clinicId,
      actorUserId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      beforeState: input.before as Record<string, unknown> | undefined,
      afterState: input.after as Record<string, unknown> | undefined,
      ipAddress: ip || null,
    });
  } catch (err) {
    // Z-75 — l'échec reste NON BLOQUANT pour l'action, mais n'est plus
    // silencieux. Deux canaux de détection, sans toucher au contrat :
    //  1. journal STRUCTURÉ — préfixe `[audit]` stable, contexte de l'opération
    //     (identifiants seulement, jamais `before`/`after`), dans les logs ;
    //  2. compteur processus + dernière panne, exposés par
    //     `getAuditLogHealth()` pour une détection programmatique.
    //
    // ⚠️ SANITISATION OBLIGATOIRE de l'erreur. Toute erreur de requête Drizzle
    // est wrapée en `DrizzleQueryError`, dont le message vaut :
    //     `Failed query: <SQL>\nparams: <VALEURS LIÉES>`
    // La seconde ligne contient **les paramètres liés** — c'est-à-dire, pour
    // cet INSERT, `before_state` et `after_state` : des **données de santé**.
    // On ne retient donc que la **première ligne**, et on ne passe **jamais**
    // l'`Error` brute à `console.error` (sa stack reprend le message multi-
    // lignes, et ses propriétés `query`/`params` seraient sérialisées).
    const reason =
      err instanceof Error
        ? `${err.name}: ${err.message.split("\n")[0]}`.slice(0, 300)
        : String(err).slice(0, 300);
    auditLogHealth.failureCount += 1;
    auditLogHealth.lastFailureAt = new Date().toISOString();
    auditLogHealth.lastFailure = {
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      clinicId: input.clinicId,
      reason,
    };
    console.error(
      "[audit] logAction a échoué — l'action est commise SANS trace dans audit_log",
      {
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        clinicId: input.clinicId,
        actorUserId,
        reason,
      },
    );
  }
}
