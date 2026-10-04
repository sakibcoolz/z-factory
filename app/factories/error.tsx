"use client";

import { AppShell } from "@/components/shell/app-shell";
import { Content, EditorTabs } from "@/components/shell/editor";

type FactoriesErrorProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

/** Shown when a factory screen fails on the server. The cause stays in the server log. */
export default function FactoriesError({ error, reset }: FactoriesErrorProps) {
  return (
    <AppShell title="Z-FACTORY" activity="factories" status={{ tone: "flt", left: ["⊗ error"] }}>
      <EditorTabs tabs={[{ label: "Factories", active: true }]} />
      <Content plain>
        <div role="alert">
          <div className="zf-k">Factories</div>
          <h1 className="zf-h mt-1.5">Factories could not be loaded</h1>
          <p className="zf-sub mt-1.5 max-w-90">
            The server could not complete the request. Check that the database is running, then try again.
            {error.digest ? ` Reference: ${error.digest}` : ""}
          </p>
        </div>
        <div>
          <button type="button" className="zf-btn" data-variant="primary" onClick={reset}>
            Try again
          </button>
        </div>
      </Content>
    </AppShell>
  );
}
