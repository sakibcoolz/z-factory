import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { OperationState } from "@/lib/plc/operation-state";
import { ProgramEditor } from "./program-editor";

const SOURCE = "PROGRAM main\n  VAR\n    A : BOOL;\n  END_VAR\n  A := TRUE;\nEND_PROGRAM\n";

function setup(result: OperationState, props: Partial<Parameters<typeof ProgramEditor>[0]> = {}) {
  const action = vi.fn(async (_state: OperationState, formData: FormData) => {
    void formData;
    return result;
  });
  render(
    <ProgramEditor
      action={action}
      source={SOURCE}
      sourceVersion={1}
      runtimeCreated
      maxSourceBytes={1024 * 1024}
      {...props}
    />,
  );
  const submitted = () =>
    action.mock.calls.map(([, formData]) => ({ intent: formData.get("intent"), source: formData.get("sourceText") }));
  return { action, submitted, textarea: screen.getByLabelText<HTMLTextAreaElement>("Program source") };
}

describe("ProgramEditor", () => {
  it("opens a stored version unchanged: nothing to save, deploy offered", () => {
    const { textarea } = setup({});
    expect(textarea.value).toBe(SOURCE);
    expect(screen.getByText("IEC 61131-3 · Structured Text · v1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save version" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Deploy" })).toBeEnabled();
    // One line number per line of source.
    expect(textarea.rows).toBe(SOURCE.split("\n").length);
  });

  it("marks edits as unsaved and saves them as a new version", async () => {
    const { textarea, submitted } = setup({ notice: "Saved as version 2.", savedVersion: 2 });
    fireEvent.change(textarea, { target: { value: `${SOURCE}(* note *)` } });
    expect(screen.getByText(/based on v1 · ● unsaved changes/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save & deploy" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save version" }));
    expect(await screen.findByText("Saved as version 2.")).toBeInTheDocument();
    expect(submitted()).toEqual([{ intent: "save", source: `${SOURCE}(* note *)` }]);
    // The text is now what version 2 holds.
    expect(screen.getByText("IEC 61131-3 · Structured Text · v2")).toBeInTheDocument();
    expect(textarea.value).toBe(`${SOURCE}(* note *)`);
    expect(screen.getByRole("button", { name: "Save version" })).toBeDisabled();
  });

  it("offers a starter program for saving", () => {
    setup({}, { sourceVersion: null });
    expect(screen.getByText(/starter program, not saved/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save version" })).toBeEnabled();
  });

  it("lists compiler findings with their position and moves the cursor to one", async () => {
    const { textarea, submitted } = setup({
      message: "The program does not compile.",
      diagnostics: [
        { message: "Undeclared variable 'B'", line: 5, column: 3, severity: "error" },
        { message: "Unused variable 'A'", line: 3, column: 5, severity: "warning" },
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    expect(await screen.findByText("The program does not compile.")).toBeInTheDocument();
    expect(submitted()).toEqual([{ intent: "check", source: SOURCE }]);
    expect(screen.getByRole("region", { name: "Problems" })).toHaveTextContent("Problems · 2");
    // Checking saves nothing: the editor still shows version 1.
    expect(screen.getByText("IEC 61131-3 · Structured Text · v1")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Ln 5, Col 3/ }));
    expect(textarea).toHaveFocus();
    expect(SOURCE.slice(0, textarea.selectionStart).split("\n")).toHaveLength(5);
    expect(SOURCE.slice(textarea.selectionStart, textarea.selectionStart + 9)).toBe("A := TRUE");
  });

  it("does not offer deploying before the runtime exists, and says why", () => {
    setup({}, { runtimeCreated: false });
    const deploy = screen.getByRole("button", { name: "Deploy" });
    expect(deploy).toBeDisabled();
    expect(deploy).toHaveAttribute("title", "Start the runtime first (Runtime section).");
  });

  it("refuses a program beyond the size limit before it is sent", () => {
    setup({}, { maxSourceBytes: 16 });
    expect(screen.getByText("The program is larger than a PLC program may be.")).toBeInTheDocument();
    for (const name of ["Check", "Save version", "Deploy"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
  });
});
