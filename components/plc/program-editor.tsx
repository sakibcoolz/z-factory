"use client";

import { useActionState, useRef, useState } from "react";
import { EMPTY_OPERATION_STATE, type OperationState, type ProgramDiagnostic } from "@/lib/plc/operation-state";

type ProgramEditorProps = {
  /** Server action; `intent` is the pressed button: `check`, `save` or `deploy`. */
  action: (state: OperationState, formData: FormData) => Promise<OperationState>;
  /** Source the editor opens with. */
  source: string;
  /** Stored version the source belongs to; null for a starter program that was never saved. */
  sourceVersion: number | null;
  /** Deploying needs a started runtime. */
  runtimeCreated: boolean;
  maxSourceBytes: number;
};

const PENDING_LABEL: Record<string, string> = {
  check: "Compiling…",
  save: "Saving…",
  deploy: "Deploying…",
};

/** Character offset of a 1-based line and column in the source. */
function offsetOf(source: string, line: number, column: number): number {
  const lines = source.split("\n");
  const before = lines.slice(0, Math.max(0, line - 1)).reduce((sum, text) => sum + text.length + 1, 0);
  return Math.min(source.length, before + Math.max(0, column - 1));
}

/**
 * 2i — Structured Text editor of a stored PLC: edit, check (compile only), save a
 * version, or save and deploy. Compiler findings are listed with their position; a
 * finding moves the cursor there.
 */
export function ProgramEditor({ action, source, sourceVersion, runtimeCreated, maxSourceBytes }: ProgramEditorProps) {
  const [state, formAction, pending] = useActionState(action, EMPTY_OPERATION_STATE);
  const [text, setText] = useState(source);
  const [intent, setIntent] = useState<string>();
  // The stored version the text was last equal to; a save or deploy makes the current text that version.
  const [stored, setStored] = useState({ version: sourceVersion, text: sourceVersion === null ? null : source });
  // The text the running action was given; typing goes on while it runs.
  const [submitted, setSubmitted] = useState(source);
  const [seenState, setSeenState] = useState(state);
  const textarea = useRef<HTMLTextAreaElement>(null);

  if (state !== seenState) {
    setSeenState(state);
    if (state.savedVersion !== undefined) setStored({ version: state.savedVersion, text: submitted });
  }

  const lineCount = text.split("\n").length;
  const dirty = stored.text !== text;
  const origin =
    stored.version === null
      ? "starter program, not saved"
      : dirty
        ? `based on v${stored.version} · ● unsaved changes`
        : `v${stored.version}`;
  const tooLarge = new Blob([text]).size > maxSourceBytes;
  const diagnostics: readonly ProgramDiagnostic[] = state.diagnostics ?? [];

  const goTo = (diagnostic: ProgramDiagnostic) => {
    const element = textarea.current;
    if (!element) return;
    const offset = offsetOf(text, diagnostic.line, diagnostic.column);
    element.focus();
    element.setSelectionRange(offset, offset);
  };

  const button = (value: string, label: string, variant: string, disabled = false, title?: string) => (
    <button
      type="submit"
      name="intent"
      value={value}
      className="zf-btn"
      data-variant={variant}
      data-size="sm"
      disabled={pending || disabled}
      title={title}
      onClick={() => {
        setIntent(value);
        setSubmitted(text);
      }}
    >
      {pending && intent === value ? PENDING_LABEL[value] : label}
    </button>
  );

  return (
    <form action={formAction} className="flex min-h-0 flex-1 flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="zf-k mr-auto">{`IEC 61131-3 · Structured Text · ${origin}`}</span>
        {button("check", "Check", "ghost", tooLarge)}
        {button("save", "Save version", "default", tooLarge || !dirty)}
        {button(
          "deploy",
          dirty ? "Save & deploy" : "Deploy",
          "primary",
          tooLarge || !runtimeCreated,
          runtimeCreated ? undefined : "Start the runtime first (Runtime section).",
        )}
      </div>
      <div className="zf-source">
        <pre className="zf-source-no" aria-hidden="true">
          {Array.from({ length: lineCount }, (_, index) => index + 1).join("\n")}
        </pre>
        <textarea
          ref={textarea}
          name="sourceText"
          aria-label="Program source"
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={lineCount}
          wrap="off"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
      </div>
      <div role="status" aria-live="polite" className="flex flex-col gap-1">
        {tooLarge ? <p className="zf-error">The program is larger than a PLC program may be.</p> : null}
        {pending && intent === "deploy" ? (
          <p className="zf-sub">The runtime builds the program before it runs it. This can take a minute.</p>
        ) : null}
        {!pending && state.message ? <p className="zf-error whitespace-normal">{state.message}</p> : null}
        {!pending && state.notice ? <p className="zf-notice whitespace-normal">{state.notice}</p> : null}
      </div>
      {!pending && diagnostics.length > 0 ? (
        <section aria-label="Problems" className="zf-cell" data-flush="true">
          <h3 className="zf-cell-head">{`Problems · ${diagnostics.length}`}</h3>
          <div className="zf-log">
            {diagnostics.map((diagnostic, index) => (
              <button key={index} type="button" className="zf-problem" onClick={() => goTo(diagnostic)}>
                <span className="zf-log-ts">{`Ln ${diagnostic.line}, Col ${diagnostic.column}`}</span>
                <span className="zf-log-lv" data-level={diagnostic.severity === "error" ? "crit" : "warn"}>
                  {diagnostic.severity}
                </span>
                <span className="whitespace-normal">{diagnostic.message}</span>
              </button>
            ))}
          </div>
        </section>
      ) : null}
    </form>
  );
}
