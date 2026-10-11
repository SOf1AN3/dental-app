/**
 * Tests de RÉGRESSION — deux protections posées pendant le projet mais non
 * figées jusqu'ici : si un futur développeur les retire, rien ne crie.
 *
 * T-8 — contrôle d'accès financier (`src/lib/actions/reports.ts`) :
 *   `getRevenueData` ET `getMonthlyTrends` doivent exiger la capacité
 *   `revenue:view_global`, SAUF pour un praticien qui lit SES PROPRES chiffres
 *   (`opts.dentistId === user.id`). Sans cette porte, un utilisateur en rôle
 *   `viewer` lit les revenus de la clinique. Le refus doit retourner des ZÉROS
 *   (contrat « defense in depth » : le gating page est le garde principal, ce
 *   contrôle le doublonne — jamais un throw).
 *
 *   ⚠️ `hasAbility(clinicId, "revenue:view_global")` apparaît dans les DEUX
 *   fonctions (et ailleurs en déclaration d'import) : chaque assertion est donc
 *   rattachée au CORPS DE FONCTION extrait de la source (jamais une recherche
 *   « n'importe où dans le fichier », qui serait un faux vert — les auto-tests
 *   du bas ci-dessous le vérifient contre des modules synthétiques).
 *
 * T-6 — détection d'allergie (`src/lib/actions/prescription.ts`) :
 *   `findAllergyAlerts` N'EST PAS EXPORTÉE (et ne doit jamais l'être : le module
 *   porte `"use server"`, tout export async y devient une Server Action publique
 *   invoquable côté client avec des `clinicId`/`patientId` arbitraires → lecture
 *   des antécédents d'une autre clinique, IDOR sur données de santé). On ne
 *   MODIFIE donc PAS le code pour la tester :
 *   - le CÂBLAGE (filtre multi-tenant, appel avant l'INSERT / la réécriture) est
 *     vérifié par lecture de source + un harnais qui capture les arguments
 *     réellement passés à `eq`/`and`/`.where()` ;
 *   - la LOGIQUE de correspondance pure est exécutée réellement : le corps
 *     EXTRAIT de la source est instancié (`new Function`) avec ses dépendances
 *     injectées et une base factice — aucune requête SQL n'est toutefois
 *     exécutée (seuls les arguments JS de la requête sont assertés) ;
 *   - les appelantes (`createPrescription` / `updatePrescription`) ne sont
 *     couvertes qu'en ORDRE D'APPEL (lecture de source), pas en exécution.
 *
 * Aucune base, aucune dépendance ajoutée. Technique de masquage/extraction
 * empruntée à `multi-tenant.guard.test.ts` et `concurrency-locks.test.ts`.
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
const REPORTS_FILE = "src/lib/actions/reports.ts";
const PRESCRIPTION_FILE = "src/lib/actions/prescription.ts";

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
// des chaînes comme `"revenue:view_global"`). Un motif mentionné UNIQUEMENT
// dans un commentaire ne doit jamais satisfaire un test — les JSDoc de
// `reports.ts` mentionnent précisément `revenue:view_global` et
// `findAllergyAlerts`, le faux vert guette.
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
// technique éprouvée de concurrency-locks.test.ts : la liste de paramètres est
// sautée par appariement de parenthèses (elle peut contenir des accolades de
// types), et le type de retour est traversé en suivant la profondeur des
// chevrons (`Promise<Array<{ a: number }>> {` : la vraie accolade de corps est
// HORS `<>`).
// ---------------------------------------------------------------------------

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findFunctionBody(source: string, name: string): string | null {
  const masked = maskComments(source);
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
      `${file} → ${fn}() introuvable : le test de protection ne peut pas s'appliquer. ` +
        "Rétablir la fonction ou mettre à jour ce test — sans elle, la protection " +
        "correspondante disparaît en silence.",
    );
  }
  return body;
}

// ---------------------------------------------------------------------------
// Auto-tests de l'extraction — SANS eux, un extracteur cassé (ou une recherche
// « n'importe où dans le fichier ») produirait des faux verts : les protections
// T-8/T-6 seraient alors créditées sans être vérifiées.
// ---------------------------------------------------------------------------

describe("auto-tests — l'extraction est rattachée au corps de fonction (anti faux-vert)", () => {
  it("un motif présent ailleurs dans le module ne satisfait PAS le test d'un autre corps", () => {
    const synthetic =
      "export async function getRevenueData() {\n" +
      '  await hasAbility(clinicId, "revenue:view_global");\n' +
      "}\n" +
      "export async function other(): Promise<void> {\n" +
      "  return;\n" +
      "}\n";
    const body = findFunctionBody(synthetic, "other");
    if (body === null) throw new Error("auto-test cassé : corps « other » non extrait");
    expect(
      body,
      "le corps de other() ne doit contenir AUCUNE occurrence de la porte posée dans " +
        "l'autre fonction du même fichier : sinon chaque test de porte serait un faux vert.",
    ).not.toMatch(/hasAbility/);
  });

  it("une mention en commentaire ne satisfait PAS le test, une chaîne réelle si", () => {
    const commented = 'async function f() {\n  // exige hasAbility(clinicId, "revenue:view_global")\n}';
    const body = findFunctionBody(commented, "f");
    if (body === null) throw new Error("auto-test cassé : corps « f » non extrait");
    expect(body, "un motif de commentaire ne doit jamais compter").not.toMatch(/hasAbility/);

    const masked = maskComments(
      'const s = "revenue:view_global"; // a supprimé hasAbility(clinicId, "revenue:view_global")',
    );
    expect(masked, "le masquage doit préserver les chaînes réelles").toContain(
      '"revenue:view_global"',
    );
    expect(masked, "le masquage doit effacer le commentaire").not.toContain("hasAbility");
  });

  it("un corps dont les params/type de retour contiennent des accolades est extrait intégralement", () => {
    const synthetic =
      "export async function g(x: { a?: string }): Promise<Array<{ b: number }>> {\n" +
      "  return [{ b: 1 }];\n" +
      "}";
    const body = findFunctionBody(synthetic, "g");
    if (body === null) throw new Error("auto-test cassé : corps « g » non extrait");
    expect(body).toContain("return [{ b: 1 }]");
  });
});

// ===========================================================================
// T-8 — getRevenueData / getMonthlyTrends exigent revenue:view_global
// ===========================================================================

/** Appel réel de la porte financière (chaînes intactes, commentaires masqués). */
const GATE_CALL =
  /await\s+(?:hasAbility|requireAbility)\(\s*clinicId\s*,\s*["']revenue:view_global["']\s*\)/;

/**
 * La porte DOIT laisser passer un seul cas : le praticien qui lit SES propres
 * chiffres (`user.id === opts.dentistId`) — tout le reste (dont la lecture
 * globale sans `opts.dentistId`) exige la capacité.
 */
const SELF_OR_GLOBAL =
  /user\??\.id\s*!==\s*opts\.dentistId\s*&&\s*!\(\s*await\s+(?:hasAbility|requireAbility)\(\s*clinicId\s*,\s*["']revenue:view_global["']\s*\)\s*\)/;

interface RevenueGateCase {
  readonly fnName: string;
  /** Marqueur PROPRE à cette fonction : prouve que son corps est bien isolé. */
  readonly ownMarker: string;
  /** Marqueur de l'AUTRE fonction : ne doit PAS figurer dans ce corps. */
  readonly foreignMarker: string;
  /** Forme du retour de refus (zéros) dans ce corps. */
  readonly zeros: RegExp;
}

const REVENUE_GATE_CASES: readonly RevenueGateCase[] = [
  {
    fnName: "getRevenueData",
    ownMarker: "totalRevenue",
    foreignMarker: "emptyMonthlyTrends",
    zeros:
      /return\s*\{\s*totalRevenue:\s*0\s*,\s*monthlyRevenue:\s*\[\s*\]\s*,\s*byMethod:\s*\[\s*\]\s*\}/,
  },
  {
    fnName: "getMonthlyTrends",
    ownMarker: "emptyMonthlyTrends",
    foreignMarker: "totalRevenue",
    zeros: /return\s+emptyMonthlyTrends\(/,
  },
];

function describeRevenueGate(revenueCase: RevenueGateCase): void {
  const { fnName, ownMarker, foreignMarker, zeros } = revenueCase;
  describe(`T-8 — ${fnName} : capacité revenue:view_global exigée (refus = zéros, jamais un throw)`, () => {
    const body = bodyOf(REPORTS_FILE, fnName);

    it("contrôle : le corps est bien isolé, complet et distinct de l'autre rapport", () => {
      expect(body, "extraction vide ou tronquée : masqueur/extracteur cassé").toContain(
        "await requireAuth()",
      );
      expect(body, `le corps de ${fnName}() doit contenir ${ownMarker}`).toContain(ownMarker);
      expect(
        body,
        `le corps de ${fnName}() ne doit PAS contenir ${foreignMarker} : les deux fonctions ` +
          "ont chacun leur porte, le test doit viser le bon corps (jamais une occurrence " +
          "prise « n'importe où dans le fichier »).",
      ).not.toContain(foreignMarker);
    });

    it("exige la capacité sur les DEUX chemins (praticien ciblé ET lecture globale)", () => {
      // Deux appels MINIMUM : un seul laisserait un chemin sans porte — un
      // `viewer` lirait alors les revenus de la clinique par l'autre branche.
      const calls = body.match(new RegExp(GATE_CALL.source, "g")) ?? [];
      expect(
        calls.length,
        `${REPORTS_FILE} → ${fnName}() : la porte revenue:view_global doit couvrir les ` +
          "DEUX chemins — (1) opts.dentistId renseigné mais différent de l'utilisateur " +
          "(praticien qui cible quelqu'un d'autre) et (2) lecture globale sans " +
          "opts.dentistId. Un seul appel laisserait l'autre chemin sans garde.",
      ).toBeGreaterThanOrEqual(2);
    });

    it("l'exception « praticien lit ses propres chiffres » est liée à opts.dentistId", () => {
      expect(
        SELF_OR_GLOBAL.test(body),
        `${REPORTS_FILE} → ${fnName}() : la SEULE dispense doit être ` +
          "user?.id !== opts.dentistId && !hasAbility(clinicId, « revenue:view_global ») — " +
          "un praticien ne lit QUE ses propres chiffres ; toute autre formulation (comparaison " +
          "inversée, dispense sur un autre champ) doit être re-validée ici.",
      ).toBe(true);
    });

    it("le contrôle est posé AVANT toute requête d'agrégation (Promise.all)", () => {
      const dataStart = body.indexOf("Promise.all");
      expect(
        dataStart,
        `Promise.all introuvable dans ${fnName}() : la fonction a été refactorisée, mettre ` +
          "à jour ce test.",
      ).toBeGreaterThan(-1);
      const gateIndex = body.slice(0, dataStart).search(GATE_CALL);
      expect(
        gateIndex,
        `${REPORTS_FILE} → ${fnName}() : la porte revenue:view_global doit être posée AVANT ` +
          "l'agrégation — interroger la base pour un refus déjà certain gaspille la ressource " +
          "et déplace le contrôle loin du point d'entrée.",
      ).toBeGreaterThan(-1);
    });

    it("chaque refus retourne des ZÉROS (payload vide), et le corps ne lève JAMAIS", () => {
      const dataStart = body.indexOf("Promise.all");
      if (dataStart === -1) {
        throw new Error(`${fnName}() : Promise.all introuvable (refactor ?) — mettre à jour ce test.`);
      }
      const region = body.slice(0, dataStart);
      const zeroReturns = region.match(new RegExp(zeros.source, "g")) ?? [];
      expect(
        zeroReturns.length,
        `${REPORTS_FILE} → ${fnName}() : chaque branche de refus doit retourner le payload ` +
          "à zéros (contrat « defense in depth » : le refus est silencieux, la page masque " +
          "le bloc). Deux refus attendus : praticien ciblé non autorisé, et lecture globale " +
          "sans capacité.",
      ).toBeGreaterThanOrEqual(2);
      expect(
        body.match(/throw\b/g) ?? [],
        `${REPORTS_FILE} → ${fnName}() : AUCUN throw dans le corps — le refus d'accès financier ` +
          "retourne des zéros, il ne doit jamais propager une erreur (le catch d'agrégation " +
          "dégrade déjà au même payload vide).",
      ).toEqual([]);
    });
  });
}

REVENUE_GATE_CASES.forEach(describeRevenueGate);

describe("T-8 — le déni de getMonthlyTrends sont bien des mois à ZÉRO (emptyMonthlyTrends)", () => {
  type MonthlyTrendEntry = { month: string; patients: number; appointments: number; revenue: number };
  type EmptyMonthlyTrends = (timeZone: string, now: Date) => MonthlyTrendEntry[];

  it("le refus de getMonthlyTrends produit des entrées [patients, appointments, revenue] à 0", () => {
    const body = bodyOf(REPORTS_FILE, "emptyMonthlyTrends");
    const emptyMonthlyTrends = instantiatePure<EmptyMonthlyTrends>(
      "emptyMonthlyTrends",
      ["lastSixMonthKeys"],
      "function emptyMonthlyTrends(timeZone, now)",
      body,
      // Source de mois FIXE : seule la structure [zéros] du payload nous intéresse.
      [(_timeZone: string, _now: Date): string[] => ["2026-05", "2026-06"]],
    );
    expect(emptyMonthlyTrends("Africa/Algiers", new Date(0))).toEqual([
      { month: "2026-05", patients: 0, appointments: 0, revenue: 0 },
      { month: "2026-06", patients: 0, appointments: 0, revenue: 0 },
    ]);
  });
});

// ===========================================================================
// T-6 — câblage de findAllergyAlerts (lecture de source)
// ===========================================================================

describe("T-6 — findAllergyAlerts n'est (et ne doit être) JAMAIS exportée", () => {
  it("la fonction existe en interne mais aucun export ne la publie", () => {
    const masked = maskComments(readProjectFile(PRESCRIPTION_FILE));
    expect(
      masked,
      "findAllergyAlerts() introuvable : déplacée/renommée ? Mettre à jour ce test — " +
        "sans elle, plus aucune alerte d'allergie n'est calculée.",
    ).toMatch(/(?:^|\n)\s*(?:async\s+)?function\s+findAllergyAlerts\b/);
    expect(
      masked,
      "prescription.ts porte « use server » : TOUT export async y devient une Server Action " +
        "publique, invoquable côté client avec des clinicId/patientId arbitraires → lecture " +
        "des antécédents d'une autre clinique (IDOR sur données de santé). Ne jamais exporter " +
        "findAllergyAlerts ; la couvrir par le harnais T-6 ci-dessous.",
    ).not.toMatch(/export\s+(?:default\s+)?(?:async\s+)?function\s+findAllergyAlerts\b/);
    expect(
      masked,
      "idem pour une ré-exportation via `export { findAllergyAlerts }`.",
    ).not.toMatch(/export\s*\{[^}]*\bfindAllergyAlerts\b/);
  });
});

describe("T-6 — createPrescription : alertes calculées AVANT l'INSERT", () => {
  const body = bodyOf(PRESCRIPTION_FILE, "createPrescription");

  it("contrôle : le corps de createPrescription est bien isolé (distinct de updatePrescription)", () => {
    expect(body, "extraction vide ou tronquée : masqueur/extracteur cassé").toContain(
      "redirect(",
    );
    expect(body, "createPrescription ne réécrit pas d'items existants").not.toContain(
      ".delete(prescriptionItems)",
    );
  });

  it("findAllergyAlerts est appelée avec la clinique de SESSION (jamais un id client)", () => {
    expect(
      body,
      "findAllergyAlerts(clinicId, …) doit recevoir la clinicId de session : un id provenant " +
        "du formulaire permettrait de sonder les antécédents d'une autre clinique.",
    ).toMatch(/await\s+findAllergyAlerts\(\s*clinicId\s*,/);
  });

  it("l'appel précède l'INSERT de l'ordonnance (alertes lues avant toute écriture)", () => {
    const callIndex = body.search(/await\s+findAllergyAlerts\(/);
    const insertIndex = body.search(/\.insert\(\s*prescriptions\s*\)/);
    expect(callIndex, "appel findAllergyAlerts introuvable dans createPrescription").toBeGreaterThan(-1);
    expect(insertIndex, ".insert(prescriptions) introuvable : refactor ? mettre à jour ce test").toBeGreaterThan(-1);
    expect(
      callIndex < insertIndex,
      "les alertes d'allergie doivent être calculées AVANT l'INSERT : le résultat est joint " +
        "aux retours de l'action (bandeau ambre) ; calculé après l'écriture, il sauterait " +
        "sur le chemin succès et sur toute écriture qui échoue.",
    ).toBe(true);
  });

  it("les alertes sont jointes au retour de l'action (warnings)", () => {
    expect(body, "sans withAllergyWarnings, le bandeau d'allergie n'atteint jamais l'UI").toContain(
      "withAllergyWarnings(",
    );
  });
});

describe("T-6 — updatePrescription : alertes recalculées AVANT la réécriture", () => {
  const body = bodyOf(PRESCRIPTION_FILE, "updatePrescription");

  it("contrôle : le corps de updatePrescription est bien isolé (distinct de createPrescription)", () => {
    expect(body, "extraction vide ou tronquée : masqueur/extracteur cassé").toContain(
      ".delete(prescriptionItems)",
    );
    expect(body, "updatePrescription ne redirige pas").not.toContain("redirect(");
  });

  it("findAllergyAlerts est appelée avec la clinique de SESSION", () => {
    expect(
      body,
      "findAllergyAlerts(clinicId, …) doit recevoir la clinicId de session (les items sont " +
        "entièrement réécrits : mêmes antécédents vérifiés qu'à la création).",
    ).toMatch(/await\s+findAllergyAlerts\(\s*clinicId\s*,/);
  });

  it("l'appel précède la transaction de réécriture (UPDATE + suppression/réinsertion des items)", () => {
    const callIndex = body.search(/await\s+findAllergyAlerts\(/);
    const transactionIndex = body.indexOf("db.transaction(");
    expect(callIndex, "appel findAllergyAlerts introuvable dans updatePrescription").toBeGreaterThan(-1);
    expect(transactionIndex, "db.transaction( introuvable : refactor ? mettre à jour ce test").toBeGreaterThan(-1);
    expect(
      callIndex < transactionIndex,
      "les alertes doivent être recalculées AVANT la transaction qui réécrit les items : " +
        "jointes au retour `success`, elles doivent refléter les items en cours de validation, " +
        "pas un état post-écriture potentiellement échoué.",
    ).toBe(true);
  });

  it("les alertes sont jointes au retour de l'action (warnings)", () => {
    expect(body, "sans withAllergyWarnings, le bandeau d'allergie n'atteint jamais l'UI").toContain(
      "withAllergyWarnings(",
    );
  });
});

describe("T-6 — getPrescription recalcule les alertes à chaque lecture (affichage persistant)", () => {
  const body = bodyOf(PRESCRIPTION_FILE, "getPrescription");

  it("la page de détails recalcule et retourne les warnings", () => {
    expect(body).toMatch(/await\s+findAllergyAlerts\(\s*clinicId\s*,/);
    expect(body, "les alertes doivent être formatées dans le retour de la lecture").toContain(
      "warnings",
    );
  });
});

// ===========================================================================
// T-6 — comportement RÉEL de findAllergyAlerts (harnais)
//
// Le module est « use server » : `findAllergyAlerts` n'est pas exportée et ne
// doit pas l'être. On exécute donc son corps EXTRAIT de la source via
// `new Function`, avec ses dépendances injectées (dont une base factice qui
// capture les arguments de eq/and/.where()). La logique de correspondance
// textuelle tourne ainsi RÉELLEMENT ; si l'extraction ou la syntaxe dérive,
// l'instanciation lève une erreur EXPLICITE (jamais un faux vert silencieux).
// ===========================================================================

type AllergyItem = { type: string; name: string };
type AllergyAlert = { condition: string; medication: string };
type FindAllergyAlerts = (
  clinicId: string,
  patientId: string,
  items: AllergyItem[],
) => Promise<AllergyAlert[]>;

/** Instancie le corps EXTRAIT d'une fonction ; SyntaxError → échec explicite. */
function instantiatePure<TResult>(
  label: string,
  parameterNames: readonly string[],
  signature: string,
  body: string,
  dependencyValues: readonly unknown[],
): TResult {
  if (parameterNames.length !== dependencyValues.length) {
    throw new Error(`harnais : noms/dépendances désalignés pour ${label}.`);
  }
  let factory: (...deps: unknown[]) => TResult;
  try {
    factory = new Function(...parameterNames, `return (${signature} ${body});`) as (
      ...deps: unknown[]
    ) => TResult;
  } catch (error) {
    throw new Error(
      `Le corps extrait de ${label} n'est pas évaluable en JS (${String(error)}). Syntaxe ` +
        "non neutralisée par le harnais (annotation TS ?) : mettre à jour ce test — sans " +
        "cela, la logique correspondante n'est plus couverte.",
    );
  }
  return factory(...dependencyValues);
}

/** Évalue une constante littérale du module (Set, regex, …) ; absence → échec explicite. */
function evalConstant<T>(source: string, name: string): T {
  const match = new RegExp(`const\\s+${name}\\s*=\\s*([^;]+);`).exec(maskComments(source));
  if (match === null) {
    throw new Error(
      `${PRESCRIPTION_FILE} → const ${name} introuvable : renommée/déplacée ? Mettre à jour ` +
        "ce test — sans elle, la détection d'allergie perd un de ses filtres.",
    );
  }
  try {
    return new Function(`return (${match[1]});`)() as T;
  } catch (error) {
    throw new Error(
      `${PRESCRIPTION_FILE} → const ${name} non évaluée (${String(error)}) : mettre à jour le harnais.`,
    );
  }
}

function instantiateNormalizeLoose(source: string): (value: string) => string {
  return instantiatePure<(value: string) => string>(
    "normalizeLoose",
    [],
    "function normalizeLoose(value)",
    bodyOfInline(source, "normalizeLoose"),
    [],
  );
}

function instantiateAllergenTokens(
  source: string,
  normalizeLoose: (value: string) => string,
): (condition: string) => string[] {
  const pattern = evalConstant<RegExp>(source, "ALLERGY_KEYWORD_PATTERN");
  const keywords = evalConstant<Set<string>>(source, "ALLERGY_KEYWORDS");
  const stopwords = evalConstant<Set<string>>(source, "ALLERGY_STOPWORDS");
  return instantiatePure<(condition: string) => string[]>(
    "allergenTokens",
    ["ALLERGY_KEYWORD_PATTERN", "ALLERGY_STOPWORDS", "ALLERGY_KEYWORDS", "normalizeLoose"],
    "function allergenTokens(condition)",
    bodyOfInline(source, "allergenTokens"),
    [pattern, stopwords, keywords, normalizeLoose],
  );
}

/** Comme `bodyOf`, mais sur une source déjà chargée (évite une relecture). */
function bodyOfInline(source: string, fn: string): string {
  const body = findFunctionBody(source, fn);
  if (body === null) {
    throw new Error(
      `${PRESCRIPTION_FILE} → ${fn}() introuvable : le harnais T-6 ne peut pas s'appliquer.`,
    );
  }
  return body;
}

interface AllergyTableColumns {
  readonly clinicId: string;
  readonly patientId: string;
  readonly isActive: string;
  readonly condition: string;
}

interface AllergyHarness {
  readonly findAllergyAlerts: FindAllergyAlerts;
  readonly table: AllergyTableColumns;
  /** Arguments (colonne, valeur) de chaque eq() posé par la fonction testée. */
  readonly filters: Array<{ column: unknown; value: unknown }>;
  readonly fromCalls: unknown[];
  readonly whereCalls: unknown[];
  readonly selectCount: number;
}

interface EqMarker {
  readonly __eq: true;
  readonly column: unknown;
  readonly value: unknown;
}

interface AndMarker {
  readonly __and: true;
  readonly predicates: readonly unknown[];
}

function buildAllergyHarness(options: {
  readonly entries?: ReadonlyArray<{ condition: string }>;
  readonly readError?: Error;
}): AllergyHarness {
  const source = readProjectFile(PRESCRIPTION_FILE);

  // Deux annotations TS internes doivent être neutralisées pour que le corps
  // soit évaluable comme du JS ; TOUTE autre dérive de syntaxe fera échouer
  // instantiatePure avec un message explicite (jamais un passage silencieux).
  const body = bodyOfInline(source, "findAllergyAlerts")
    .replace(/const\s+alerts\s*:\s*AllergyAlert\[\]/g, "const alerts")
    .replace(/let\s+entries\s*:\s*Array<\{\s*condition:\s*string\s*\}>/g, "let entries");

  // Base factice : capture des arguments réels de la requête, pas de SQL.
  const filters: Array<{ column: unknown; value: unknown }> = [];
  const fromCalls: unknown[] = [];
  const whereCalls: unknown[] = [];
  let selectCount = 0;

  const table: AllergyTableColumns = {
    clinicId: "__medical_history_entry.clinicId",
    patientId: "__medical_history_entry.patientId",
    isActive: "__medical_history_entry.isActive",
    condition: "__medical_history_entry.condition",
  };

  const eq = (column: unknown, value: unknown): EqMarker => {
    filters.push({ column, value });
    return { __eq: true, column, value };
  };
  const and = (...predicates: unknown[]): AndMarker => ({ __and: true, predicates });
  const from = (
    tableArg: unknown,
  ): { where: (predicate: unknown) => Promise<Array<{ condition: string }>> } => {
    fromCalls.push(tableArg);
    return {
      where: (predicate: unknown): Promise<Array<{ condition: string }>> => {
        whereCalls.push(predicate);
        if (options.readError !== undefined) return Promise.reject(options.readError);
        return Promise.resolve([...(options.entries ?? [])]);
      },
    };
  };
  const db = {
    select: (_selection: unknown): { from: typeof from } => {
      selectCount += 1;
      return { from };
    },
  };

  const normalizeLoose = instantiateNormalizeLoose(source);
  const allergenTokens = instantiateAllergenTokens(source, normalizeLoose);
  const findAllergyAlerts = instantiatePure<FindAllergyAlerts>(
    "findAllergyAlerts",
    ["db", "eq", "and", "medicalHistoryEntries", "allergenTokens", "normalizeLoose"],
    "async function findAllergyAlerts(clinicId, patientId, items)",
    body,
    [db, eq, and, table, allergenTokens, normalizeLoose],
  );

  return {
    findAllergyAlerts,
    table,
    filters,
    fromCalls,
    whereCalls,
    get selectCount(): number {
      return selectCount;
    },
  };
}

describe("T-6 — comportement réel de findAllergyAlerts (corps extrait + base factice)", () => {
  it("contrôle : la fonction réelle est instanciée ; sans médicament, AUCUNE lecture de base", async () => {
    const harness = buildAllergyHarness({
      entries: [{ condition: "Allergie à l'amoxicilline" }],
    });
    expect(await harness.findAllergyAlerts("clinic-1", "patient-1", [])).toEqual([]);
    expect(
      await harness.findAllergyAlerts("clinic-1", "patient-1", [
        { type: "care", name: "Amoxicilline" },
      ]),
    ).toEqual([]);
    expect(
      await harness.findAllergyAlerts("clinic-1", "patient-1", [
        { type: "medication", name: "   " },
      ]),
    ).toEqual([]);
    expect(
      harness.selectCount,
      "aucune lecture d'antécédents ne doit partir sans médicament non vide à vérifier " +
        "(instancisation cassée ? Les tests ci-dessous perdraient tout sens).",
    ).toBe(0);
  });

  it("la lecture est filtrée par clinicId, patientId et isActive (isolation inter-clinique)", async () => {
    const harness = buildAllergyHarness({ entries: [] });
    await harness.findAllergyAlerts("clinic-1", "patient-1", [
      { type: "medication", name: "Amoxicilline" },
    ]);
    expect(harness.selectCount).toBe(1);
    expect(harness.fromCalls, "la table lue doit être medicalHistoryEntries").toEqual([
      harness.table,
    ]);
    expect(
      harness.filters,
      "findAllergyAlerts doit poser eq(medicalHistoryEntries.clinicId, clinicId), " +
        "eq(medicalHistoryEntries.patientId, patientId) ET eq(medicalHistoryEntries.isActive, true) : " +
        "sans le filtre de clinique, la fonction sonderait les antécédents de TOUS les " +
        "patients (appelée avec une clinicId de session, le risque est un recall croisé, " +
        "mais la double-clé patient/clinique est la défense en profondeur).",
    ).toEqual([
      { column: harness.table.clinicId, value: "clinic-1" },
      { column: harness.table.patientId, value: "patient-1" },
      { column: harness.table.isActive, value: true },
    ]);
    const predicate = harness.whereCalls[0];
    expect(harness.whereCalls.length).toBe(1);
    expect(
      predicate,
      "les égalités doivent être réellement transmises à .where() (via and), pas seulement " +
        "construites sans effet.",
    ).toMatchObject({ __and: true });
    expect((predicate as AndMarker).predicates).toEqual(
      harness.filters.map((filter) => ({ __eq: true, ...filter })),
    );
  });

  it("détecte une molécule nommée dans l'antécédent (accents/casse neutralisés des deux côtés)", async () => {
    const accents = buildAllergyHarness({
      entries: [{ condition: "Allergie à l'amoxicilline" }],
    });
    expect(
      await accents.findAllergyAlerts("clinic-1", "patient-1", [
        { type: "medication", name: "Amoxicilline 500 mg" },
      ]),
    ).toEqual([
      { condition: "Allergie à l'amoxicilline", medication: "Amoxicilline 500 mg" },
    ]);

    const casing = buildAllergyHarness({
      entries: [{ condition: "Allergie à la Pénicilline" }],
    });
    expect(
      await casing.findAllergyAlerts("clinic-1", "patient-1", [
        { type: "medication", name: "Pénicilline 500" },
      ]),
    ).toEqual([{ condition: "Allergie à la Pénicilline", medication: "Pénicilline 500" }]);
  });

  it("limites documentées : nom de marque non détecté ; antécédent sans mot-clé « allerg… » ignoré", async () => {
    // ⚠️ La JSDoc de findAllergyAlerts prétend que « Allergie à la pénicilline »
    // ↔ « Amoxicilline 500 mg » est détecté : c'est FAUX (la correspondance est
    // une inclusion de sous-chaîne stricte et « amoxicilline » ne contient pas
    // « penicilline »). Ce cas n'est donc pas codé en attente ; signalé au Lead.
    const brand = buildAllergyHarness({
      entries: [{ condition: "Allergie à la pénicilline" }],
    });
    expect(
      await brand.findAllergyAlerts("clinic-1", "patient-1", [
        { type: "medication", name: "Amoxil" },
      ]),
    ).toEqual([]);

    const noKeyword = buildAllergyHarness({
      entries: [{ condition: "Intolérance à la pénicilline" }],
    });
    expect(
      await noKeyword.findAllergyAlerts("clinic-1", "patient-1", [
        { type: "medication", name: "Pénicilline 500" },
      ]),
    ).toEqual([]);
  });

  it("mots-outils écartés : « Allergie connue au médicament » ne matche pas « Médicament miracle »", async () => {
    const harness = buildAllergyHarness({
      entries: [{ condition: "Allergie connue au médicament" }],
    });
    expect(
      await harness.findAllergyAlerts("clinic-1", "patient-1", [
        { type: "medication", name: "Médicament miracle" },
      ]),
    ).toEqual([]);
  });

  it("une erreur de lecture est avalée : retour [] (l'alerte n'empêche JAMAIS l'écriture)", async () => {
    const harness = buildAllergyHarness({ readError: new Error("db indisponible") });
    await expect(
      harness.findAllergyAlerts("clinic-1", "patient-1", [
        { type: "medication", name: "Amoxicilline" },
      ]),
    ).resolves.toEqual([]);
  });
});
