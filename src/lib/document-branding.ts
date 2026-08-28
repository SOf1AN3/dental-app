import { z } from "zod";

/**
 * Document branding — single source of truth for the A5 print templates.
 *
 * Concept mirrors dentalflow-branding-templates-v2.html: one JSON branding
 * object per clinic (tenant), applied identically to the prescription,
 * invoice and quote sheets. The <A5Prescription /> / <A5FinancialDocument />
 * components only need the resolved A5Template below.
 */

export const DOCUMENT_TEMPLATES = [
  { id: "light", label: "Light" },
  { id: "boxed", label: "Boxed" },
  { id: "bold", label: "Bold" },
  { id: "corporate", label: "Corporate" },
  { id: "classic", label: "Classique" },
  { id: "minimal", label: "Minimal" },
  { id: "executif", label: "Exécutif" },
] as const;

export type DocumentTemplateId = (typeof DOCUMENT_TEMPLATES)[number]["id"];

export interface DocumentBranding {
  template: DocumentTemplateId;
  primary: string;
  secondary: string;
  tagline: string | null;
  /** Multiline footer text; when empty a footer is derived from the clinic. */
  footer: string | null;
}

export const BRANDING_PALETTES: {
  label: string;
  primary: string;
  secondary: string;
}[] = [
  { label: "Émeraude", primary: "#0e7a5f", secondary: "#7081e0" },
  { label: "Marine & or", primary: "#1e3a5f", secondary: "#b08d57" },
  { label: "Anthracite", primary: "#1f2937", secondary: "#9ca3af" },
  { label: "Bordeaux", primary: "#7c2d3e", secondary: "#b98a44" },
];

export const DEFAULT_DOCUMENT_BRANDING: DocumentBranding = {
  template: "light",
  primary: "#0e7a5f",
  secondary: "#7081e0",
  tagline: null,
  footer: null,
};

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Couleur hexadécimale attendue");

export const documentBrandingSchema = z.object({
  template: z.enum(DOCUMENT_TEMPLATES.map((t) => t.id)),
  primary: hexColor,
  secondary: hexColor,
  tagline: z.string().trim().max(160).optional().or(z.literal("")),
  footer: z.string().trim().max(2000).optional().or(z.literal("")),
});

function isTemplateId(value: string): value is DocumentTemplateId {
  return DOCUMENT_TEMPLATES.some((t) => t.id === value);
}

/** Normalize a possibly-incomplete/legacy branding object to a full one. */
export function resolveBranding(raw: Partial<DocumentBranding> | null | undefined): DocumentBranding {
  const base = { ...DEFAULT_DOCUMENT_BRANDING };
  if (!raw) return base;
  if (raw.template && isTemplateId(raw.template)) base.template = raw.template;
  if (raw.primary && /^#[0-9a-fA-F]{6}$/.test(raw.primary)) base.primary = raw.primary;
  if (raw.secondary && /^#[0-9a-fA-F]{6}$/.test(raw.secondary)) base.secondary = raw.secondary;
  base.tagline = raw.tagline?.trim() || null;
  base.footer = raw.footer?.trim() || null;
  return base;
}

export interface A5Template {
  name: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  legalInfo: string | null;
  logoUrl: string | null;
  headerUrl: string | null;
  watermarkEnabled: boolean;
  branding: DocumentBranding;
}

export const FALLBACK_A5_TEMPLATE: A5Template = {
  name: "Cabinet Dentaire",
  address: null,
  phone: null,
  email: null,
  legalInfo: null,
  logoUrl: null,
  headerUrl: null,
  watermarkEnabled: false,
  branding: DEFAULT_DOCUMENT_BRANDING,
};

interface ClinicTemplateSource {
  name?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  legalInfo?: string | null;
  watermarkEnabled?: boolean | null;
  documentBranding?: DocumentBranding | Partial<DocumentBranding> | null;
}

/**
 * Build the resolved A5 template from the current clinic. Falls back to the
 * neutral defaults when the clinic is missing so every caller (print routes,
 * editor previews, settings designer) shares the same rules.
 */
export function buildA5Template(
  clinic: ClinicTemplateSource | null | undefined,
  urls?: { logoUrl?: string | null; headerUrl?: string | null },
): A5Template {
  if (!clinic) return FALLBACK_A5_TEMPLATE;
  return {
    name: clinic.name || FALLBACK_A5_TEMPLATE.name,
    address: clinic.address ?? null,
    phone: clinic.phone ?? null,
    email: clinic.email ?? null,
    legalInfo: clinic.legalInfo ?? null,
    logoUrl: urls?.logoUrl ?? null,
    headerUrl: urls?.headerUrl ?? null,
    watermarkEnabled: clinic.watermarkEnabled ?? false,
    branding: resolveBranding(clinic.documentBranding),
  };
}

/**
 * Footer text shown at the bottom of every A5 document. Uses the clinic's
 * explicit branding footer when set; otherwise derives one from the clinic
 * contact + legal information so the sheet is never empty.
 */
export function resolveFooter(template: Pick<A5Template, "address" | "phone" | "email" | "legalInfo" | "branding">): string {
  const explicit = template.branding.footer?.trim();
  if (explicit) return explicit;
  return [template.address, template.phone && `Tél: ${template.phone}`, template.email && `Email: ${template.email}`, template.legalInfo]
    .filter(Boolean)
    .join("\n");
}

/** Human age from a birth date (null when unknown). */
export function computeAge(birthdate: Date | string | null | undefined, on: Date = new Date()): number | null {
  if (!birthdate) return null;
  const d = new Date(birthdate);
  if (Number.isNaN(d.getTime())) return null;
  let age = on.getFullYear() - d.getFullYear();
  const m = on.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && on.getDate() < d.getDate())) age -= 1;
  return age >= 0 && age < 130 ? age : null;
}