/**
 * Tests de RÉGRESSION — graphes de transitions de statut (factures, devis,
 * séances). Aucune base, aucun mock : logique pure + lecture des sources.
 *
 * `INVOICE_STATUS_TRANSITIONS` et `QUOTE_STATUS_TRANSITIONS` ne sont PAS
 * exportées (`src/lib/actions/financial.ts` est un module `"use server"` ;
 * les exporter exposerait des symboles via le protocole Server Actions).
 * On ne MODIFIE donc PAS le code pour les tester : on relit la source et on
 * parse le graphe literal. `SESSION_STATUS_TRANSITIONS` étant exportée
 * (`src/lib/session-rules.ts`, module pur), on l'importe directement.
 *
 * Invariants piégés (chaque violation échoue avec un message explicite) :
 *  - factures : `cancelled` est TERMINAL ; `paid → cancelled` est autorisée ;
 *    `paid → draft` est REFUSÉE ; `draft → overdue` est refusée ;
 *  - devis : `accepted` est TERMINAL ; `rejected | expired → draft` sont les
 *    seules reprises ; `rejected | expired → accepted` sont refusées ;
 *  - `recordPayment` ne peut FORCER aucun statut : le statut facture vient
 *    de `recalcInvoiceStatus()` (paiements réels), le statut séance passe par
 *    `isSessionStatusTransitionAllowed`, et `paymentSchema` n'accepte aucun
 *    champ `status` ;
 *  - propriété pure : pour tout statut que `recordPayment` peut rencontrer
 *    (hors `paid`/`cancelled`, exclus par les verrous sous `FOR UPDATE`),
 *    `recalcInvoiceStatus` ne produit JAMAIS une arête absente du graphe.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { recalcInvoiceStatus, type InvoiceStatus } from "./billing-math";
import {
  isSessionStatusTransitionAllowed,
  SESSION_STATUS_TRANSITIONS,
} from "./session-rules";

// ---------------------------------------------------------------------------
// Lecture des sources — chemins dérivés de l'emplacement de ce module, jamais
// du cwd (convention multi-tenant.guard.test.ts).
// ---------------------------------------------------------------------------

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FINANCIAL_FILE = "src/lib/actions/financial.ts";

const financialSource = readFileSync(join(PROJECT_ROOT, FINANCIAL_FILE), "utf8");

// ---------------------------------------------------------------------------
// Masquage des commentaires (chaînes INTACTES : les motifs cherchés contiennent
// des chaînes comme `.for("update")`). Un motif présent uniquement dans un
// commentaire ne doit jamais satisfaire un test.
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

const maskedFinancial = maskComments(financialSource);

// ---------------------------------------------------------------------------
// Extraction du graphe depuis la source : `const NAME: Record<…> = { … }`.
// Le corps de l'objet ne contient AUCUNE accolade imbriquée (uniquement des
// tableaux de chaînes), donc la première `}` après l'ouverture clôt le
// literal. Toute dérive de forme (constante renommée, littéral réorganisé)
// fait échouer le test avec un message explicite — jamais un faux vert.
// ---------------------------------------------------------------------------

function parseTransitionGraph(source: string, constName: string): Record<string, string[]> {
  const decl = new RegExp(`const\\s+${constName}\\s*:[^=]*=\\s*\\{`).exec(source);
  if (decl === null) {
    throw new Error(
      `const ${constName} introuvable dans ${FINANCIAL_FILE} : le graphe a été ` +
        "renommé/déplacé/supprimé. Mettre à jour ce test OU rétablir la constante — " +
        "sans elle, aucune transition de statut n'est validée.",
    );
  }
  const open = decl.index + decl[0].length - 1;
  const close = source.indexOf("}", open);
  if (close === -1) {
    throw new Error(`Literal de ${constName} non terminé (accolade fermante introuvable).`);
  }

  const graph: Record<string, string[]> = {};
  const entry = /([A-Za-z_$][\w$]*)\s*:\s*\[([^\]]*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = entry.exec(source.slice(open + 1, close))) !== null) {
    const values: string[] = [];
    const str = /"([^"]*)"|'([^']*)'/g;
    let s: RegExpExecArray | null;
    while ((s = str.exec(m[2])) !== null) {
      values.push(s[1] ?? s[2] ?? "");
    }
    graph[m[1]] = values;
  }
  if (Object.keys(graph).length === 0) {
    throw new Error(`Aucune entrée parsée dans ${constName} : masqueur/parseur cassé.`);
  }
  return graph;
}

/** Miroir exact de la sémantique de production : `(graph[from] ?? []).includes(to)`. */
function isEdgeAllowed(graph: Record<string, string[]>, from: string, to: string): boolean {
  return (graph[from] ?? []).includes(to);
}

