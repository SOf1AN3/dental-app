import type { CSSProperties } from "react";
import { a5Styles } from "./a5-styles";
import { resolveFooter, type A5Template } from "@/lib/document-branding";

export type { A5Template };

/**
 * Pure shared A5 branded prescription sheet.
 *
 * NO "use client", NO hooks, NO browser globals: this component is safe to
 * render both in a server component (print page) and inside a client
 * component (live editor preview), and always produces the same markup.
 */

export interface A5Item {
  type: "medication" | "care";
  name: string;
  dosage: string | null;
  form: string | null;
  frequency: string | null;
  duration: string | null;
  quantity: number | null;
  instructions: string | null;
}

export interface A5Data {
  rxNumber: string;
  patientName: string;
  patientBirthdate: string | null;
  /** Optional computed age (from patient birthdate). */
  patientAge: number | null;
  dentistName: string | null;
  date: string;
  notes: string | null;
  items: A5Item[];
}

interface A5PrescriptionProps {
  template: A5Template;
  data: A5Data;
}

function footerLines(text: string): string[] {
  return text.split("\n");
}

function posoLine(item: A5Item): string {
  const parts: string[] = [];
  if (item.dosage) parts.push(item.dosage);
  if (item.form) parts.push(item.form);
  if (item.frequency) parts.push(item.frequency);
  if (item.duration) parts.push(item.duration);
  if (item.quantity != null) parts.push(`Qté: ${item.quantity}`);
  return parts.join(" · ");
}

export function A5Prescription({ template, data }: A5PrescriptionProps) {
  const branding = template.branding;
  const footer = resolveFooter(template);

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
            {/* Plain <img>: logo URLs come from S3 and would break next/image. */}
            {/* eslint-disable-next-line @next/next/no-img-element -- user-uploaded S3/upload URL, print template */}
            <img src={template.logoUrl} alt="" />
          </div>
        )}

        {template.headerUrl ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element -- user-uploaded S3/upload URL, print template */}
            <img src={template.headerUrl} alt="" className="a5-header-banner" />
            <div className="a5-header-meta">
              {data.rxNumber && (
                <span>
                  <b>N° {data.rxNumber}</b>
                </span>
              )}
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
              {data.rxNumber && <p className="doc-number">N° {data.rxNumber}</p>}
              <p className="doc-date">Date: {data.date}</p>
            </div>
          </header>
        )}

        <div className="doc-body">
          <div className="doc-title">ORDONNANCE</div>

          <div className="meta">
            <span>
              <b>Patient :</b> {data.patientName}
              {data.patientAge != null && ` — ${data.patientAge} ans`}
            </span>
            {data.patientBirthdate && (
              <span>
                <b>Naissance :</b> {data.patientBirthdate}
              </span>
            )}
            <span>
              <b>Médecin :</b> {data.dentistName || "—"}
            </span>
          </div>

          <div className="rx-symbol">℞</div>

          {data.notes && <div className="doc-notes">{data.notes}</div>}

          {data.items.map((item, i) => (
            <div className="rx-item" key={i}>
              <b>{item.name}</b>
              {(() => {
                const poso = posoLine(item);
                return poso ? <div>{poso}</div> : null;
              })()}
              {item.instructions && (
                <div className="rx-instruction">{item.instructions}</div>
              )}
            </div>
          ))}

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