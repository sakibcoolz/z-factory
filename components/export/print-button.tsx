"use client";

/** Opens the browser's print dialog, where the report can be printed or saved as PDF. */
export function PrintButton() {
  return (
    <button type="button" className="zf-btn" data-variant="primary" onClick={() => window.print()}>
      Print / save as PDF
    </button>
  );
}