// Graphes de référence (contrat attendu, écrit à la main depuis les specs
// Z-31/Z-32 — ce sont eux qui font foi, pas la source).
const EXPECTED_INVOICE_GRAPH: Record<string, string[]> = {
  draft: ["sent", "partially_paid", "paid", "cancelled"],
  sent: ["draft", "partially_paid", "paid", "overdue", "cancelled"],
  partially_paid: ["sent", "paid", "overdue", "cancelled"],
  overdue: ["sent", "partially_paid", "paid", "cancelled"],
  paid: ["cancelled"],
  cancelled: [],
};

const EXPECTED_QUOTE_GRAPH: Record<string, string[]> = {
  draft: ["sent", "accepted", "rejected", "expired"],
  sent: ["draft", "accepted", "rejected", "expired"],
  accepted: [],
  rejected: ["draft"],
  expired: ["draft"],
};

// ---------------------------------------------------------------------------
// Auto-tests du parseur — SANS eux, un parseur cassé rejetterait à tort ou
// (pire) accepterait un graphe vide : le suite ci-dessous perdrait tout sens.
// ---------------------------------------------------------------------------

describe("auto-tests — parseur de graphe et masqueur", () => {
  it("parse un literal simple y compris avec une entrée commentée (ignorée)", () => {
    const sample =
      "const SAMPLE: Record<string, readonly string[]> = {\n" +
      '  a: ["b", "c"],\n' +
      "  // ghost: [\"x\"],\n" +
      "  d: [],\n" +
      "};\n";
    expect(parseTransitionGraph(maskComments(sample), "SAMPLE")).toEqual({
      a: ["b", "c"],
      d: [],
    });
  });

  it("échoue explicitement si la constante est absente (jamais un graphe vide)", () => {
    expect(() => parseTransitionGraph(maskComments("const x = 1;"), "MISSING")).toThrow(
      /MISSING/,
    );
  });

  it("le masqueur efface les commentaires mais préserve les chaînes", () => {
    const masked = maskComments(
      'const u = "https://exemple.dz"; // .for("update")\nq.for("update");',
    );
    expect(masked, "le contenu d'une chaîne ne doit pas être traité comme un commentaire").toContain(
      "https://exemple.dz",
    );
    expect(masked, "le motif réel en code doit survivre au masquage").toContain('.for("update")');
    expect(
      maskComments('function f() {\n  // .for("update")\n}'),
      "un motif mentionné uniquement en commentaire doit être effacé",
    ).not.toContain('.for("update")');
  });
});

// ===========================================================================
// 1. Graphe FACTURES — contrat exact + arêtes nommées
// ===========================================================================

