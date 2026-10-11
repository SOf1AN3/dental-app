/**
 * Contrôle préalable au déploiement — LECTURE SEULE.
 *
 * La migration `drizzle/0016_smooth_randall.sql` est auto-réparatrice : elle
 * normalise les données qui violenteraient ses nouvelles contraintes, puis
 * les pose. Ce script ne bloque donc rien — il **annonce** ce qui sera
 * modifié, pour que le déploiement ne surprenne personne.
 *
 * Utilisation
 * -----------
 *   npm run db:preflight     # contre DATABASE_URL (production ou dev)
 *
 * Sortie non nulle uniquement en cas d'erreur technique — un rapport
 * « N lignes modifiées » n'est pas un échec, c'est le fonctionnement voulu.
 */

import "dotenv/config";
import postgres from "postgres";

type Row = Record<string, number>;

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL n'est pas défini.");
  }

  const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });

  console.log("\n=== Préflight migration 0016 ===\n");

  // L'absence de ces tables signifie que la migration n'a pas encore tourné.
  const tables = await sql`
    SELECT count(*)::int AS n FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name IN
      ('clinic_membership','stock_alert','prosthesis_order','stock_item')`;

  if ((tables[0]?.n ?? 0) < 4) {
    console.log(
      "Base vierge ou partiellement migrée : la migration s'appliquera sans nettoyage.",
    );
    await sql.end();
    return;
  }

  const findings: Array<{ label: string; n: number; note: string }> = [];

  const collect = async (
    label: string,
    query: Promise<Row[]>,
    note: string,
  ): Promise<void> => {
    const rows = await query;
    findings.push({ label, n: rows[0]?.n ?? 0, note });
  };

  // 1. Memberships directs sans joined_at -> deviendront accessibles (Z-3)
  await collect(
    "Memberships sans joined_at (accès deviendra effectif)",
    sql`SELECT count(*)::int AS n FROM "clinic_membership"
        WHERE "invited_at" IS NULL AND "joined_at" IS NULL`,
    "Correctif SEC-B02 — une invitation non acceptée ouvrait l'accès au dossier médical.",
  );

  // 2. Invitations en attente -> doivent RESTER bloquées, rien à faire
  await collect(
    "Invitations en attente (restent bloquées)",
    sql`SELECT count(*)::int AS n FROM "clinic_membership"
        WHERE "invited_at" IS NOT NULL AND "joined_at" IS NULL`,
    "Aucune modification — c'est le comportement de sécurité voulu.",
  );

  // 3. Alertes de stock en doublon -> les plus anciennes résolues (Z-62)
  await collect(
    "Alertes actives en doublon (les plus anciennes seront résolues)",
    sql`SELECT COALESCE(SUM(n) - COUNT(*), 0)::int AS n FROM (
          SELECT count(*) OVER (PARTITION BY "item_id") AS n
          FROM "stock_alert" WHERE "status" = 'active') t`,
    "Bug Z-62 — le contrôle SELECT-then-INSERT n'était pas atomique.",
  );

  // 4. Numéros de commande prothèse en doublon -> suffixés (Z-49)
  await collect(
    "Commandes prothèse au numéro dupliqué (les plus anciennes suffixées)",
    sql`SELECT COALESCE(SUM(n) - COUNT(*), 0)::int AS n FROM (
          SELECT count(*) OVER (PARTITION BY "clinic_id", "order_number") AS n
          FROM "prosthesis_order") t`,
    "Bug Z-49 — le catch{} de la séquence réémisait PRO-YYYY-00001. Aucune ligne supprimée.",
  );

  // 5. Stocks négatifs -> remis à zéro (Z-60)
  await collect(
    "Stocks à quantité négative (seront remis à zéro)",
    sql`SELECT count(*)::int AS n FROM "stock_item" WHERE "current_qty" < 0`,
    "Bug Z-61 — currentQty acceptait une valeur négative saisie par le client.",
  );

  // 6. Défaut de couverture du registre : indicateur, sans blocage
  await collect(
    "Articles sans aucun mouvement enregistré (indicatif)",
    sql`SELECT count(*)::int AS n FROM "stock_item" i
        WHERE NOT EXISTS (
          SELECT 1 FROM "stock_transaction" t WHERE t."item_id" = i."id")`,
    "Information seulement — vérifier la cohérence après migration.",
  );

  const width = Math.max(...findings.map((f) => f.label.length));
  for (const f of findings) {
    console.log(`${f.n === 0 ? "  " : "->"} ${f.label.padEnd(width)}  ${String(f.n).padStart(6)}`);
    console.log(`      ${f.note}`);
  }

  const total = findings.reduce((s, f) => s + f.n, 0);
  console.log(
    total === 0
      ? "\nRien à normaliser : la migration s'appliquera sans toucher aux données.\n"
      : "\nAucun blocage : la migration 0016 normalise ces lignes AVANT de poser\n" +
        "les contraintes. Un rapport non nul décrit ce qui sera modifié.\n",
  );

  await sql.end();
}

main().catch((err) => {
  console.error("Échec du préflight :", err);
  process.exit(1);
});
