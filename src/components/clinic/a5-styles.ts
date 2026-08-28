/**
 * A5 branded document styles — single source of truth for the print sheets
 * (prescription, invoice, quote), ported from dentalflow-branding-templates-v2.html.
 *
 * Plain CSS — no Tailwind — driven by two inline CSS variables set on the
 * sheet (`--primary` / `--secondary`) plus a `tpl-*` class, so the sheet
 * renders identically regardless of app theming / dark mode.
 *
 * Injected by <A5Prescription /> and <A5FinancialDocument />, shared by:
 *  - the server-rendered print pages (RSC)
 *  - the live editor / settings previews (client components)
 */

/** A5 sheet dimensions at 96dpi: 148mm = 559.37px, 210mm = 793.7px. */
export const A5_SHEET_WIDTH_PX = 559.4;
export const A5_SHEET_HEIGHT_PX = 793.7;

export const a5Styles = `
  @page {
    size: A5 portrait;
    margin: 0;
  }

  /* ---------- Sheet base ---------- */
  .a5-page {
    --primary: #0e7a5f;
    --secondary: #7081e0;
    width: 148mm;
    min-height: 210mm;
    background: #ffffff;
    box-shadow: 0 4px 24px rgba(15, 23, 42, 0.15);
    display: flex;
    flex-direction: column;
    font-family: 'Inter', 'Segoe UI', Arial, sans-serif;
    font-size: 10.5px;
    line-height: 1.45;
    color: #0f172a;
    position: relative;
  }

  .a5-page,
  .a5-page * {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }

  /* Content sits above the watermark. */
  .a5-page > .doc-header,
  .a5-page > .doc-body,
  .a5-page > .doc-footer,
  .a5-page > .right-col {
    position: relative;
    z-index: 1;
  }

  /* ---------- Legacy full-width header banner (headerUrl) ---------- */
  .a5-header-banner {
    display: block;
    width: 100%;
    max-height: 26mm;
    object-fit: contain;
    background: #ffffff;
  }
  .a5-header-meta {
    display: flex;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 4px 12px;
    padding: 2mm 12mm 1mm;
    font-size: 10px;
    color: #64748b;
  }
  .a5-header-meta b { color: #1e2a5a; font-weight: 600; }

  /* ---------- Watermark ---------- */
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

  /* ---------- Shared document elements ---------- */
  .a5-page .doc-header-left { display: flex; align-items: center; gap: 10px; }
  .a5-page .doc-header-meta { text-align: right; }

  .a5-page .logo { width: 40px; height: 40px; object-fit: contain; }
  .a5-page .logo-placeholder {
    width: 40px; height: 40px; border: 1.5px dashed #94a3b8; border-radius: 8px;
    display: flex; align-items: center; justify-content: center;
    font-size: 8px; color: #94a3b8; text-align: center;
  }

  .a5-page .clinic-name { font-size: 15px; font-weight: 700; color: var(--primary); }
  .a5-page .clinic-tag { font-size: 9.5px; color: #64748b; }

  .a5-page .doc-number { font-size: 10px; font-weight: 600; color: var(--primary); }
  .a5-page .doc-date { font-size: 9px; color: #64748b; margin-top: 1mm; }

  .a5-page .doc-title { font-size: 13px; font-weight: 700; letter-spacing: 0.06em; color: var(--primary); margin-bottom: 6px; }
  .a5-page .meta { font-size: 10px; margin-bottom: 10px; line-height: 1.6; }
  .a5-page .meta b { color: var(--primary); }

  .a5-page table { width: 100%; border-collapse: collapse; margin: 8px 0; }
  .a5-page th { background: var(--primary); color: #fff; text-align: left; padding: 5px 8px; font-size: 9.5px; }
  .a5-page td { padding: 5px 8px; border-bottom: 1px solid #e2e8f0; font-size: 10px; vertical-align: top; }
  .a5-page td.num, .a5-page th.num { text-align: right; white-space: nowrap; }

  .a5-page .status-badge {
    display: inline-block; font-size: 9px; font-weight: 700; letter-spacing: 0.08em;
    padding: 3px 10px; border-radius: 999px; background: var(--primary); color: #fff; margin-top: 5px;
  }

  .a5-page .totals { margin-top: 8px; margin-left: auto; width: 58%; font-size: 10.5px; }
  .a5-page .totals .row { display: flex; justify-content: space-between; padding: 3px 8px; }
  .a5-page .totals .grand { font-weight: 700; color: #fff; background: var(--primary); border-radius: 4px; }

  .a5-page .paid-note { margin-top: 6px; margin-left: auto; width: 58%; font-size: 9.5px; color: #065f46; text-align: right; }

  .a5-page .footer-notes { margin-top: 4mm; font-size: 8.5px; color: #6b7280; white-space: pre-line; }

  .a5-page .doc-notes {
    background: #f9fafb; border-left: 3px solid var(--primary);
    padding: 2mm 3mm; margin-bottom: 3mm; font-size: 9pt; color: #374151; white-space: pre-wrap;
  }

  .a5-page .rx-symbol { font-size: 18px; font-weight: 700; color: var(--primary); margin: 1mm 0 2mm; }
  .a5-page .rx-item { padding: 6px 0; border-bottom: 1px dashed #cbd5e1; }
  .a5-page .rx-item b { color: var(--primary); }
  .a5-page .rx-instruction { margin-top: 1px; font-size: 9px; color: #4b5563; }

  .a5-page .signature { margin-top: 12mm; text-align: right; font-size: 9.5px; color: #64748b; }

  /* ===== 1. Light (accent line, minimal) ===== */
  .a5-page.tpl-light .doc-header { padding: 10mm 12mm 6mm; border-bottom: 3px solid var(--primary); display: flex; align-items: center; gap: 10px; }
  .a5-page.tpl-light .doc-body { padding: 8mm 12mm; flex: 1; }
  .a5-page.tpl-light .doc-footer { padding: 5mm 12mm; border-top: 1px solid #e2e8f0; color: #64748b; font-size: 9px; }

  /* ===== 2. Boxed (colored header band) ===== */
  .a5-page.tpl-boxed .doc-header { padding: 8mm 12mm; background: var(--primary); color: #fff; display: flex; align-items: center; gap: 10px; }
  .a5-page.tpl-boxed .doc-header .clinic-name, .a5-page.tpl-boxed .doc-header .clinic-tag { color: #fff; }
  .a5-page.tpl-boxed .doc-header .doc-number { color: #fff; }
  .a5-page.tpl-boxed .doc-header .doc-date { color: rgba(255,255,255,.85); }
  .a5-page.tpl-boxed .doc-header .logo-placeholder { border-color: rgba(255,255,255,.7); color: #fff; }
  .a5-page.tpl-boxed .doc-body { padding: 8mm 12mm; flex: 1; }
  .a5-page.tpl-boxed .doc-body .meta { background: #f1f5f9; border-left: 4px solid var(--secondary); padding: 8px 10px; margin-bottom: 10px; }
  .a5-page.tpl-boxed .doc-footer { padding: 5mm 12mm; background: var(--primary); color: rgba(255,255,255,.85); font-size: 9px; }

  /* ===== 3. Bold (colored sidebar) ===== */
  .a5-page.tpl-bold { flex-direction: row; }
  .a5-page.tpl-bold .doc-header {
    width: 44mm; flex-shrink: 0; padding: 10mm 6mm;
    background: linear-gradient(180deg, var(--primary), var(--secondary));
    color: #fff; display: flex; flex-direction: column; gap: 8px;
  }
  .a5-page.tpl-bold .doc-header-left { flex-direction: column; align-items: center; text-align: center; gap: 8px; }
  .a5-page.tpl-bold .doc-header-meta { text-align: left; }
  .a5-page.tpl-bold .doc-header .clinic-name, .a5-page.tpl-bold .doc-header .clinic-tag { color: #fff; }
  .a5-page.tpl-bold .doc-header .doc-number { color: #fff; }
  .a5-page.tpl-bold .doc-header .doc-date { color: rgba(255,255,255,.85); }
  .a5-page.tpl-bold .doc-header .logo, .a5-page.tpl-bold .doc-header .logo-placeholder { background: #fff; border-radius: 8px; }
  .a5-page.tpl-bold .right-col { flex: 1; display: flex; flex-direction: column; }
  .a5-page.tpl-bold .doc-body { padding: 10mm 8mm; flex: 1; }
  .a5-page.tpl-bold .doc-footer { padding: 5mm 8mm; border-top: 2px solid var(--primary); color: #64748b; font-size: 9px; }

  /* ===== 4. Corporate (double rule letterhead, grid meta) ===== */
  .a5-page.tpl-corporate .doc-header { padding: 9mm 12mm 6mm; display: flex; align-items: center; gap: 10px; position: relative; border-bottom: 3.5px solid var(--primary); }
  .a5-page.tpl-corporate .doc-header::after { content: ""; position: absolute; left: 12mm; right: 12mm; bottom: 3mm; height: 1.5px; background: var(--secondary); }
  .a5-page.tpl-corporate .clinic-name { text-transform: uppercase; letter-spacing: 0.05em; }
  .a5-page.tpl-corporate .doc-body { padding: 9mm 12mm; flex: 1; }
  .a5-page.tpl-corporate .meta { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap; border: 1px solid #e2e8f0; border-top: 3px solid var(--primary); padding: 8px 10px; background: #f8fafc; }
  .a5-page.tpl-corporate th { background: #fff; color: var(--primary); border-bottom: 2px solid var(--primary); text-transform: uppercase; font-size: 8.5px; letter-spacing: 0.08em; }
  .a5-page.tpl-corporate .totals .grand { background: var(--primary); }
  .a5-page.tpl-corporate .doc-footer { padding: 5mm 12mm; text-align: center; font-size: 8.5px; color: #64748b; border-top: 1px solid #e2e8f0; }
  .a5-page.tpl-corporate .rx-item b { text-transform: uppercase; letter-spacing: 0.03em; }

  /* ===== 5. Classique (serif, centered letterhead — traditional ordonnance look) ===== */
  .a5-page.tpl-classic { font-family: Georgia, "Times New Roman", serif; }
  .a5-page.tpl-classic .doc-header { padding: 10mm 14mm 5mm; display: flex; flex-direction: column; align-items: center; text-align: center; gap: 6px; border-bottom: 3px double var(--primary); }
  .a5-page.tpl-classic .clinic-name { font-size: 17px; font-weight: 700; letter-spacing: 0.02em; }
  .a5-page.tpl-classic .clinic-tag { font-style: italic; color: #475569; }
  .a5-page.tpl-classic .doc-header-meta { text-align: center; }
  .a5-page.tpl-classic .doc-body { padding: 8mm 14mm; flex: 1; }
  .a5-page.tpl-classic .doc-title { text-align: center; font-size: 14px; text-transform: uppercase; letter-spacing: 0.18em; }
  .a5-page.tpl-classic .meta { text-align: center; font-size: 10.5px; }
  .a5-page.tpl-classic th { background: none; color: var(--primary); border-bottom: 1.5px solid var(--primary); font-family: inherit; font-style: italic; font-weight: 700; font-size: 10px; }
  .a5-page.tpl-classic td { border-bottom: 1px solid #e2e8f0; }
  .a5-page.tpl-classic .totals .grand { background: none; color: var(--primary); border-top: 3px double var(--primary); border-radius: 0; }
  .a5-page.tpl-classic .rx-symbol { font-size: 24px; }
  .a5-page.tpl-classic .rx-item b { color: #0f172a; }
  .a5-page.tpl-classic .signature { font-style: italic; }
  .a5-page.tpl-classic .doc-footer { padding: 5mm 14mm; text-align: center; font-size: 9px; font-style: italic; color: #64748b; border-top: 1px solid var(--primary); }

  /* ===== 6. Minimal (Swiss — hairlines, whitespace, tiny caps) ===== */
  .a5-page.tpl-minimal .doc-header { padding: 12mm 14mm 6mm; display: flex; align-items: flex-end; justify-content: space-between; gap: 10px; }
  .a5-page.tpl-minimal .doc-header .clinic-name { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.12em; color: #0f172a; }
  .a5-page.tpl-minimal .clinic-tag { font-size: 8.5px; text-transform: uppercase; letter-spacing: 0.1em; color: #94a3b8; }
  .a5-page.tpl-minimal .doc-header-meta { text-align: right; }
  .a5-page.tpl-minimal .doc-number { color: #475569; }
  .a5-page.tpl-minimal .doc-body { padding: 6mm 14mm; flex: 1; }
  .a5-page.tpl-minimal .doc-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.2em; color: #0f172a; padding-bottom: 4px; border-bottom: 2.5px solid var(--primary); margin-bottom: 12px; }
  .a5-page.tpl-minimal .meta { font-size: 9.5px; color: #475569; text-transform: uppercase; letter-spacing: 0.05em; }
  .a5-page.tpl-minimal .meta b { color: #0f172a; font-weight: 600; }
  .a5-page.tpl-minimal th { background: none; color: #94a3b8; border-bottom: 1px solid #0f172a; text-transform: uppercase; font-size: 8px; letter-spacing: 0.12em; padding: 4px 8px; }
  .a5-page.tpl-minimal td { border-bottom: 1px solid #f1f5f9; padding: 6px 8px; }
  .a5-page.tpl-minimal .totals .grand { background: none; color: var(--primary); border-top: 2.5px solid var(--primary); border-radius: 0; font-size: 12px; }
  .a5-page.tpl-minimal .rx-item { border-bottom: 1px solid #f1f5f9; }
  .a5-page.tpl-minimal .rx-item b { color: #0f172a; }
  .a5-page.tpl-minimal .signature { color: #475569; }
  .a5-page.tpl-minimal .doc-footer { padding: 5mm 14mm; font-size: 8px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.08em; border-top: 1px solid #e2e8f0; }

  /* ===== 7. Exécutif (dark band, badge title, dark footer) ===== */
  .a5-page.tpl-executif .doc-header { padding: 9mm 12mm; background: #1e293b; color: #fff; display: flex; align-items: center; gap: 10px; border-bottom: 4px solid var(--secondary); }
  .a5-page.tpl-executif .doc-header .clinic-name { color: #fff; }
  .a5-page.tpl-executif .doc-header .clinic-tag { color: rgba(255,255,255,.65); }
  .a5-page.tpl-executif .doc-header .doc-number { color: #fff; }
  .a5-page.tpl-executif .doc-header .doc-date { color: rgba(255,255,255,.65); }
  .a5-page.tpl-executif .doc-header .logo, .a5-page.tpl-executif .doc-header .logo-placeholder { background: #fff; border-radius: 6px; }
  .a5-page.tpl-executif .doc-body { padding: 9mm 12mm; flex: 1; }
  .a5-page.tpl-executif .doc-title { display: inline-block; background: var(--primary); color: #fff; padding: 4px 12px; border-radius: 3px; font-size: 11px; letter-spacing: 0.12em; }
  .a5-page.tpl-executif th { background: #1e293b; }
  .a5-page.tpl-executif .totals .grand { background: #1e293b; border-left: 4px solid var(--secondary); border-radius: 0 4px 4px 0; }
  .a5-page.tpl-executif .rx-symbol { color: #1e293b; }
  .a5-page.tpl-executif .rx-item b { color: #1e293b; }
  .a5-page.tpl-executif .doc-footer { padding: 5mm 12mm; background: #1e293b; color: rgba(255,255,255,.75); font-size: 8.5px; }

  /* ---------- Visibility helpers ---------- */
  .print-hidden { display: none !important; }
  @media print {
    .print-hidden { display: none !important; }
  }

  /* ---------- Print ---------- */
  @media print {
    body { background: #ffffff !important; }
    .a5-page { width: 148mm; min-height: 210mm; padding: 0; margin: 0 auto; box-shadow: none; }
  }
`;