describe("INVOICE_STATUS_TRANSITIONS (Z-31/Z-32)", () => {
  const graph = parseTransitionGraph(maskedFinancial, "INVOICE_STATUS_TRANSITIONS");

  it("correspond exactement au graphe contractuel", () => {
    expect(graph).toEqual(EXPECTED_INVOICE_GRAPH);
  });

  it("cancelled est terminal : AUCUNE sortie, y compris vers paid", () => {
    expect(graph["cancelled"]).toEqual([]);
    for (const to of Object.keys(EXPECTED_INVOICE_GRAPH)) {
      expect(
        isEdgeAllowed(graph, "cancelled", to),
        `cancelled → ${to} doit être refusé : une facture annulée est un document ` +
          "comptable neutralisé, toute reprise passe par une NOUVELLE facture.",
      ).toBe(false);
    }
  });

  it("paid → cancelled est autorisée (annulation d'une facture acquittée)", () => {
    expect(isEdgeAllowed(graph, "paid", "cancelled")).toBe(true);
  });

  it("paid → draft est REFUSÉE (un numéro émis ne se réattribue pas)", () => {
    expect(
      isEdgeAllowed(graph, "paid", "draft"),
      "paid → draft reouvrait la voie à la réémission d'un numéro déjà consommé.",
    ).toBe(false);
  });

  it("paid → sent / partially_paid / overdue sont refusées (pas de régression d'encours)", () => {
    expect(isEdgeAllowed(graph, "paid", "sent")).toBe(false);
    expect(isEdgeAllowed(graph, "paid", "partially_paid")).toBe(false);
    expect(isEdgeAllowed(graph, "paid", "overdue")).toBe(false);
  });

  it("draft → overdue est refusée (une facture non émise n'a pas d'échéance)", () => {
    expect(isEdgeAllowed(graph, "draft", "overdue")).toBe(false);
  });

  it("un statut inconnu n'ouvre aucune transition", () => {
    expect(isEdgeAllowed(graph, "bogus", "paid")).toBe(false);
    expect(isEdgeAllowed(graph, "draft", "bogus")).toBe(false);
  });
});

// ===========================================================================
// 2. Graphe DEVIS — contrat exact + arêtes nommées
// ===========================================================================

describe("QUOTE_STATUS_TRANSITIONS (Z-31)", () => {
  const graph = parseTransitionGraph(maskedFinancial, "QUOTE_STATUS_TRANSITIONS");

  it("correspond exactement au graphe contractuel", () => {
    expect(graph).toEqual(EXPECTED_QUOTE_GRAPH);
  });

  it("accepted est TERMINAL : aucune sortie, y compris vers rejected", () => {
    expect(graph["accepted"]).toEqual([]);
    for (const to of Object.keys(EXPECTED_QUOTE_GRAPH)) {
      expect(
        isEdgeAllowed(graph, "accepted", to),
        `accepted → ${to} créerait des factures issues d'un devis officiellement ` +
          "non accepté (accepted est l'entrée unique de convertQuoteToInvoice).",
      ).toBe(false);
    }
  });

  it("rejected → accepted et expired → accepted sont REFUSÉES", () => {
    expect(isEdgeAllowed(graph, "rejected", "accepted")).toBe(false);
    expect(isEdgeAllowed(graph, "expired", "accepted")).toBe(false);
  });

  it("rejected → draft et expired → draft sont les SEULES reprises", () => {
    expect(isEdgeAllowed(graph, "rejected", "draft")).toBe(true);
    expect(isEdgeAllowed(graph, "expired", "draft")).toBe(true);
    expect(isEdgeAllowed(graph, "rejected", "expired")).toBe(false);
    expect(isEdgeAllowed(graph, "expired", "rejected")).toBe(false);
    expect(isEdgeAllowed(graph, "rejected", "sent")).toBe(false);
  });

  it("draft → accepted est autorisée (acceptation orale à tout stade)", () => {
    expect(isEdgeAllowed(graph, "draft", "accepted")).toBe(true);
    expect(isEdgeAllowed(graph, "sent", "accepted")).toBe(true);
  });

  it("un statut inconnu n'ouvre aucune transition", () => {
    expect(isEdgeAllowed(graph, "bogus", "accepted")).toBe(false);
  });
});

// ===========================================================================
// 3. recordPayment ne peut FORCER aucun statut hors graphe
// ===========================================================================

