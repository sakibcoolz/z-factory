import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { OperationState } from "@/lib/plc/operation-state";
import { type OperationButton, OperationForm } from "./operation-form";

const buttons: OperationButton[] = [
  { operation: "start", label: "Start", pendingLabel: "Starting…", variant: "primary" },
  { operation: "stop", label: "Stop", pendingLabel: "Stopping…", disabled: true, title: "The runtime is not running." },
  { operation: "remove", label: "Remove runtime", pendingLabel: "Removing…", confirm: "Remove the runtime of PLC-01?" },
];

function setup(result: OperationState | Promise<OperationState>) {
  const action = vi.fn(async (_state: OperationState, formData: FormData) => {
    void formData;
    return result;
  });
  render(
    <OperationForm label="Runtime operations" action={action} buttons={buttons} pendingHint="This can take minutes." />,
  );
  const operations = () => action.mock.calls.map(([, formData]) => formData.get("operation"));
  return { action, operations };
}

describe("OperationForm", () => {
  it("submits the pressed operation and announces what happened", async () => {
    const { operations } = setup({ notice: "The runtime is started: running." });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(await screen.findByText("The runtime is started: running.")).toBeInTheDocument();
    expect(operations()).toEqual(["start"]);
    expect(screen.getByRole("status")).toContainElement(screen.getByText("The runtime is started: running."));
  });

  it("shows why an operation failed", async () => {
    setup({ message: "The Docker Engine is not reachable." });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(await screen.findByText("The Docker Engine is not reachable.")).toBeInTheDocument();
  });

  it("keeps every button disabled and says what is happening while an operation runs", async () => {
    let finish: (state: OperationState) => void = () => undefined;
    const { operations } = setup(new Promise<OperationState>((resolve) => (finish = resolve)));
    fireEvent.click(screen.getByRole("button", { name: "Start" }));

    expect(await screen.findByRole("button", { name: /Starting…/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove runtime" })).toBeDisabled();
    expect(screen.getByText("This can take minutes.")).toBeInTheDocument();

    finish({ notice: "Done." });
    expect(await screen.findByText("Done.")).toBeInTheDocument();
    expect(screen.queryByText("This can take minutes.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start" })).toBeEnabled();
    expect(operations()).toEqual(["start"]);
  });

  it("asks before a confirmed operation and runs it only on the second press", async () => {
    const { action, operations } = setup({ notice: "The runtime is removed." });
    fireEvent.click(screen.getByRole("button", { name: "Remove runtime" }));
    expect(screen.getByText("Remove the runtime of PLC-01?")).toBeInTheDocument();
    expect(action).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Confirm: remove runtime" }));
    expect(await screen.findByText("The runtime is removed.")).toBeInTheDocument();
    expect(operations()).toEqual(["remove"]);
    // The button asks again next time.
    expect(screen.getByRole("button", { name: "Remove runtime" })).toBeInTheDocument();
  });

  it("drops the question when the operation is not confirmed", async () => {
    const { action } = setup({ notice: "never" });
    fireEvent.click(screen.getByRole("button", { name: "Remove runtime" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    await waitFor(() => expect(screen.queryByText("Remove the runtime of PLC-01?")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Remove runtime" })).toBeInTheDocument();
    expect(action).not.toHaveBeenCalled();
  });

  it("explains a disabled operation and does not run it", async () => {
    const { action } = setup({ notice: "never" });
    const stop = screen.getByRole("button", { name: "Stop" });
    expect(stop).toBeDisabled();
    expect(stop).toHaveAttribute("title", "The runtime is not running.");
    fireEvent.click(stop);
    expect(action).not.toHaveBeenCalled();
  });
});
