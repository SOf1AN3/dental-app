/**
 * Single source of truth for the A5 prescription sheet (148mm x 210mm).
 *
 * Plain CSS — no Tailwind, no CSS variables — so the sheet always renders
 * identically regardless of app theming / dark mode. All colors are hardcoded.
 *
 * This stylesheet is injected by <A5Prescription /> (via a <style> tag) and is
 * shared by:
 *  - the server-rendered print page (RSC)
 *  - the live editor preview (client component)
 */

/** A5 sheet dimensions in CSS pixels at 96dpi: 148mm = 559.37px, 210mm = 793.7px. */
export const A5_SHEET_WIDTH_PX = 559.4;
export const A5_SHEET_HEIGHT_PX = 793.7;

export const a5Styles = `
  @page {
    size: A5 portrait;
    margin: 12mm 10mm;
  }

  /* ---- Sheet ---- */
  .a5-page {
    width: 148mm;
    min-height: 210mm;
    padding: 10mm 8mm;
    margin: 0 auto;
    background: #ffffff;
    color: #1a1a1a;
    font-family: 'Inter', 'Segoe UI', Arial, sans-serif;
    font-size: 10pt;
    line-height: 1.4;
    position: relative;
  }

  /* Scoped reset: keep the sheet deterministic without touching the app UI. */
  .a5-page,
  .a5-page * {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
  }

  /* Content sits above the watermark (z-index stacking, light-mode safe). */
  .a5-content {
    position: relative;
    z-index: 1;
  }

  /* ---- Watermark ---- */
  .a5-watermark {
    position: absolute;
    inset: 0;
    z-index: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    pointer-events: none;
  }
  .a5-watermark img {
    opacity: 0.08;
    max-width: 70%;
    max-height: 60%;
    object-fit: contain;
  }

  /* ---- Header ---- */
  .a5-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 4mm;
  }
  .a5-header-left { flex: 1; }
  .a5-header-right { text-align: right; }

  .a5-logo {
    display: block;
    max-height: 18mm;
    max-width: 50mm;
    object-fit: contain;
    margin-bottom: 2mm;
  }

  /* Full-width clinic header banner (used when headerUrl is set). */
  .a5-header-banner {
    display: block;
    width: 100%;
    max-height: 22mm;
    object-fit: contain;
    margin-bottom: 3mm;
  }

  /* Meta row (rx number + date) used when a header banner replaces the logo block. */
  .a5-header-meta {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    margin-bottom: 3mm;
  }

  .a5-clinic-name {
    font-size: 14pt;
    font-weight: 700;
    color: #1e2a5a;
    margin-bottom: 2mm;
  }

  .a5-clinic-detail {
    font-size: 8.5pt;
    color: #4b5563;
    line-height: 1.5;
  }

  .a5-rx-number {
    font-size: 10pt;
    font-weight: 600;
    color: #1e2a5a;
  }
  .a5-rx-date {
    font-size: 8.5pt;
    color: #6b7280;
    margin-top: 1mm;
  }

  /* ---- Dividers ---- */
  .a5-divider {
    border-top: 1px solid #d1d5db;
    margin: 3mm 0;
  }

  /* ---- Patient / Prescriber ---- */
  .a5-patient-info,
  .a5-prescriber-info {
    margin-bottom: 3mm;
  }
  .a5-patient-row {
    font-size: 10pt;
    margin-bottom: 1mm;
  }
  .a5-patient-row .a5-label {
    font-weight: 600;
    color: #374151;
    margin-right: 2mm;
  }
  .a5-patient-row .a5-value {
    color: #1a1a1a;
  }

  /* ---- Notes ---- */
  .a5-notes {
    background: #f9fafb;
    padding: 2mm 3mm;
    border-left: 3px solid #1e2a5a;
    margin-bottom: 3mm;
    font-size: 9pt;
    color: #374151;
  }
  .a5-notes-text {
    white-space: pre-wrap;
  }

  /* ---- Items table ---- */
  .a5-rx-table {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 3mm;
    font-size: 8.5pt;
  }
  .a5-rx-table th {
    background: #1e2a5a;
    color: #ffffff;
    padding: 1.5mm 2mm;
    text-align: left;
    font-weight: 600;
  }
  .a5-rx-table td {
    padding: 1.5mm 2mm;
    border-bottom: 1px solid #e5e7eb;
  }
  .a5-td-name { font-weight: 600; }
  .a5-td-qty { text-align: center; }

  /* ---- Instructions ---- */
  .a5-instructions {
    margin-bottom: 3mm;
    font-size: 8.5pt;
    color: #374151;
  }
  .a5-section-title {
    font-weight: 600;
    margin-bottom: 1mm;
  }
  .a5-instruction-line {
    margin-left: 2mm;
    margin-bottom: 0.5mm;
  }

  /* ---- Footer ---- */
  .a5-footer {
    margin-top: 6mm;
    padding-top: 3mm;
    border-top: 1px solid #d1d5db;
  }
  .a5-signature-area { margin-bottom: 3mm; }
  .a5-signature-label {
    font-size: 9pt;
    font-weight: 600;
    color: #374151;
    margin-bottom: 1mm;
  }
  .a5-signature-line {
    border-bottom: 1px solid #9ca3af;
    width: 120px;
    height: 16px;
  }
  .a5-legal-info {
    font-size: 7pt;
    color: #6b7280;
    text-align: center;
    margin-bottom: 1mm;
  }
  .a5-footer-note {
    font-size: 7pt;
    color: #9ca3af;
    text-align: center;
    margin-top: 2mm;
  }

  /* ---- Visibility helpers ---- */
  /* Hides an element on screen AND in print (e.g. decorative pieces). */
  .print-hidden { display: none !important; }
  @media print {
    .print-hidden { display: none !important; }
  }

  /* ---- Print ---- */
  @media print {
    body {
      background: #ffffff !important;
    }
    .a5-page {
      width: 100%;
      min-height: auto;
      padding: 0;
      margin: 0;
    }
  }
`;
