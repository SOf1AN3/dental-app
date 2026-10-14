/**
 * Tests de RÉGRESSION SÉCURITÉ — garde-fous d'isolation multi-tenant.
 *
 * Ce fichier ne teste PAS l'exécution (aucune base, aucun mock) : il relit les
 * sources des garde-fous et vérifie leur structure. Deux failles P0 ont été
 * corrigées et rien ne les protégeait jusqu'ici :
 *
 * 1. `guards.ts` ne doit JAMAIS porter la directive `"use server"` : toute
 *    fonction exportée d'un tel module devient une Server Action publique
 *    (ancien bug de `requireActivePatient` → IDOR sans authentification).
 *    `requireActivePatient` a été SUPPRIMée : son retour = réouverture du P0.
 *
 * 2. L'acceptation d'invitation (`clinicMemberships.joinedAt` non nul) est
 *    exigée par 6 points de contrôle d'accès (faille SEC-B02 : une invitation
 *    jamais acceptée ouvrirait le dossier médical complet).
 *
 * Chaque échec indique explicitement quoi réparer. Les auto-tests du « détecteur »
 * (bloc « auto-test » ci-dessous) garantissent que le détecteur de directive
 * distingue bien une directive réelle d'une occurrence dans un commentaire —
 * sans eux, un faux positif ferait désactiver cette protection par le prochain
 * développeur.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Lecture des sources (tests de structure : chemins dérivés de l'emplacement
// de ce module, jamais du cwd)
// ---------------------------------------------------------------------------

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SRC_DIR = join(PROJECT_ROOT, "src");
const GUARDS_FILE = "src/lib/guards.ts";
const PATIENT_ACTIONS_FILE = "src/lib/actions/patient.ts";

const fileCache = new Map<string, string>();

function readProjectFile(relativePath: string): string {
  const cached = fileCache.get(relativePath);
  if (cached !== undefined) return cached;
  const content = readFileSync(join(PROJECT_ROOT, relativePath), "utf8");
  fileCache.set(relativePath, content);
  return content;
}

// ---------------------------------------------------------------------------
// Masquage commentaires / chaînes — préserve la LONGUEUR du source
// (chaque caractère masqué devient une espace, retours à la ligne conservés) :
// les indexes restent donc valables quel que soit le masque choisi.
//
// - maskSource(s, { blankStrings: false })  → code + chaînes intacts, commentaires
//   effacés : pour détecter une directive `"use server"` qui EST une chaîne.
// - maskSource(s, { blankStrings: true })   → commentaires ET contenus de
//   chaînes effacés : pour chercher un identifiant sans se tromper avec
//   « ... dans un commentaire » ou avec nos propres chaînes de test.
// ---------------------------------------------------------------------------

function blankKeepNewlines(text: string): string {
  return text.replace(/[^\n]/g, " ");
}

function maskSource(source: string, options: { blankStrings: boolean }): string {
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source.charAt(i);
    const c2 = source.charAt(i + 1);

    // Commentaire de ligne : effacé jusqu'au retour à la ligne inclus.
    if (c === "/" && c2 === "/") {
      let j = i;
      while (j < n && source.charAt(j) !== "\n") j++;
      out += blankKeepNewlines(source.slice(i, j));
      i = j;
      continue;
    }

    // Commentaire de bloc.
    if (c === "/" && c2 === "*") {
      let j = i + 2;
      while (j < n && !(source.charAt(j) === "*" && source.charAt(j + 1) === "/")) j++;
      j = Math.min(n, j + 2);
      out += blankKeepNewlines(source.slice(i, j));
      i = j;
      continue;
    }

    // Littéral de chaîne ou template (les guillemets sont conservés, le
    // contenu est soit conservé soit effacé selon l'option).
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
      const inner = source.slice(i + 1, hasClosing ? j : n);
      const end = hasClosing ? j + 1 : n;
      out += options.blankStrings
        ? quote + blankKeepNewlines(inner) + (hasClosing ? quote : "")
        : source.slice(i, end);
      i = end;
      continue;
    }

    out += c;
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Détecteur de directive "use server" (P0)
//
// Une directive n'est active qu'en POSITION D'INSTRUCTION :
//   - en tête de module (prologue)  → `"use server";` premier jalon du fichier ;
//   - en tête de corps de fonction  → `export async function f() { "use server"; ... }`
//     (deuxième cas actif sous Next.js : le corps entier devient Server Action).
// Une occurrence dans un commentaire, une comparaison (`x === "use server"`),
// une clé d'objet (`{ "use server": ... }`) ou un import (`from "use server"`)
// ne sont PAS des directives et ne doivent jamais faire échouer le test.
// ---------------------------------------------------------------------------

function lastNonWsChar(text: string, end: number): string | null {
  for (let i = end - 1; i >= 0; i--) {
    const ch = text.charAt(i);
    if (!/\s/.test(ch)) return ch;
  }
  return null;
}

function nextNonWsChar(text: string, start: number): string | null {
  for (let i = start; i < text.length; i++) {
    const ch = text.charAt(i);
    if (!/\s/.test(ch)) return ch;
  }
  return null;
}

function findUseServerDirectives(code: string): string[] {
  const hits: string[] = [];
  const directive = /["']use server["']/g;
  let match: RegExpExecArray | null;
  while ((match = directive.exec(code)) !== null) {
    const before = lastNonWsChar(code, match.index);
    const after = nextNonWsChar(code, match.index + match[0].length);
    const inStatementPosition =
      before === null /* début de module */ || before === ";" || before === "{";
    const isObjectKey = after === ":"; // { "use server": ... } n'est pas une directive
    if (inStatementPosition && !isObjectKey) {
      hits.push(match[0]);
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Extraction du corps d'une fonction (corps délimité par accolades équilibrées)
//
// Les accolades des commentaires et des chaînes sont neutralisées par le
// masque ; la liste de paramètres est sautée par appariement de parenthèses
// (elle peut contenir des accolades de types : `prevState: { error?: ... }`) ;
// le type de retour est traversé en suivant la profondeur des chevrons
// (`Promise<{ success: boolean }> {` : la vraie accolade de corps est HORS `<>`).
// ---------------------------------------------------------------------------

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findFunctionBody(source: string, name: string): string | null {
  const noComments = maskSource(source, { blankStrings: false });
  const masked = maskSource(source, { blankStrings: true });
  const escaped = escapeRegExp(name);
  const declaration = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${escaped}\\b`);
  const constBinding = new RegExp(`(?:export\\s+)?const\\s+${escaped}\\s*[:=]`);

  const declMatch = declaration.exec(masked);
  let bodyStart: number;
  if (declMatch !== null) {
    const paramsOpen = masked.indexOf("(", declMatch.index);
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
    // Traverser le type de retour éventuel en suivant la profondeur des `<>`.
    let angles = 0;
    bodyStart = -1;
    for (let i = paramsClose + 1; i < masked.length; i++) {
      const ch = masked.charAt(i);
      if (ch === "{" && angles === 0) {
        bodyStart = i;
        break;
      }
      if (ch === "=" && masked.charAt(i + 1) === ">") {
        i++; // ignorer `=>` (type de fonction)
        continue;
      }
      if (ch === "<") angles++;
      else if (ch === ">") angles--;
    }
  } else {
    const constMatch = constBinding.exec(masked);
    if (constMatch === null) return null;
    bodyStart = masked.indexOf("{", constMatch.index);
  }
  if (bodyStart === -1) return null;

  let braces = 0;
  for (let i = bodyStart; i < masked.length; i++) {
    const ch = masked.charAt(i);
    if (ch === "{") braces++;
    else if (ch === "}") {
      braces--;
      if (braces === 0) {
        return noComments.slice(bodyStart, i + 1);
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Listing récursif de src/**\/*.{ts,tsx} (hors dossiers exclus)
// ---------------------------------------------------------------------------

const EXCLUDED_DIRS = new Set(["node_modules", ".next", ".git", "coverage", "dist"]);

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      files.push(...listSourceFiles(join(dir, entry.name)));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      files.push(join(dir, entry.name));
    }
  }
  return files;
}

// ===========================================================================
// 1. guards.ts ne porte JAMAIS la directive "use server" (P0 IDOR)
// ===========================================================================

describe('guards.ts — la directive "use server" est interdite (P0)', () => {
  it("auto-test : le détecteur repère la directive réelle et ignore commentaires et expressions", () => {
    // Si ces auto-tests échouent, le détecteur est cassé : le réparer AVANT de
    // conclure quoi que ce soit sur guards.ts.
    const keep = (source: string): string => maskSource(source, { blankStrings: false });

    expect(
      findUseServerDirectives(keep('"use server";\nexport const x = 1;')),
      "directive réelle en tête de module non détectée : détecteur cassé",
    ).toHaveLength(1);
    expect(
      findUseServerDirectives(keep('/* doc */\n"use server";\nexport const x = 1;')),
      "directive après commentaire non détectée : détecteur cassé",
    ).toHaveLength(1);
    expect(
      findUseServerDirectives(keep('export async function f() { "use server"; }')),
      "directive en tête de corps de fonction non détectée : détecteur cassé",
    ).toHaveLength(1);
    expect(
      findUseServerDirectives(keep('/* ⚠️ INTERDIT : "use server" */\nexport const x = 1;')),
      "faux positif sur un commentaire bloqué : le test crierait à tort",
    ).toEqual([]);
    expect(
      findUseServerDirectives(keep('// "use server"\nexport const x = 1;')),
      "faux positif sur un commentaire de ligne : le test crierait à tort",
    ).toEqual([]);
    expect(
      findUseServerDirectives(keep('const d = "use server";')),
      "faux positif sur une affectation de chaîne : le test crierait à tort",
    ).toEqual([]);
    expect(
      findUseServerDirectives(keep('const o = { "use server": true };')),
      "faux positif sur une clé d'objet : le test crierait à tort",
    ).toEqual([]);
    expect(
      findUseServerDirectives(keep('import x from "use server";')),
      "faux positif sur un import : le test crierait à tort",
    ).toEqual([]);
  });

  it("auto-test : le masqueur ne confond pas un « // » dans une chaîne avec un commentaire", () => {
    const masked = maskSource(
      "const url = 'https://exemple.dz'; // \"use server\"",
      { blankStrings: false },
    );
    expect(masked, "le contenu d'une chaîne ne doit pas être traité comme un commentaire").toContain(
      "https://exemple.dz",
    );
    expect(masked, "le commentaire de fin de ligne doit être effacé").not.toContain("use server");
  });

  it('guards.ts ne contient aucune directive "use server" en position d\'instruction', () => {
    const code = readProjectFile(GUARDS_FILE);
    const directives = findUseServerDirectives(maskSource(code, { blankStrings: false }));
    expect(
      directives,
      'guards.ts ne doit porter AUCUNE directive "use server" : toute fonction exportée deviendrait ' +
        "une Server Action publique, invoquable sans authentification (ancien P0 IDOR de " +
        "requireActivePatient). Retirer la directive ; les simples mentions dans des commentaires " +
        "sont autorisées.",
    ).toEqual([]);
  });

  it("contrôle : guards.ts est bien lu et analysé (masquage partiel, jamais total)", () => {
    const masked = maskSource(readProjectFile(GUARDS_FILE), { blankStrings: false });
    expect(
      masked,
      "le fichier guards.ts semble illisible/masqué en entier : le test de directive perdrait tout " +
        "sens (masqueur cassé ?)",
    ).toContain("export async function requireOwnedPatient");
  });
});

// ===========================================================================
// 2. requireActivePatient est bannie de tout src/ (P0 supprimé)
// ===========================================================================

describe("requireActivePatient — la fonction P0 supprimée ne doit pas réapparaître", () => {
  it("aucun fichier de src/ ne contient l'identifiant requireActivePatient en code", () => {
    const banned = "requireActivePatient";
    const offenders: string[] = [];
    for (const absolutePath of listSourceFiles(SRC_DIR)) {
      // Chaînes et commentaires neutralisés : seules les occurrences en code
      // (déclaration, appel, référence) comptent — et nos propres chaînes de
      // test ne peuvent donc pas se détecter elles-mêmes.
      const masked = maskSource(readFileSync(absolutePath, "utf8"), { blankStrings: true });
      const index = masked.indexOf(banned);
      if (index !== -1) {
        const line = masked.slice(0, index).split("\n").length;
        const relativePath = relative(PROJECT_ROOT, absolutePath).split("\\").join("/");
        offenders.push(`${relativePath}:${line}`);
      }
    }
    expect(
      offenders,
      "requireActivePatient était exportée depuis un module « use server » : IDOR sans " +
        "authentification (P0). Sa réapparition en code dans src/ rouvre la faille. Remplacer " +
        "son usage par requireOwnedPatient / requirePatientOwnership (guards.ts). Occurrences :",
    ).toEqual([]);
  });
});

// ===========================================================================
// 3. Invitation jamais acceptée = aucun accès — filtre joinedAt (SEC-B02)
// ===========================================================================

describe("SEC-B02 — les 6 points d'accès exigent une invitation acceptée (joinedAt)", () => {
  const JOINED_AT_FILTER = /isNotNull\s*\(\s*clinicMemberships\.joinedAt\s*\)/;

  const CHECKPOINTS: ReadonlyArray<{ file: string; fn: string }> = [
    { file: "src/lib/auth-utils.ts", fn: "getUserMemberships" },
    { file: "src/lib/auth-utils.ts", fn: "requireClinicAccessOrThrow" },
    { file: "src/lib/auth-utils.ts", fn: "getCurrentRole" },
    { file: "src/lib/multi-tenant.ts", fn: "requireClinicAccess" },
    { file: "src/lib/actions/clinic.ts", fn: "switchClinic" },
    { file: "proxy.ts", fn: "isValidActiveClinic" },
  ];

  it("chaque point de contrôle refuse une invitation jamais acceptée (joinedAt non nul)", () => {
    const violations: string[] = [];
    for (const checkpoint of CHECKPOINTS) {
      const body = findFunctionBody(readProjectFile(checkpoint.file), checkpoint.fn);
      if (body === null) {
        violations.push(
          `${checkpoint.file} → ${checkpoint.fn}() : fonction introuvable ` +
            "(renommée ?). Mettre à jour ce test OU rétablir la fonction — sans elle, " +
            "le contrôle d'accès SEC-B02 disparaît en silence.",
        );
      } else if (!JOINED_AT_FILTER.test(body)) {
        violations.push(
          `${checkpoint.file} → ${checkpoint.fn}() : filtre ` +
            "isNotNull(clinicMemberships.joinedAt) manquant.",
        );
      }
    }
    expect(
      violations,
      "SEC-B02 (P0) : sans le filtre joinedAt, une invitation jamais acceptée donne un accès " +
        "complet au dossier médical. Rétablir isNotNull(clinicMemberships.joinedAt) dans la " +
        "requête de chaque point listé ci-dessous :",
    ).toEqual([]);
  });
});

// ===========================================================================
// 4. Messages d'erreur : chaînes comparées par égalité guards ↔ patient.ts
// ===========================================================================

describe("Messages patient — cohérence guards.ts ↔ actions/patient.ts", () => {
  /** Extrait le corps d'une fonction ; échoue explicitement si absente. */
  function bodyOf(file: string, fn: string): string {
    const body = findFunctionBody(readProjectFile(file), fn);
    if (body === null) {
      throw new Error(
        `${file} → ${fn}() introuvable : le test de cohérence de message ne peut pas s'appliquer. ` +
          "Rétablir la fonction ou mettre à jour ce test.",
      );
    }
    return body;
  }

  it("requireOwnedPatient lève exactement « Patient introuvable ou archivé »", () => {
    const body = bodyOf(GUARDS_FILE, "requireOwnedPatient");
    expect(
      /throw\s+new\s+Error\s*\(\s*"Patient introuvable ou archivé"\s*\)/.test(body),
      'guards.ts → requireOwnedPatient() doit lever new Error("Patient introuvable ou archivé") : ' +
        "updatePatient compare ce message par égalité de chaîne ; si le throw change sans " +
        "patient.ts, le catch avalerait l'erreur et afficherait un diagnostic trompeur.",
    ).toBe(true);
  });

  it("requirePatientOwnership lève exactement « Patient introuvable »", () => {
    const body = bodyOf(GUARDS_FILE, "requirePatientOwnership");
    expect(
      /throw\s+new\s+Error\s*\(\s*"Patient introuvable"\s*\)/.test(body),
      'guards.ts → requirePatientOwnership() doit lever new Error("Patient introuvable") (les ' +
        "guillemets fermants excluent « Patient introuvable ou archivé ») : deletePatient et " +
        "restorePatient comparent ce message par égalité de chaîne.",
    ).toBe(true);
  });

  it("updatePatient compare le message exact de requireOwnedPatient", () => {
    const body = bodyOf(PATIENT_ACTIONS_FILE, "updatePatient");
    expect(
      /e\.message\s*===\s*"Patient introuvable ou archivé"/.test(body),
      'patient.ts → updatePatient() doit comparer e.message === "Patient introuvable ou archivé" ' +
        "(message de requireOwnedPatient) : sans cette égalité exacte, le catch renverrait le " +
        "diagnostic générique « Erreur lors de la mise à jour » et masquerait un accès refusé.",
    ).toBe(true);
  });

  it("deletePatient compare le message exact de requirePatientOwnership", () => {
    const body = bodyOf(PATIENT_ACTIONS_FILE, "deletePatient");
    expect(
      /e\.message\s*===\s*"Patient introuvable"/.test(body),
      'patient.ts → deletePatient() doit comparer e.message === "Patient introuvable" (message ' +
        "exact de requirePatientOwnership) : sinon le catch avalerait l'erreur d'accès.",
    ).toBe(true);
  });

  it("restorePatient compare le message exact de requirePatientOwnership", () => {
    const body = bodyOf(PATIENT_ACTIONS_FILE, "restorePatient");
    expect(
      /e\.message\s*===\s*"Patient introuvable"/.test(body),
      'patient.ts → restorePatient() doit comparer e.message === "Patient introuvable" (message ' +
        "exact de requirePatientOwnership) : sinon le catch avalerait l'erreur d'accès.",
    ).toBe(true);
  });
});

