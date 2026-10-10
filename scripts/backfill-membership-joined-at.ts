/**
 * Script one-shot de backfill — MEMBERSHIP : joined_at
 *
 * ⚠️  À LIRE AVANT DE LANCER
 *
 * Contexte
 * --------
 * Les correctifs de sécurité Z-3 et A-5 exigent désormais `joined_at IS NOT NULL`
 * pour tout accès à une clinique (contrôles serveur ET middleware `src/proxy.ts`).
 * C'est le correctif de la faille P0 SEC-B02 : une simple invitation, jamais
 * acceptée, ouvrait l'accès complet au dossier médical.
 *
 * Problème
 * --------
 * Ce filtre s'applique au CODE mais pas aux DONNÉES EXISTANTES. Toute ligne
 * `clinic_membership` créée avant ce correctif **et** n'ayant jamais été produite
 * par `acceptInvitation()` ou par la création de clinique se retrouve avec
 * `joined_at IS NULL` → l'utilisateur **perd l'accès** à sa clinique.
 *
 * Contre-exemple avéré : `seed.ts` créait le propriétaire d'une clinique sans
 * `joined_at` (corrigé dans A-5, mais les bases déjà seedées restent concernées).
 *
 * Ce que fait ce script
 * ---------------------
 * Ne cible QUE les lignes sans `invited_at` : ce sont les memberships directs
 * (owner créé à la naissance d'une clinique, imports manuels, anciens seeds).
 * Les invitations réellement en attente (`invited_at IS NOT NULL`) sont laissées
 * intactes — c'est précisément le comportement de sécurité voulu.
 *
 * Utilisation
 * ----------
 *   1. DIAGNOSTIC (lecture seule, recommandé en premier) :
 *        npx tsx scripts/backfill-membership-joined-at.ts
 *
 *   2. APPLICATION (écriture, irréversible) :
 *        npx tsx scripts/backfill-membership-joined-at.ts --apply
 *
 * Le diagnostic affiche les lignes concernées avant toute écriture. En cas de
 * doute, ne pas appliquer et consulter le résultat du diagnostic.
 */

import { db } from "../src/lib/db/db";
import { clinicMemberships } from "../src/lib/db/schema";
import { and, isNotNull, isNull } from "drizzle-orm";

/** Lignes éligibles : membership direct, sans joined_at. */
const eligibleFilter = and(
  isNull(clinicMemberships.joinedAt),
  isNull(clinicMemberships.invitedAt),
);

/** Lignes à NE PAS toucher : invitations réellement en attente. */
const pendingInvitationFilter = and(
  isNull(clinicMemberships.joinedAt),
  isNotNull(clinicMemberships.invitedAt),
);

async function main() {
  const apply = process.argv.includes("--apply");

  // --- Diagnostic -----------------------------------------------------------
  const affected = await db
    .select({
      id: clinicMemberships.id,
      userId: clinicMemberships.userId,
      clinicId: clinicMemberships.clinicId,
      role: clinicMemberships.role,
      createdAt: clinicMemberships.createdAt,
    })
    .from(clinicMemberships)
    .where(eligibleFilter);

  // Les invitations en attente doivent rester NULL : on les compte pour vérifier
  // qu'aucune ne sera touchée.
  const pending = await db
    .select({ id: clinicMemberships.id })
    .from(clinicMemberships)
    .where(pendingInvitationFilter);

  console.log("");
  console.log("=== Backfill clinic_membership.joined_at ===");
  console.log("");
  console.log(`Lignes à corriger (sans invited_at, sans joined_at) : ${affected.length}`);
  console.log(`Invitations en attente laissées intactes          : ${pending.length}`);
  console.log("");

  if (affected.length === 0) {
    console.log("Rien à faire. La base est déjà cohérente.");
    return;
  }

  console.log("Détail des memberships concernés :");
  for (const m of affected) {
    console.log(
      `  - role=${m.role.padEnd(6)} user=${m.userId} clinic=${m.clinicId} créé le ${m.createdAt.toISOString()}`,
    );
  }
  console.log("");

  if (!apply) {
    console.log("Mode DIAGNOSTIC — aucune écriture effectuée.");
    console.log("Pour appliquer : npx tsx scripts/backfill-membership-joined-at.ts --apply");
    return;
  }

  // --- Application ----------------------------------------------------------
  const result = await db
    .update(clinicMemberships)
    .set({ joinedAt: new Date() })
    .where(eligibleFilter)
    .returning({ id: clinicMemberships.id });

  console.log(`Backfill appliqué : ${result.length} membership(s) mis à jour.`);
  console.log("");
  console.log("Vérification finale (doit être 0) :");
  const remaining = await db
    .select({ id: clinicMemberships.id })
    .from(clinicMemberships)
    .where(eligibleFilter);
  console.log(`  memberships toujours sans joined_at : ${remaining.length}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Échec du backfill :", err);
    process.exit(1);
  });
