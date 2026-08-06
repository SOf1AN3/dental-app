"use client";

/**
 * Toolbar shown above the A5 print sheet.
 *
 * The sheet stylesheet hides `.print-hidden` globally (screen + print). This
 * toolbar re-enables itself on screen with a higher-specificity rule and hides
 * itself again inside `@media print`, so it only disappears when printing.
 */
export function PrintToolbar() {
  return (
    <div className="print-controls print-hidden">
      <button type="button" onClick={() => window.print()} className="print-btn">
        Imprimer / PDF
      </button>
      <button type="button" onClick={() => window.close()} className="close-btn">
        Fermer
      </button>
      <style>{`
        .print-controls {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 12px;
          padding: 16px;
          background: #f3f4f6;
          border-bottom: 1px solid #d1d5db;
          position: sticky;
          top: 0;
          z-index: 50;
        }
        /* Override the global .print-hidden rule so the toolbar shows on screen. */
        .print-controls.print-hidden {
          display: flex !important;
        }
        .print-btn,
        .close-btn {
          padding: 8px 24px;
          margin: 0 6px;
          border: none;
          border-radius: 6px;
          font-size: 14px;
          cursor: pointer;
          font-weight: 500;
          font-family: inherit;
        }
        .print-btn {
          background: #1e2a5a;
          color: #ffffff;
        }
        .print-btn:hover {
          background: #2a3f8a;
        }
        .close-btn {
          background: #e5e7eb;
          color: #374151;
        }
        .close-btn:hover {
          background: #d1d5db;
        }
        @media print {
          .print-controls,
          .print-controls.print-hidden {
            display: none !important;
          }
        }
      `}</style>
    </div>
  );
}
