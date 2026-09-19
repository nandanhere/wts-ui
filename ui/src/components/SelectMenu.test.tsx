import { render, screen } from "@testing-library/react";
import * as Dialog from "@radix-ui/react-dialog";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { SelectMenu } from "./SelectMenu";

function Example() {
  const [value, setValue] = useState("open");
  return (
    <SelectMenu aria-label="Merge request status" onChange={setValue} value={value}>
      <option value="open">Open</option>
      <option value="merged">Merged</option>
      <option value="closed">Closed</option>
    </SelectMenu>
  );
}

function SearchableExample() {
  const [value, setValue] = useState("open");
  return (
    <SelectMenu
      aria-label="Repository"
      onChange={setValue}
      searchable
      searchPlaceholder="Search repositories"
      value={value}
    >
      <option value="open">nandan.herekar/nimbus-api · main</option>
      <option value="merged">sre-tools/cortex-ui · develop</option>
      <option value="closed">langgenius/dify · main</option>
    </SelectMenu>
  );
}

describe("SelectMenu", () => {
  it("opens a custom listbox and selects an option with the keyboard", async () => {
    const user = userEvent.setup();
    render(<Example />);

    const trigger = screen.getByRole("combobox", { name: "Merge request status" });
    expect(trigger).toHaveTextContent("Open");

    await user.click(trigger);
    expect(screen.getByRole("listbox")).toBeVisible();
    await user.keyboard("{ArrowDown}{Enter}");

    expect(trigger).toHaveTextContent("Merged");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("selects an option from the styled popover with the pointer", async () => {
    const user = userEvent.setup();
    render(<Example />);

    const trigger = screen.getByRole("combobox", {
      name: "Merge request status",
    });
    await user.click(trigger);
    await user.click(screen.getByRole("option", { name: "Closed" }));

    expect(trigger).toHaveTextContent("Closed");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("selects an option with the pointer inside a modal dialog", async () => {
    const user = userEvent.setup();
    render(
      <Dialog.Root open>
        <Dialog.Portal>
          <Dialog.Content aria-describedby={undefined}>
            <Dialog.Title>Status settings</Dialog.Title>
            <Example />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>,
    );

    const trigger = screen.getByRole("combobox", { name: "Merge request status" });
    await user.click(trigger);
    await user.click(screen.getByRole("option", { name: "Closed" }));

    expect(trigger).toHaveTextContent("Closed");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Status settings" })).toBeVisible();
  });

  it("filters while the user types and selects with one click", async () => {
    const user = userEvent.setup();
    render(<SearchableExample />);

    const input = screen.getByRole("combobox", { name: "Repository" });
    await user.click(input);
    await user.clear(input);
    await user.type(input, "cortex");

    expect(screen.getByRole("option", { name: /cortex-ui/i })).toBeVisible();
    expect(screen.queryByRole("option", { name: /nimbus-api/i })).toBeNull();
    await user.click(screen.getByRole("option", { name: /cortex-ui/i }));

    expect(input).toHaveValue("sre-tools/cortex-ui · develop");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});
