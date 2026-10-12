"use client";

import { useActionState, useState, useEffect, useRef } from "react";
import { updateDocumentTemplates } from "@/lib/actions/settings";
import {
  A5Prescription,
  type A5Data,
} from "@/components/clinic/a5-prescription";
import {
  A5FinancialDocument,
  type FinancialDocData,
} from "@/components/clinic/a5-financial-document";
import {
  A5_SHEET_WIDTH_PX,
  A5_SHEET_HEIGHT_PX,
} from "@/components/clinic/a5-styles";
import {
  DOCUMENT_TEMPLATES,
  BRANDING_PALETTES,
  DEFAULT_DOCUMENT_BRANDING,
  type DocumentBranding,
  type DocumentTemplateId,
} from "@/lib/document-branding";
import { docTotals, lineTotal } from "@/lib/billing-math";
import type { A5Template } from "@/lib/document-branding";

export interface A5TemplateSettingsProps {
  defaultValues: {
    name: string;
    address: string | null;
    phone: string | null;
    email: string | null;
    legalInfo: string | null;
    logoUrl: string | null;
    headerUrl: string | null;
    watermarkEnabled: boolean;
    branding: DocumentBranding;
  };
}

const HEX = /^#[0-9a-fA-F]{6}$/;

const DEMO_ITEMS = [
  { description: "Consultation", quantity: 1, unitPrice: 2000, taxRate: 0, discount: 0 },
  { description: "Détartrage complet", quantity: 1, unitPrice: 3500, taxRate: 0, discount: 0 },
  { description: "Composite 1 face (dent 16)", quantity: 1, unitPrice: 6000, taxRate: 0, discount: 0 },
];

const DEMO_RX_ITEMS: A5Data["items"] = [
  {
    type: "medication",
    name: "Amoxicilline 500 mg",
    dosage: "500 mg",
    form: "Comprimé",
    frequency: "1 cp × 3 / jour",
    duration: "7 jours",
    quantity: 21,
    instructions: "À prendre au moment des repas.",
  },
  {
    type: "medication",
    name: "Ibuprofène 400 mg",
    dosage: "400 mg",
    form: "Comprimé",
    frequency: "1 cp × 2 / jour",
    duration: "5 jours",
    quantity: 10,
    instructions: "Ne pas dépasser la dose prescrite.",
  },
];

