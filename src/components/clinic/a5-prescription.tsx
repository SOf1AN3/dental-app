import { a5Styles } from "./a5-styles";

/**
 * Pure shared A5 prescription sheet.
 *
 * NO "use client", NO hooks, NO browser globals: this component is safe to
 * render both in a server component (print page) and inside a client
 * component (live editor preview), and always produces the same markup.
 */

export interface A5Template {
  name: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  legalInfo: string | null;
  logoUrl: string | null;
  headerUrl: string | null;
  watermarkEnabled: boolean;
}

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
  dentistName: string | null;
  date: string;
  notes: string | null;
  items: A5Item[];
}

interface A5PrescriptionProps {
  template: A5Template;
  data: A5Data;
}

export function A5Prescription({ template, data }: A5PrescriptionProps) {
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: a5Styles }} />
      <div className="a5-page">
        {template.watermarkEnabled && template.logoUrl && (
          <div className="a5-watermark" aria-hidden="true">
            {/* Plain <img>: logo URLs come from S3 and would break next/image. */}
            {/* eslint-disable-next-line @next/next/no-img-element -- user-uploaded S3/upload URL, print template */}
            <img src={template.logoUrl} alt="" />
          </div>
        )}

        <div className="a5-content">
          {template.headerUrl ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element -- user-uploaded S3/upload URL, print template */}
              <img src={template.headerUrl} alt="" className="a5-header-banner" />
              <div className="a5-header-meta">
                <p className="a5-rx-number">N° {data.rxNumber}</p>
                <p className="a5-rx-date">Date: {data.date}</p>
              </div>
            </>
          ) : (
            <div className="a5-header">
              <div className="a5-header-left">
                {template.logoUrl && (
                  // eslint-disable-next-line @next/next/no-img-element -- user-uploaded S3/upload URL, print template
                  <img src={template.logoUrl} alt="" className="a5-logo" />
                )}
                <h1 className="a5-clinic-name">{template.name || "Cabinet Dentaire"}</h1>
                {template.address && <p className="a5-clinic-detail">{template.address}</p>}
                {template.phone && <p className="a5-clinic-detail">Tél: {template.phone}</p>}
                {template.email && <p className="a5-clinic-detail">Email: {template.email}</p>}
              </div>
              <div className="a5-header-right">
                <p className="a5-rx-number">N° {data.rxNumber}</p>
                <p className="a5-rx-date">Date: {data.date}</p>
              </div>
            </div>
          )}

          <div className="a5-divider" />

          <div className="a5-patient-info">
            <div className="a5-patient-row">
              <span className="a5-label">Patient:</span>
              <span className="a5-value">{data.patientName}</span>
            </div>
            {data.patientBirthdate && (
              <div className="a5-patient-row">
                <span className="a5-label">Date naiss.:</span>
                <span className="a5-value">{data.patientBirthdate}</span>
              </div>
            )}
          </div>

          <div className="a5-divider" />

          <div className="a5-prescriber-info">
            <div className="a5-patient-row">
              <span className="a5-label">Médecin:</span>
              <span className="a5-value">{data.dentistName || "—"}</span>
            </div>
          </div>

          <div className="a5-divider" />

          {data.notes && (
            <div className="a5-notes">
              <p className="a5-notes-text">{data.notes}</p>
            </div>
          )}

          {data.items.length > 0 && (
            <table className="a5-rx-table">
              <thead>
                <tr>
                  <th>Médicament/Soin</th>
                  <th>Dosage</th>
                  <th>Forme</th>
                  <th>Fréquence</th>
                  <th>Durée</th>
                  <th>Qté</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((item, i) => (
                  <tr key={i}>
                    <td className="a5-td-name">{item.name}</td>
                    <td>{item.dosage || "—"}</td>
                    <td>{item.form || "—"}</td>
                    <td>{item.frequency || "—"}</td>
                    <td>{item.duration || "—"}</td>
                    <td className="a5-td-qty">{item.quantity != null ? item.quantity : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {data.items.length > 0 && data.items.some((item) => item.instructions) && (
            <div className="a5-instructions">
              <p className="a5-section-title">Instructions:</p>
              {data.items
                .filter((item) => item.instructions)
                .map((item, i) => (
                  <p key={i} className="a5-instruction-line">
                    • {item.name}: {item.instructions}
                  </p>
                ))}
            </div>
          )}

          <div className="a5-divider" />

          <div className="a5-footer">
            <div className="a5-signature-area">
              <p className="a5-signature-label">Signature du médecin:</p>
              <div className="a5-signature-line" />
            </div>
            {template.legalInfo && (
              <p className="a5-legal-info">{template.legalInfo}</p>
            )}
            <p className="a5-footer-note">Document généré par DentalCare</p>
          </div>
        </div>
      </div>
    </>
  );
}
