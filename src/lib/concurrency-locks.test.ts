/**
 * Tests de RÉGRESSION SÉCURITÉ — verrous de concurrence (Z-21/Z-22/Z-23).
 *
 * POURQUOI UN TEST DE SOURCE ET NON UN TEST D'EXÉCUTION ?
 * Les verrous (`SELECT … FOR UPDATE`, conditions rejouées dans le `WHERE`
 * d'un `UPDATE`, décompte de lignes via `RETURNING`) sont STRUCTURAUX : ils
 * n'ont d'effet QUE sous de vraies transactions concurrentes contre une base
 * PostgreSQL réelle. Les tester par exécution exigerait au minimum un vrai
 * serveur PG + deux clients qui commitent en parallèle (flaky par nature),
 * ou un mock de `db` — ce qui ne testerait que le mock, pas le verrou
 * réel. Ces tests de source piégent donc la RÉGRESSION la plus probable :
 * un refactor qui supprime ou recadre un verrou (`FOR UPDATE` retiré,
 * condition `status = 'in_progress'` sortie du `WHERE`, `AND
 * converted_invoice_id IS NULL` perdu) sans que personne ne s'en aperçoive
 * en relisant le diff. Chaque échec indique explicitement quoi réparer.
 *
 * Les trois verrous piégés :
 *  1. `recordPayment`   : facture relue sous `FOR UPDATE` dans la transaction
 *                        (sérialise les encaissements concurrents, Z-23) ;
 *  2. `convertQuoteToInvoice` : devis relu sous `FOR UPDATE` + claim conditionnel
 *                        `WHERE … AND converted_invoice_id IS NULL` (empêche la
 *                        double conversion, Z-22) ;
 *  3. `closeSession`    : condition `status = 'in_progress'` REJOUÉE dans le
 *                        `WHERE` de l'UPDATE + décompte de lignes (une seule
 *                        facture par séance sous concurrence, Z-21).
 *
 * Aucune base, aucun mock : lecture des sources uniquement.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Lecture des sources — chemins dérivés de l'emplacement de ce module, jamais
// du cwd (convention multi-tenant.guard.test.ts).
// ---------------------------------------------------------------------------

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FINANCIAL_FILE = "src/lib/actions/financial.ts";
const SESSION_FILE = "src/lib/actions/session.ts";

const fileCache = new Map<string, string>();

function readProjectFile(relativePath: string): string {
  const cached = fileCache.get(relativePath);
  if (cached !== undefined) return cached;
  const content = readFileSync(join(PROJECT_ROOT, relativePath), "utf8");
  fileCache.set(relativePath, content);
  return content;
}

// ---------------------------------------------------------------------------
// Masquage des commentaires (chaînes INTACTES : les motifs cherchés contiennent
// des chaînes comme `"in_progress"`). Un motif mentionné uniquement dans un
// commentaire ne doit jamais satisfaire un test — sinon la disparition du
// verrou réel passerait inaperçue.
// ---------------------------------------------------------------------------

function maskComments(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source.charAt(i);
    const c2 = source.charAt(i + 1);

    if (c === "/" && c2 === "/") {
      let j = i;
      while (j < n && source.charAt(j) !== "\n") j++;
      out += " ".repeat(j - i);
      i = j;
      continue;
    }

    if (c === "/" && c2 === "*") {
      let j = i + 2;
      while (j < n && !(source.charAt(j) === "*" && source.charAt(j + 1) === "/")) j++;
      j = Math.min(n, j + 2);
      out += " ".repeat(j - i);
      i = j;
      continue;
    }

    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      let j = i + 1;
      while (j < n) {
        if (source.charAt(j) === "\\") {
          j += 2;
          continue;
        }
        if (source.charAt(j) === quote) break;
        j++;
      }
      const hasClosing = j < n;
      const end = hasClosing ? j + 1 : n;
      out += source.slice(i, end);
      i = end;
      continue;
    }

    out += c;
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Extraction du corps d'une fonction (accolades équilibrées sous masque),
// réutilisant la technique éprouvée de multi-tenant.guard.test.ts : le corps
// est délimité par accolades équilibrées, la liste de paramètres est sautée
// par appariement de parenthèses (elle peut contenir des accolades de types),
// et le type de retour est traversé en suivant la profondeur des chevrons.
// ---------------------------------------------------------------------------

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findFunctionBody(source: string, name: string): string | null {
  const masked = maskComments(source);
  return findFunctionBodyInMasked(masked, name);
}

function findFunctionBodyInMasked(masked: string, name: string): string | null {
  const escaped = escapeRegExp(name);
  const declaration = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${escaped}\\b`);
  const match = declaration.exec(masked);
  if (match === null) return null;

  const paramsOpen = masked.indexOf("(", match.index);
  if (paramsOpen === -1) return null;
  let parens = 0;
  let paramsClose = -1;
  for (let i = paramsOpen; i < masked.length; i++) {
    const ch = masked.charAt(i);
    if (ch === "(") parens++;
    else if (ch === ")") {
      parens--;
      if (parens === 0) {
        paramsClose = i;
        break;
      }
    }
  }
  if (paramsClose === -1) return null;

  let angles = 0;
  let bodyStart = -1;
  for (let i = paramsClose + 1; i < masked.length; i++) {
    const ch = masked.charAt(i);
    if (ch === "{" && angles === 0) {
      bodyStart = i;
      break;
    }
    if (ch === "=" && masked.charAt(i + 1) === ">") {
      i++;
      continue;
    }
    if (ch === "<") angles++;
    else if (ch === ">") angles--;
  }
  if (bodyStart === -1) return null;

  let braces = 0;
  for (let i = bodyStart; i < masked.length; i++) {
    const ch = masked.charAt(i);
    if (ch === "{") braces++;
    else if (ch === "}") {
      braces--;
      if (braces === 0) {
        // Corps MASQUÉ : commentaires effacés, chaînes intacts — un motif
        // mentionné dans un commentaire ne peut donc jamais satisfaire les
        // assertions ci-dessous, tandis que `.for("update")` (chaîne réelle)
        // reste détectable.
        return masked.slice(bodyStart, i + 1);
      }
    }
  }
  return null;
}

/** Extrait le corps de fonction ; échoue explicitement si la fonction a disparu. */
function bodyOf(file: string, fn: string): string {
  const body = findFunctionBody(readProjectFile(file), fn);
  if (body === null) {
    throw new Error(
      `${file} → ${fn}() introuvable : le test de verrou ne peut pas s'appliquer. ` +
        "Rétablir la fonction ou mettre à jour ce test — sans elle, le contrôle de " +
        "concurrence correspondant disparaît en silence.",
    );
  }
  return body;
}

