import { and, eq, like, sql } from "drizzle-orm";
import { invoices, quotes, prosthesisOrders } from "@/lib/db/schema";
import { db } from "@/lib/db/db";
import {
  SEQUENCE_TYPE_INVOICE,
  SEQUENCE_TYPE_QUOTE,
} from "@/lib/sync/numbering";

/**
 * Tâche 6.1b — **plancher des numéros déjà émis** (garde-fou anti-doublon).
 *
 * ## Le problème
 *
 * `document_sequence.last_number` peut être **inférieur** à des numéros déjà
 * imprimés : le site `src/lib/actions/prosthesis.ts` allocate avec
 * `GREATEST(last_number + 1, highestIssued + 1)`, preuve qu'un compteur perdu
 * ou réinitialisé reste possible. Si le central découpait un bloc
 * `[last_number + 1 …]`, il réémettrait un numéro **déjà sorti** → doublon de
 * facture/prothèse, irréparable une fois imprimé.
 *
 * ## Le garde-fou
 *
 * Avant de découper un bloc, le central calcule `highestIssued` = numéro **le
 * plus élevé réellement émis** pour ce `(clinicId, type)` en interrogeant la
 * table de documents pertinente, puis pose
 * `blockStart = max(last_number, highestIssued) + 1`. Aucun numéro déjà émis ne
 * peut donc être recréé, même si `last_number` a rétrogradé.
 *
 * ## Période de numérotation (relevé des 5 sites d'allocation)
 *
 *  - `invoice` : `FAC-<AAAA>-<5 chiffres>` — compteur **global** (jamais remis à
 *    zéro) ; l'année n'est qu'affichée → `highestIssued` = max sur **toutes**
 *    les factures du cabinet ;
 *  - `quote` : `DEV-<AAAA>-<4 chiffres>` — compteur **global**, idem ;
 *  - `prosthesis:<année>` : `PRO-<AAAA>-<5 chiffres>` — compteur **par année**
 *    civile → `highestIssued` = max sur les commandes **de cette année**.
 *
 * ## Fragilité de l'extraction (documentée)
 *
 * L'extraction repose sur le fait que le numéro se termine par le compteur
 * (`…-<compteur>` ; regex `(\d+)$`). C'est le format actuel des trois tables.
 * Si un préfixe/suffixe supplémentaire venait s'ajouter après le compteur, cette
 * lecture deviendrait fausse — d'où le test pur {@link maxNumericSuffix} qui
 * fixe le comportement attendu et signale la limite.
 */

type BlocksFloorDb = typeof db;
/** Type de la transaction Drizzle passée à l'interrogateur du plancher. */
export type FloorTx = Parameters<Parameters<BlocksFloorDb["transaction"]>[0]>[0];

/* -------------------------------------------------------------------------- */
/* Logique pure (testable hermétiquement)                                      */
/* -------------------------------------------------------------------------- */

/**
 * Extrait le **compteur** d'une liste de numéros de documents et renvoie le plus
 * élevé (0 si la liste est vide ou qu'aucun suffixe numérique n'est trouvé).
 *
 * Le compteur est le **suffixe numérique final** du numéro
 * (`<PRÉFIXE>-<AAAA>-<compteur>`). On lit `(\d+)$` : robuste aux zéros de
 * remplissage et à l'année variable ; **fragile** si un suffixe non numérique
 * venait après le compteur (documenté en tête de module).
 */
export function maxNumericSuffix(values: readonly string[]): number {
  let max = 0;
  for (const value of values) {
    const match = /(\d+)$/.exec(value);
    if (match === null) continue;
    const parsed = Number.parseInt(match[1], 10);
    if (Number.isFinite(parsed) && parsed > max) max = parsed;
  }
  return max;
}

/**
 * Bornes d'un nouveau bloc : `blockStart = max(last_number, highestIssued) + 1`.
 *
 * Le plancher `highestIssued` prime quand il dépasse `last_number` (compteur
 * rétrogradé) ; `last_number` prime sinon (bloc d'un autre poste déjà découpé).
 */
export function computeBlockStart(lastNumber: number, highestIssued: number): number {
  return Math.max(lastNumber, highestIssued) + 1;
}

/* -------------------------------------------------------------------------- */
/* Interrogateur SQL (chemin de production)                                    */
/* -------------------------------------------------------------------------- */

/** Regex Postgres capturant le compteur final (`…-<compteur>`). */
const COUNTER_SQL_REGEX = "(\\d+)$";

/**
 * Numéro le plus élevé **réellement émis** pour `(clinicId, type)`, ou `0`.
 *
 * Exécute `MAX(CAST(SUBSTRING(number FROM '(\d+)$') AS integer))` sur la table
 * de documents correspondante, bornée au cabinet (et à l'année pour la
 * prothèse). `NULL` (aucun document) → `0`.
 *
 * @param tx transaction Drizzle **ouverte** (le verrou `FOR UPDATE` de la
 *           séquence est déjà tenu par l'appelant → aucune course possible avec
 *           une allocation centrale concurrente).
 */
export async function findHighestIssuedNumber(
  tx: FloorTx,
  clinicId: string,
  type: string,
): Promise<number> {
  let highest: number | null;

  if (type === SEQUENCE_TYPE_INVOICE) {
    const [row] = await tx
      .select({
        highest: sql<number | null>`MAX(CAST(SUBSTRING(${invoices.number} FROM CAST(${COUNTER_SQL_REGEX} AS text)) AS integer))`,
      })
      .from(invoices)
      .where(and(eq(invoices.clinicId, clinicId), like(invoices.number, "FAC-%")));
    highest = row?.highest ?? null;
  } else if (type === SEQUENCE_TYPE_QUOTE) {
    const [row] = await tx
      .select({
        highest: sql<number | null>`MAX(CAST(SUBSTRING(${quotes.number} FROM CAST(${COUNTER_SQL_REGEX} AS text)) AS integer))`,
      })
      .from(quotes)
      .where(and(eq(quotes.clinicId, clinicId), like(quotes.number, "DEV-%")));
    highest = row?.highest ?? null;
  } else if (type.startsWith("prosthesis:")) {
    // Séquence annuelle : ne retenir que les commandes DE L'ANNÉE du type.
    const year = type.slice("prosthesis:".length);
    const [row] = await tx
      .select({
        highest: sql<number | null>`MAX(CAST(SUBSTRING(${prosthesisOrders.orderNumber} FROM CAST(${COUNTER_SQL_REGEX} AS text)) AS integer))`,
      })
      .from(prosthesisOrders)
      .where(
        and(
          eq(prosthesisOrders.clinicId, clinicId),
          like(prosthesisOrders.orderNumber, `PRO-${year}-%`),
        ),
      );
    highest = row?.highest ?? null;
  } else {
    // Type non numérotable : la route refuse déjà avant d'arriver ici (Zod).
    return 0;
  }

  return highest ?? 0;
}