export function A5TemplateSettings({ defaultValues }: A5TemplateSettingsProps) {
  const [state, action, pending] = useActionState(updateDocumentTemplates, undefined);

  const [template, setTemplate] = useState<DocumentTemplateId>(
    defaultValues.branding.template
  );
  const [primary, setPrimary] = useState(defaultValues.branding.primary);
  const [secondary, setSecondary] = useState(defaultValues.branding.secondary);
  const [tagline, setTagline] = useState(defaultValues.branding.tagline ?? "");
  const [footer, setFooter] = useState(defaultValues.branding.footer ?? "");
  const [watermark, setWatermark] = useState(defaultValues.watermarkEnabled);
  const [docType, setDocType] = useState<"prescription" | "invoice">("prescription");

  const previewRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  const generalError =
    state && "error" in state && state.error && "general" in state.error
      ? (state.error as Record<string, string[] | undefined>).general?.[0]
      : undefined;

  useEffect(() => {
    const el = previewRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const scale =
    containerWidth > 0 ? Math.min(1, containerWidth / A5_SHEET_WIDTH_PX) : 1;

  const templateProps: A5Template = {
    name: defaultValues.name,
    address: defaultValues.address,
    phone: defaultValues.phone,
    email: defaultValues.email,
    legalInfo: defaultValues.legalInfo,
    logoUrl: defaultValues.logoUrl,
    headerUrl: defaultValues.headerUrl,
    watermarkEnabled: watermark,
    branding: { template, primary, secondary, tagline: tagline || null, footer: footer || null },
  };

  const prescriptionPreview: A5Data = {
    rxNumber: "DEMO-001",
    patientName: "Test Patient",
    patientBirthdate: "01/01/1990",
    patientAge: 36,
    dentistName: "Dr. Test",
    date: "28/08/2026",
    notes: "Exemple de note d'ordonnance.",
    items: DEMO_RX_ITEMS,
  };

  const withTotals = DEMO_ITEMS.map((item) => ({
    ...item,
    total: lineTotal(item),
  }));
  const totals = docTotals(withTotals);

  const financialPreview: FinancialDocData = {
    docType: "invoice",
    number: "FAC-2026-0142",
    date: "28/08/2026",
    dueLabel: "27/09/2026",
    patientName: "Amine Kaci",
    patientPhone: "0550 12 34 56",
    notes: "Exemple de facture.",
    items: withTotals,
    subtotal: totals.subtotal,
    taxTotal: totals.taxTotal,
    discountTotal: totals.discountTotal,
    total: totals.total,
    paidAmount: 8000,
    statusLabel: "PARTIELLEMENT ACQUITTÉE",
  };

  const inputClassName =
    "mt-1 block w-full rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm focus:border-cerulean focus:outline-none focus:ring-1 focus:ring-cerulean";

  return (
    <form action={action} className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <div className="space-y-6">
        {/* ---- Template picker ---- */}
        <div>
          <label className="block text-sm font-medium text-cool-700 mb-2">
            Modèle du document
          </label>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {DOCUMENT_TEMPLATES.map((tpl) => (
              <button
                key={tpl.id}
                type="button"
                onClick={() => setTemplate(tpl.id)}
                className={
                  tpl.id === template
                    ? "rounded-lg border-2 border-cerulean bg-cerulean/10 px-3 py-2 text-sm font-semibold text-cerulean transition-colors"
                    : "rounded-lg border border-cool-200 bg-cool-50 px-3 py-2 text-sm text-cool-700 hover:bg-cool-100 transition-colors"
                }
              >
                {tpl.label}
              </button>
            ))}
          </div>
        </div>

        {/* ---- Palette quick picks ---- */}
        <div>
          <label className="block text-sm font-medium text-cool-700 mb-2">
            Palette rapide
          </label>
          <div className="flex gap-2">
            {BRANDING_PALETTES.map((palette) => (
              <button
                key={palette.primary}
                type="button"
                title={palette.label}
                onClick={() => {
                  setPrimary(palette.primary);
                  setSecondary(palette.secondary);
                }}
                className="h-9 flex-1 overflow-hidden rounded-lg border border-cool-200 cursor-pointer"
                style={{ display: "flex", padding: 0 }}
              >
                <span className="block" style={{ width: "65%", background: palette.primary }} />
                <span className="block" style={{ width: "35%", background: palette.secondary }} />
              </button>
            ))}
          </div>
        </div>

        {/* ---- Colors ---- */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-cool-700">
              Couleur principale
            </label>
            <input
              type="color"
              value={HEX.test(primary) ? primary : DEFAULT_DOCUMENT_BRANDING.primary}
              onChange={(e) => setPrimary(e.target.value)}
              className="mt-1 h-9 w-full cursor-pointer rounded-lg border border-cool-200 bg-white p-0.5"
            />
            <input type="hidden" name="primary" value={primary} />
          </div>
          <div>
            <label className="block text-sm font-medium text-cool-700">
              Couleur secondaire
            </label>
            <input
              type="color"
              value={HEX.test(secondary) ? secondary : DEFAULT_DOCUMENT_BRANDING.secondary}
              onChange={(e) => setSecondary(e.target.value)}
              className="mt-1 h-9 w-full cursor-pointer rounded-lg border border-cool-200 bg-white p-0.5"
            />
            <input type="hidden" name="secondary" value={secondary} />
          </div>
        </div>
        <input type="hidden" name="template" value={template} />
        <input type="hidden" name="tagline" value={tagline} />
        <input type="hidden" name="footer" value={footer} />

        {/* ---- Tagline ---- */}
        <div>
          <label htmlFor="tagline" className="block text-sm font-medium text-cool-700">
            Sous-titre de l&apos;en-tête
          </label>
          <input
            id="tagline"
            type="text"
            placeholder="Dr Benali S. — Chirurgien-Dentiste"
            value={tagline}
            onChange={(e) => setTagline(e.target.value)}
            className={inputClassName}
          />
          <p className="mt-1 text-xs text-cool-400">
            Affiché sous le nom de la clinique. Laissez vide pour le masquer.
          </p>
        </div>

        {/* ---- Footer ---- */}
        <div>
          <label htmlFor="footer" className="block text-sm font-medium text-cool-700">
            Pied de page du document
          </label>
          <textarea
            id="footer"
            rows={4}
            placeholder={"Adresse\nTél: ...\nRC / NIF ..."}
            value={footer}
            onChange={(e) => setFooter(e.target.value)}
            className={inputClassName + " resize-y"}
          />
          <p className="mt-1 text-xs text-cool-400">
            Laissez vide pour utiliser automatiquement l&apos;adresse, le téléphone,
            l&apos;email et les mentions légales de la clinique.
          </p>
        </div>

        {/* ---- Watermark ---- */}
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            name="watermarkEnabled"
            checked={watermark}
            onChange={(e) => setWatermark(e.target.checked)}
            className="h-4 w-4 rounded border-input text-cerulean focus-visible:ring-3 focus-visible:ring-ring/50"
          />
          <span className="text-sm font-medium text-cool-700">
            Afficher le logo en filigrane sur les documents
          </span>
        </label>

        {generalError && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600">
            {generalError}
          </div>
        )}

        {state?.success && (
          <p className="text-sm text-green-600">
            Identité des documents mise à jour.
          </p>
        )}

        <div className="flex items-center gap-3 pt-2">
          <button
            type="submit"
            disabled={pending}
            className="rounded-lg bg-primary px-6 py-2.5 text-sm font-medium text-white hover:bg-primary-light disabled:opacity-50 transition-colors"
          >
            {pending ? "Enregistrement..." : "Enregistrer"}
          </button>
        </div>
      </div>

      {/* ---- Live preview ---- */}
      <div className="hidden lg:block">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-xs font-medium text-cool-500 uppercase tracking-wider">
            Aperçu A5
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setDocType("prescription")}
              className={
                docType === "prescription"
                  ? "rounded-md bg-cool-900 px-3 py-1 text-xs font-medium text-white"
                  : "rounded-md border border-cool-200 px-3 py-1 text-xs font-medium text-cool-600 hover:bg-cool-50"
              }
            >
              Ordonnance
            </button>
            <button
              type="button"
              onClick={() => setDocType("invoice")}
              className={
                docType === "invoice"
                  ? "rounded-md bg-cool-900 px-3 py-1 text-xs font-medium text-white"
                  : "rounded-md border border-cool-200 px-3 py-1 text-xs font-medium text-cool-600 hover:bg-cool-50"
              }
            >
              Facture
            </button>
          </div>
        </div>
        <div ref={previewRef} className="w-full">
          <div
            className="overflow-hidden rounded-lg border border-cool-200 shadow-lg"
            style={{ width: A5_SHEET_WIDTH_PX * scale, height: A5_SHEET_HEIGHT_PX * scale }}
          >
            <div
              style={{
                transform: `scale(${scale})`,
                transformOrigin: "top left",
                width: "148mm",
                height: "210mm",
              }}
            >
              {docType === "prescription" ? (
                <A5Prescription template={templateProps} data={prescriptionPreview} />
              ) : (
                <A5FinancialDocument template={templateProps} data={financialPreview} />
              )}
            </div>
          </div>
        </div>
        <p className="mt-2 text-xs text-cool-400">
          Chaque modèle n&apos;est qu&apos;une feuille de style — le contenu HTML est
          identique pour l&apos;ordonnance, la facture et le devis.
        </p>
      </div>
    </form>
  );
}