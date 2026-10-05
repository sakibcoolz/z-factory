/** Shown while the report is built. It replaces the application's loading shell: this page has none. */
export default function ReportLoading() {
  return (
    <main className="zf-report-page" aria-busy="true">
      <p className="zf-k">Preparing the engineering report…</p>
    </main>
  );
}
