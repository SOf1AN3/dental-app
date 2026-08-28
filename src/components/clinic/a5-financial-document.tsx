import type { CSSProperties } from "react";
import { a5Styles } from "./a5-styles";
import { resolveFooter, type A5Template } from "@/lib/document-branding";

export type { A5Template };

/**
 * Pure shared A5 branded invoice / quote sheet (FACT-7).
 *
 * Same constraints as A5Prescription: NO "use client", NO hooks — renders
 * identically on the server print pages and anywhere else.
 */

export interface PrintLineItem {
  description: string;
  quantity: number;
  unitPrice: number;
  taxRate: number;
  discount: number;
  total: number;
}

export interface FinancialDocData {
  docType: "invoice" | "quote";
  number: string;
  date: string;
  dueLabel: string | null;
  patientName: string;
  patientPhone: string | null;
  notes: string | null;
  items: PrintLineItem[];
  subtotal: number;
  taxTotal: number;
  discountTotal: number;
  total: number;
  paidAmount: number | null;
  statusLabel: string | null;
}

function fmt(n: number): string {
  return new Intl.NumberFormat("fr-FR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

function footerLines(text: string): string[] {
  return text.split("\n");
}

export function A5FinancialDocument({
  template,
  data,
}: {
  template: A5Template;
  data: FinancialDocData;
}) {
  const branding = template.branding;
  const title = data.docType === "invoice" ? "Facture" : "Devis";
  const footer = resolveFooter(template);
  const remaining = data.paidAmount != null ? Math.max(0, data.total - data.paidAmount) : null;

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: a5Styles }} />
      <div
        className={`a5-page tpl-${branding.template}`}
        style={{
          "--primary": branding.primary,
          "--secondary": branding.secondary,
        } as CSSProperties}
      >
        {template.watermarkEnabled && template.logoUrl && (
          <div className="a5-watermark" aria-hidden="true">
            {/* eslint-disable-next-line @next/next/no-img-element -- user-uploaded S3/upload URL, print template */}
            <img src={template.logoUrl} alt="" />
          </div>
        )}

        {template.headerUrl ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element -- user-uploaded S3/upload URL, print template */}
            <img src={template.headerUrl} alt="" className="a5-header-banner" />
            <div className="a5-header-meta">
              <span>
                <b>N° {data.number}</b>
              </span>
              <span>
                <b>Date :</b> {data.date}
              </span>
            </div>
          </>
        ) : (
          <header className="doc-header">
            <div className="doc-header-left">
              {template.logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- user-uploaded S3/upload URL, print template
                <img src={template.logoUrl} alt="" className="logo" />
              ) : (
                <div className="logo-placeholder">Logo</div>
              )}
              <div>
                <div className="clinic-name">
                  {template.name || "Cabinet Dentaire"}
                </div>
                {branding.tagline && (
                  <div className="clinic-tag">{branding.tagline}</div>
                )}
              </div>
            </div>
            <div className="doc-header-meta">
              <p className="doc-number">N° {data.number}</p>
              <p className="doc-date">Date: {data.date}</p>
            </div>
          </header>
        )}

        <div className="doc-body">
          <div className="doc-title">{title.toUpperCase()}</div>
          {data.statusLabel && <span className="status-badge">{data.statusLabel}</span>}

          <div className="meta">
            <span>
              <b>Patient :</b> {data.patientName}
            </span>
            {data.patientPhone && (
              <span>
                <b>Tél :</b> {data.patientPhone}
              </span>
            )}
            {data.dueLabel && (
              <span>
                <b>{data.docType === "invoice" ? "Échéance :" : "Valable jusqu'au :"}</b>{" "}
                {data.dueLabel}
              </span>
            )}
          </div>

          {data.items.length > 0 ? (
            <table>
              <thead>
                <tr>
                  <th>Description</th>
                  <th className="num">Qté</th>
                  <th className="num">P.U.</th>
                  <th className="num">TVA</th>
                  <th className="num">Remise</th>
                  <th className="num">Total</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((item, i) => (
                  <tr key={i}>
                    <td>{item.description}</td>
                    <td className="num">{item.quantity}</td>
                    <td className="num">{fmt(item.unitPrice)}</td>
                    <td className="num">{item.taxRate > 0 ? `${item.taxRate}%` : "—"}</td>
                    <td className="num">{item.discount > 0 ? fmt(item.discount) : "—"}</td>
                    <td className="num">{fmt(item.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="footer-notes">Aucune ligne.</p>
          )}

          <div className="totals">
            <div className="row">
              <span>Sous-total</span>
              <span>{fmt(data.subtotal)} DZD</span>
            </div>
            {data.taxTotal > 0 && (
              <div className="row">
                <span>Total TVA</span>
                <span>{fmt(data.taxTotal)} DZD</span>
              </div>
            )}
            {data.discountTotal > 0 && (
              <div className="row">
                <span>Total remises</span>
                <span>-{fmt(data.discountTotal)} DZD</span>
              </div>
            )}
            <div className="row grand">
              <span>Total</span>
              <span>{fmt(data.total)} DZD</span>
            </div>
          </div>

          {data.docType === "invoice" && data.paidAmount != null && data.paidAmount > 0 && (
            <div className="paid-note">
              Déjà réglé : {fmt(data.paidAmount)} DZD
              {remaining != null && ` — Reste à payer : ${fmt(remaining)} DZD`}
            </div>
          )}

          {data.notes && <div className="footer-notes">{data.notes}</div>}

          <div className="signature">Cachet et signature</div>
        </div>

        <footer className="doc-footer">
          {footerLines(footer).map((line, i) => (
            <p key={i}>
              {line || "\u00A0"}
            </p>
          ))}
        </footer>
      </div>
    </>
  );
}