/** Extrait la région masquée d'une fonction : déclaration courante → fonction suivante. */
function extractFunctionRegion(source: string, fnName: string): string {
  const decl = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${fnName}\\s*\\(`).exec(source);
  if (decl === null) {
    throw new Error(
      `function ${fnName} introuvable dans ${FINANCIAL_FILE} : renommée ? Mettre à jour ` +
        "ce test — sans la fonction, le contrôle correspondant n'est plus vérifié.",
    );
  }
  const start = decl.index;
  const after = source.slice(start + decl[0].length);
  const next = /(?:export\s+)?(?:async\s+)?function\s+[A-Za-z_$][\w$]*/.exec(after);
  const end = next === null ? source.length : start + decl[0].length + next.index;
  return source.slice(start, end);
}

describe("recordPayment — le statut ne peut jamais être forcé hors graphe", () => {
  const region = extractFunctionRegion(maskedFinancial, "recordPayment");

  it("contrôle : la région de recordPayment est bien extraite", () => {
    expect(region, "extraction vide ou tronquée : masqueur/extracteur cassé").toContain(
      "Patient introuvable",
    );
  });

  it("le statut facture vient de recalcInvoiceStatus() (paiements réels, jamais du formulaire)", () => {
    expect(
      region,
      "recordPayment doit recalculer le statut via recalcInvoiceStatus() : toute écriture " +
        "directe d'un statut depuis les arguments client forcerait un état hors graphe " +
        "(ex. paid → draft).",
    ).toContain("recalcInvoiceStatus(");
  });

  it("le statut séance est validé par isSessionStatusTransitionAllowed avant écriture", () => {
    expect(
      /isSessionStatusTransitionAllowed\(\s*sessionRow\.status\s*,\s*"paid"\s*\)/.test(region),
      "recordPayment doit valider completed|invoiced → paid via SESSION_STATUS_TRANSITIONS " +
        "avant d'écrire le statut de la séance (Z-29).",
    ).toBe(true);
  });

  it("paymentSchema n'accepte AUCUN champ « status »", () => {
    const schema = /const\s+paymentSchema\s*=\s*z\.object\(\{([\s\S]*?)\}\)/.exec(maskedFinancial);
    if (schema === null) {
      throw new Error("paymentSchema introuvable : déplacé/renommé ? Mettre à jour ce test.");
    }
    expect(
      /\bstatus\b/.test(schema[1]),
      "paymentSchema ne doit contenir AUCUN champ « status » : le statut d'une facture " +
        "se déduit des paiements encaissés, il n'est jamais un argument du formulaire.",
    ).toBe(false);
  });

  it("les verrous sous FOR UPDATE re-lisent cancelled/paid AVANT tout recalcul", () => {
    // Précondition de la propriété pure ci-dessous : sans ces re-vérifications,
    // un statut `paid` (transition paid → partially_paid ILLÉGALE) ou
    // `cancelled` pourrait atteindre recalcInvoiceStatus.
    expect(region, "re-vérification sous verrou de la facture ANNULÉE manquante").toContain(
      'lockedInvoice.status === "cancelled"',
    );
    expect(region, "re-vérification sous verrou de la facture DÉJÀ PAYÉE manquante").toContain(
      'lockedInvoice.status === "paid"',
    );
  });

  it("propriété : recalcInvoiceStatus ne sort JAMAIS du graphe pour un statut atteignable", () => {
    const graph = parseTransitionGraph(maskedFinancial, "INVOICE_STATUS_TRANSITIONS");
    // Statuts que recordPayment peut rencontrer APRÈS ses verrous : `paid` et
    // `cancelled` sont exclus par les re-vérifications ci-dessus (une facture
    // paid ne reçoit plus aucun encaissement — cf. test précédent).
    const reachable: readonly InvoiceStatus[] = ["draft", "sent", "partially_paid", "overdue"];
    for (const from of reachable) {
      for (const total of [0, 100]) {
        for (const paid of [0, 0.01, 50, 100, 150]) {
          const next = recalcInvoiceStatus(from, total, paid);
          const legal = next === from || isEdgeAllowed(graph, from, next);
          expect(
            legal,
            `recalcInvoiceStatus("${from}", ${total}, ${paid}) = "${next}" : arête absente ` +
              `du graphe INVOICE_STATUS_TRANSITIONS (${from} → ${next}). ` +
              "Le recalcul des statuts après encaissement doit rester dans le graphe.",
          ).toBe(true);
        }
      }
    }
  });
});

// ===========================================================================
// 4. Les actions manuelles passent PAR le graphe (et ne le contournent pas)
// ===========================================================================

describe("updateInvoiceStatus / updateQuoteStatus — validation via le graphe", () => {
  it("updateInvoiceStatus consulte isInvoiceStatusTransitionAllowed", () => {
    const region = extractFunctionRegion(maskedFinancial, "updateInvoiceStatus");
    expect(region, "contrôle : région updateInvoiceStatus non extraite").toContain(
      "Facture introuvable",
    );
    expect(
      region,
      "updateInvoiceStatus doit valider chaque changement via " +
        "isInvoiceStatusTransitionAllowed (graphe INVOICE_STATUS_TRANSITIONS) : sans ce " +
        "contrôle, cancelled → paid ou paid → draft redeviennent possibles.",
    ).toContain("isInvoiceStatusTransitionAllowed(");
  });

  it("updateQuoteStatus consulte isQuoteStatusTransitionAllowed", () => {
    const region = extractFunctionRegion(maskedFinancial, "updateQuoteStatus");
    expect(region, "contrôle : région updateQuoteStatus non extraite").toContain("Devis introuvable");
    expect(
      region,
      "updateQuoteStatus doit valider chaque changement via isQuoteStatusTransitionAllowed " +
        "(graphe QUOTE_STATUS_TRANSITIONS) : sans ce contrôle, rejected → accepted " +
        "redevient possible.",
    ).toContain("isQuoteStatusTransitionAllowed(");
  });

  it("les helpers lisent bien les constantes de graphe (et pas un autre jeu de règles)", () => {
    const inv = extractFunctionRegion(maskedFinancial, "isInvoiceStatusTransitionAllowed");
    expect(
      /INVOICE_STATUS_TRANSITIONS\s*\[\s*from\s*\]/.test(inv),
      "isInvoiceStatusTransitionAllowed doit lire INVOICE_STATUS_TRANSITIONS[from].",
    ).toBe(true);
    const quo = extractFunctionRegion(maskedFinancial, "isQuoteStatusTransitionAllowed");
    expect(
      /QUOTE_STATUS_TRANSITIONS\s*\[\s*from\s*\]/.test(quo),
      "isQuoteStatusTransitionAllowed doit lire QUOTE_STATUS_TRANSITIONS[from].",
    ).toBe(true);
  });
});

// ===========================================================================
// 5. Graphe SÉANCES — matrice comportementale (constante EXPORTÉE, import direct)
// ===========================================================================

describe("SESSION_STATUS_TRANSITIONS — matrice légales/illégales", () => {
  const STATUSES = ["pending", "in_progress", "completed", "invoiced", "paid"] as const;
  const LEGAL_EDGES: ReadonlyArray<readonly [string, string]> = [
    ["pending", "in_progress"],
    ["pending", "completed"],
    ["in_progress", "completed"],
    ["completed", "invoiced"],
    ["completed", "paid"],
    ["completed", "in_progress"],
    ["invoiced", "paid"],
    ["invoiced", "in_progress"],
  ];

  it("exactement les arêtes légales passent, toutes les autres échouent (matrice 5×5)", () => {
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        const expected = LEGAL_EDGES.some(([f, t]) => f === from && t === to);
        expect(
          isSessionStatusTransitionAllowed(from, to),
          `séance ${from} → ${to} : attendu ${expected ? "AUTORISÉE" : "REFUSÉE"} ` +
            "(graphe SESSION_STATUS_TRANSITIONS Z-29).",
        ).toBe(expected);
      }
    }
  });

  it("paid est terminal : aucune transition, y compris vers in_progress", () => {
    for (const to of STATUSES) {
      expect(
        isSessionStatusTransitionAllowed("paid", to),
        `paid → ${to} doit être refusé : une séance réglée est comptablement close.`,
      ).toBe(false);
    }
  });

  it("un statut inconnu n'ouvre aucune transition", () => {
    expect(isSessionStatusTransitionAllowed("bogus", "paid")).toBe(false);
    expect(isSessionStatusTransitionAllowed("paid", "bogus")).toBe(false);
  });

  it("SESSION_STATUS_TRANSITIONS ne contient aucune arête sortante de paid", () => {
    expect(SESSION_STATUS_TRANSITIONS["paid"]).toEqual([]);
  });
});
