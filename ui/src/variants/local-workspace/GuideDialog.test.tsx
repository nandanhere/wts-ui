import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { describe, expect, it } from "vitest";
import { GuideDialog } from "./GuideDialog";

function GuideHarness() {
  const [open, setOpen] = useState(false);
  const [create, setCreate] = useState(false);
  return <>
    <button onClick={() => setOpen(true)} type="button">Open guide</button>
    <GuideDialog open={open} onOpenChange={setOpen} onCreateWorkspace={() => setCreate(true)} />
    <Dialog.Root open={create} onOpenChange={setCreate}>
      <Dialog.Portal><Dialog.Content aria-describedby={undefined}>
        <Dialog.Title>New workspace</Dialog.Title><input aria-label="Workspace name" />
      </Dialog.Content></Dialog.Portal>
    </Dialog.Root>
  </>;
}

describe("guide focus", () => {
  it.each(["Escape", "Close guide"])("returns focus to its opener after %s", async (close) => {
    const user = userEvent.setup();
    render(<GuideHarness />);
    const opener = screen.getByRole("button", { name: "Open guide" });
    await user.click(opener);
    expect(screen.getByRole("dialog", { name: "How to use WTS" })).toBeVisible();
    if (close === "Escape") await user.keyboard("{Escape}");
    else await user.click(screen.getByRole("button", { name: close }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "How to use WTS" })).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });

  it("keeps focus inside creation when the guide starts a workspace", async () => {
    const user = userEvent.setup();
    render(<GuideHarness />);
    await user.click(screen.getByRole("button", { name: "Open guide" }));
    await user.click(screen.getByRole("button", { name: "New workspace" }));
    expect(await screen.findByRole("dialog", { name: "New workspace" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Workspace name" })).toHaveFocus();
  });
});