// ===========================================================================
// 5. Absence d'oracle d'énumération : un seul message par guard
// ===========================================================================

describe("guards.ts — pas d'oracle d'énumération sur l'appartenance patient", () => {
  const GUARDS: ReadonlyArray<{ fn: string; message: string }> = [
    { fn: "requireOwnedPatient", message: "Patient introuvable ou archivé" },
    { fn: "requirePatientOwnership", message: "Patient introuvable" },
  ];

  it("chaque guard n'a qu'un SEUL throw : patient inexistant et patient d'une autre clinique partagent le même message", () => {
    for (const guard of GUARDS) {
      const body = findFunctionBody(readProjectFile(GUARDS_FILE), guard.fn);
      if (body === null) {
        throw new Error(
          `${GUARDS_FILE} → ${guard.fn}() introuvable : rétablir le guard ou mettre à jour ce test.`,
        );
      }
      const throwStatements = body.match(/throw\s+new\s+Error\s*\([^)]*\)/g) ?? [];
      expect(
        throwStatements.length,
        `${GUARDS_FILE} → ${guard.fn}() : exactement un seul throw attendu, message « ` +
          `${guard.message} ». Un second throw (par exemple « patient d'une autre clinique ») ` +
          "créerait un oracle d'énumération : un attaquant distinguera un ID valide d'une autre " +
          "clinique d'un ID inexistant (IDOR indirect). Rejouer les deux cas dans le même throw.",
      ).toBe(1);
    }
  });
});