// ---------------------------------------------------------------------------
// Auto-test du détecteur — SANS lui, un masqueur cassé rejetterait à tort
// (faux négatif) ou accepterait un motif de commentaire (faux positif) :
// dans les deux cas la protection perdrait tout sens.
// ---------------------------------------------------------------------------

describe("auto-tests — détecteur de verrous", () => {
  it("repère un verrou réel en code et ignore une mention en commentaire", () => {
    const real = 'async function f() {\n  await tx.select().from(t).limit(1).for("update");\n}';
    const commented = 'async function f() {\n  // sérialise via .for("update") en théorie\n}';
    expect(findFunctionBody(real, "f"), "verrou réel non détecté : extracteur cassé").toContain(
      '.for("update")',
    );
    expect(
      findFunctionBody(commented, "f"),
      "une mention en commentaire ne doit jamais compter comme un verrou",
    ).not.toContain('.for("update")');
  });

  it("extrait un corps dont les params/type de retour contiennent des accolades", () => {
    const src =
      "export async function g(x: { a?: string } | undefined): Promise<{ e?: string }> {\n" +
      '  return { e: "marker" };\n' +
      "}";
    expect(findFunctionBody(src, "g")).toContain('"marker"');
  });

  it("rejette un nom de fonction absent", () => {
    expect(findFunctionBody("async function h() {}", "nope")).toBeNull();
  });
});

// ===========================================================================
// 1. recordPayment — la facture est relue sous FOR UPDATE dans la transaction
// ===========================================================================

