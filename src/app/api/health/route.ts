import { NextResponse } from "next/server";
import packageJson from "../../../../package.json";

/**
 * Tâche 5.2c — `GET /api/health` : sonde de connectivité du serveur central.
 *
 * Le poste desktop l'appelle (timeout 5 s, plan §5) pour distinguer « pas
 * d'internet » du « serveur en panne » avant toute synchronisation.
 *
 * Invariants (NON NÉGOCIABLES) :
 *  1. **Aucune authentification** : la sonde doit répondre y compris quand le
 *     jeton d'appareil est expiré (c'est précisément ce qu'on veut mesurer).
 *  2. **Zéro lecture de base** : la route répond `200` même si PostgreSQL est
 *     injoignable — elle mesure la disponibilité du *processus*, pas celle des
 *     dépendances. Aucun import de `@/lib/db/*` ici.
 *  3. **Zéro donnée, zéro secret** : `status` (état du processus), `time`
 *     (horloge serveur, jamais l'horloge client) et `version` (version du
 *     paquet publiée, servie au client pour imposer une version minimale —
 *     plan §« compatibilité »). Rien d'autre.
 *  4. Jamais mis en cache (`force-dynamic`) : la réponse doit refléter l'état
 *     à l'instant de l'appel.
 */

export const dynamic = "force-dynamic";

/** Corps de la réponse — volontairement fermé (aucun champ sensible possible). */
export interface HealthResponse {
  status: "ok";
  /** Horodatage **serveur** au format ISO 8601. */
  time: string;
  /** Version publiée de l'application (source : `package.json`). */
  version: string;
}

export async function GET(): Promise<Response> {
  const body: HealthResponse = {
    status: "ok",
    time: new Date().toISOString(),
    version: packageJson.version,
  };
  return NextResponse.json(body);
}
