/**
 * ⚠️ INTERDIT : la directive `"use server"` en tête de ce fichier.
 *
 * Pourquoi : sous Next.js (App Router), toute fonction EXPORTÉE d'un module portant
 * la directive `"use server"` est transformée en Server Action, c'est-à-dire exposée
 * comme endpoint HTTP PUBLIC, invoquable par n'importe quel client avec les arguments
 * de son choix. C'est exactement le bug corrigé ici : `requireActivePatient` est
 * exportée depuis `patient.ts` (dont la première ligne est `"use server"`), donc
 * n'importe quel client peut l'invoquer avec une `clinicId` arbitraire et recevoir
 * la ligne patient complète d'une autre clinique (faille IDOR / accès indirect).
 *
 * Ce module est un guard serveur PUR : ses exports ne sont appelés que par des Server
 * Actions déjà authentifiées (`requireAuth` + `requireClinicAccessOrThrow`), jamais
 * depuis le client. Sans la directive, ces exports restent des fonctions serveur
 * internes, non invocables via HTTP.
 *
 * Rôle unique de ce fichier : valider l'appartenance d'une ressource à la clinique
 * courante. Il n'authentifie PAS l'utilisateur (rôle de `requireAuth` /
 * `requireClinicAccessOrThrow`, déjà appelés en amont par chaque action).
 *
 * Note d'emplacement : ce module vit hors de `src/lib/actions/` car il ne porte PAS
 * `"use server"` — il n'est pas une Server Action. Le garder dans `actions/` prêterait
 * à confusion pour un lecteur.
 */

import { db } from "@/lib/db/db";
import { patients } from "@/lib/db/schema";
import { and, eq, isNull } from "drizzle-orm";

/**
 * Cœur privé (NON exporté) : une seule requête paramétrée, déclinée par les deux
 * guards publics ci-dessous.
 *
 * @param clinicId Clinique propriétaire attendue (fournie par le serveur).
 * @param patientId Identifiant du patient, potentiellement fourni par le client.
 * @param opts.includeArchived `true` pour ignorer le filtre d'archivage (`deletedAt`).
 * @returns La ligne du patient, ou `undefined` si introuvable / autre clinique.
 */
async function findOwnedPatient(
  clinicId: string,
  patientId: string,
  opts: { includeArchived: boolean },
): Promise<typeof patients.$inferSelect | undefined> {
  return db.query.patients.findFirst({
    where: opts.includeArchived
      ? and(eq(patients.id, patientId), eq(patients.clinicId, clinicId))
      : and(
          eq(patients.id, patientId),
          eq(patients.clinicId, clinicId),
          isNull(patients.deletedAt),
        ),
  });
}

/**
 * Vérifie qu'un patient existe, qu'il appartient bien à `clinicId` et qu'il n'est pas
 * archivé, puis retourne sa ligne.
 *
 * `clinicId` doit provenir du serveur (session / contexte multi-tenant), jamais du
 * client. Ce helper ne fait QUE la validation de la ressource : aucune vérification
 * d'authentification ni de rôle ici.
 *
 * Requête identique à celle historiquement écrite dans `patient.ts`
 * (`requireActivePatient`) : une seule implémentation sémantique de la vérification
 * d'appartenance patient-clinique.
 *
 * @param clinicId Clinique propriétaire attendue (fournie par le serveur).
 * @param patientId Identifiant du patient, potentiellement fourni par le client.
 * @returns La ligne complète du patient (`patients.$inferSelect`).
 * @throws `Error("Patient introuvable ou archivé")` si le patient n'existe pas,
 * appartient à une autre clinique, ou est archivé — le **même message** dans les trois
 * cas pour qu'un attaquant ne puisse pas distinguer un ID valide d'une autre clinique
 * d'un ID inexistant (pas d'oracle d'énumération).
 */
export async function requireOwnedPatient(
  clinicId: string,
  patientId: string,
): Promise<typeof patients.$inferSelect> {
  const patient = await findOwnedPatient(clinicId, patientId, {
    includeArchived: false,
  });

  if (!patient) {
    throw new Error("Patient introuvable ou archivé");
  }

  return patient;
}

/**
 * Vérifie la SEULE propriété du patient : qu'il existe et appartienne à `clinicId`,
 * **sans** filtre d'archivage — un patient archivé (`deletedAt` non nul) est ici
 * légitime (consultation d'historique, réactivation, etc.).
 *
 * Sémantique portée par le nom : `requirePatientOwnership` = propriété ; le filtre
 * d'archivage est porté par `requireOwnedPatient` (fail-closed par défaut).
 *
 * `clinicId` doit provenir du serveur (session / contexte multi-tenant), jamais du
 * client. Ce helper ne fait QUE la validation de la ressource : aucune vérification
 * d'authentification ni de rôle ici.
 *
 * @param clinicId Clinique propriétaire attendue (fournie par le serveur).
 * @param patientId Identifiant du patient, potentiellement fourni par le client.
 * @returns La ligne complète du patient (`patients.$inferSelect`).
 * @throws `Error("Patient introuvable")` si le patient n'existe pas ou appartient à
 * une autre clinique — le **même message** dans les deux cas pour qu'un attaquant ne
 * puisse pas distinguer un ID valide d'une autre clinique d'un ID inexistant
 * (pas d'oracle d'énumération / IDOR indirect).
 */
export async function requirePatientOwnership(
  clinicId: string,
  patientId: string,
): Promise<typeof patients.$inferSelect> {
  const patient = await findOwnedPatient(clinicId, patientId, {
    includeArchived: true,
  });

  if (!patient) {
    throw new Error("Patient introuvable");
  }

  return patient;
}