describe("Z-23 — recordPayment verrouille la facture (FOR UPDATE)", () => {
  const body = bodyOf(FINANCIAL_FILE, "recordPayment");

  it("contient un SELECT … FOR UPDATE (sérialisation des encaissements)", () => {
    expect(
      /\.for\(\s*["']update["']\s*\)/.test(body),
      "recordPayment doit relire la facture avec SELECT … FOR UPDATE dans la " +
        "transaction : sans verrou, deux encaissements concurrents se recalculent " +
        "sur la même somme partielle et la facture reste à partially_paid alors " +
        "qu'elle est soldée (lost update, Z-23). Rétablir .for(\"update\").",
    ).toBe(true);
  });

  it("le verrou est acquis AVANT l'insertion du paiement", () => {
    const lockIndex = body.search(/\.for\(\s*["']update["']\s*\)/);
    const insertIndex = body.indexOf(".insert(payments)");
    expect(lockIndex, "FOR UPDATE introuvable dans le corps (auto-test ci-dessus cassé ?)").toBeGreaterThan(-1);
    expect(
      insertIndex,
      "insert(payments) introuvable : recordPayment a été refactorisé, mettez à jour ce test.",
    ).toBeGreaterThan(-1);
    expect(
      lockIndex < insertIndex,
      "Le SELECT … FOR UPDATE doit précéder l'insertion du paiement : le verrou " +
        "tient jusqu'au COMMIT et sérialise les encaissements concurrents ; acquis " +
        "après l'INSERT, il ne protège plus le décompte.",
    ).toBe(true);
  });

  it("le statut est recalculé sous le verrou (recalcInvoiceStatus dans la transaction)", () => {
    expect(
      body,
      "recordPayment doit recalculer le statut via recalcInvoiceStatus() avec la somme " +
        "des paiements relue SOUS verrou, après l'INSERT.",
    ).toContain("recalcInvoiceStatus(");
  });
});

// ===========================================================================
// 2. convertQuoteToInvoice — FOR UPDATE + claim conditionnel IS NULL
// ===========================================================================

describe("Z-22 — convertQuoteToInvoice verrouille le devis et exige IS NULL", () => {
  const body = bodyOf(FINANCIAL_FILE, "convertQuoteToInvoice");

  it("le devis est relu sous FOR UPDATE dans la transaction", () => {
    expect(
      /\.for\(\s*["']update["']\s*\)/.test(body),
      "convertQuoteToInvoice doit relire le devis avec SELECT … FOR UPDATE : sans " +
        "verrou, deux conversions concurrentes lisent toutes deux " +
        "convertedInvoiceId = null et facturisent chacune le devis (double facture, " +
        "Z-22). Rétablir .for(\"update\").",
    ).toBe(true);
  });

  it("le claim rejoue AND converted_invoice_id IS NULL dans le WHERE de l'UPDATE", () => {
    expect(
      /isNull\(\s*quotes\.convertedInvoiceId\s*\)/.test(body),
      "convertQuoteToInvoice doit écrire converted_invoice_id avec la condition " +
        "AND converted_invoice_id IS NULL dans le WHERE : Postgres réévalue le WHERE " +
        "contre la version engagée de la ligne, la seconde transaction affecte 0 " +
        "ligne et son rollback annule sa facture (Z-22). Sans la condition, la " +
        "deuxième conversion écrase le lien.",
    ).toBe(true);
  });

  it("le décompte de lignes (RETURNING) décide : 0 ligne → throw → rollback", () => {
    expect(
      /\.returning\(/.test(body),
      "Le claim UPDATE doit usar .returning() pour décompter les lignes affectées : " +
        "c'est ce décompte qui distingue le gagnant du perdant (Z-22).",
    ).toBe(true);
    expect(
      /if\s*\(\s*!claimed\s*\)\s*throw/.test(body),
      "Un claim sur 0 ligne (devis déjà facturé par une transaction concurrente) " +
        "doit lever une erreur pour déclencher le ROLLBACK de la facture, des lignes " +
        "et de la séquence (Z-22).",
    ).toBe(true);
  });
});

// ===========================================================================
// 3. closeSession — condition status = 'in_progress' dans le WHERE + décompte
// ===========================================================================

describe("Z-21 — closeSession exige in_progress ET décompte les lignes", () => {
  const body = bodyOf(SESSION_FILE, "closeSession");

  it("la condition status = 'in_progress' est REJOUÉE dans le WHERE de l'UPDATE", () => {
    expect(
      /eq\(\s*clinicalSessions\.status\s*,\s*["']in_progress["']\s*\)/.test(body),
      "closeSession doit rejouer eq(clinicalSessions.status, \"in_progress\") dans le " +
        "WHERE de l'UPDATE de réclamation : la garde JS `session.status !== \"in_progress\"` " +
        "est lue HORS transaction et deux clôtures concurrentes passent toutes les " +
        "deux. Sans la condition dans le WHERE, chaque concurrent crée sa propre " +
        "facture (Z-21).",
    ).toBe(true);
  });

  it("l'UPDATE use RETURNING et le décompte de lignes décide qui poursuit", () => {
    expect(
      /\.returning\(/.test(body),
      "L'UPDATE de réclamation de closeSession doit usar .returning() : le décompte " +
        "de lignes affectées est le mécanisme qui départage les clôtures " +
        "concurrentes (Z-21).",
    ).toBe(true);
    expect(
      /if\s*\(\s*!claimed\s*\)/.test(body),
      "Une clôture perdante (0 ligne affectée par l'UPDATE) doit sortir du callback " +
        "de transaction SANS écrire facture/séquence/audit : c'est ce qui garantit " +
        "une seule facture par séance sous concurrence (Z-21).",
    ).toBe(true);
  });

  it("contrôle : closeSession est bien lu et analysé", () => {
    expect(body, "extraction vide ou tronquée : masqueur/extracteur cassé").toContain(
      "Ajoutez au moins un acte",
    );
  });
});
