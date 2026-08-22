import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UiCallouts } from "./UiCallouts";

afterEach(() => {
  document.documentElement.removeAttribute("data-ui-debug");
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("UI callouts", () => {
  it("uses pointer coordinates to select an annotated child inside a parent", async () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const child = this.dataset.ui === "spaces.toolbar";
        const left = child ? 60 : 20;
        const top = child ? 60 : 20;
        const width = child ? 100 : 300;
        const height = child ? 60 : 200;
        return {
          bottom: top + height,
          height,
          left,
          right: left + width,
          top,
          width,
          x: left,
          y: top,
          toJSON: () => ({}),
        };
      },
    );

    render(
      <>
        <main
          data-testid="spaces-board"
          data-ui="spaces.board"
          data-ui-label="Spaces board"
        >
          <aside data-ui="spaces.toolbar" data-ui-label="Spaces toolbar">
            <button type="button">Search</button>
          </aside>
        </main>
        <UiCallouts />
      </>,
    );

    fireEvent.keyDown(window, {
      code: "KeyL",
      ctrlKey: true,
      shiftKey: true,
    });

    expect(document.documentElement).toHaveAttribute("data-ui-debug");
    expect(screen.queryByText("Spaces toolbar")).toBeNull();

    fireEvent.pointerMove(screen.getByTestId("spaces-board"), {
      clientX: 80,
      clientY: 80,
    });
    await act(async () => vi.runOnlyPendingTimers());
    expect(screen.getByText("Spaces toolbar")).toBeVisible();
    expect(screen.queryByText("Spaces board")).toBeNull();

    fireEvent.pointerMove(screen.getByTestId("spaces-board"), {
      clientX: 30,
      clientY: 30,
    });
    await act(async () => vi.runOnlyPendingTimers());
    expect(screen.getByText("Spaces board")).toBeVisible();
    expect(screen.queryByText("Spaces toolbar")).toBeNull();

    fireEvent.pointerLeave(document.documentElement);
    expect(screen.getByText("Spaces board")).toBeVisible();
    act(() => vi.advanceTimersByTime(1_200));
    expect(screen.queryByText("Spaces board")).toBeNull();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("ui-callouts-overlay")).toBeNull();
    expect(document.documentElement).not.toHaveAttribute("data-ui-debug");
  });

  it("selects an annotated popup above overlapping page regions", async () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const popup = this.dataset.ui === "workspace-create.dialog";
        const left = popup ? 100 : 0;
        const top = popup ? 100 : 0;
        const width = popup ? 500 : 800;
        const height = popup ? 400 : 600;
        return {
          bottom: top + height,
          height,
          left,
          right: left + width,
          top,
          width,
          x: left,
          y: top,
          toJSON: () => ({}),
        };
      },
    );

    render(
      <>
        <main data-ui="spaces.board" data-ui-label="Spaces board" />
        <UiCallouts />
      </>,
    );
    const popup = document.createElement("section");
    popup.dataset.ui = "workspace-create.dialog";
    popup.dataset.uiLabel = "New workspace dialog";
    const popupButton = document.createElement("button");
    popupButton.textContent = "Continue";
    popup.append(popupButton);
    document.body.append(popup);
    const originalElementsFromPoint = document.elementsFromPoint;
    Object.defineProperty(document, "elementsFromPoint", {
      configurable: true,
      value: vi.fn(() => [popupButton, popup, screen.getByRole("main")]),
    });

    fireEvent.keyDown(window, {
      code: "KeyL",
      metaKey: true,
      shiftKey: true,
    });
    fireEvent.pointerMove(popupButton, { clientX: 180, clientY: 160 });
    await act(async () => vi.runOnlyPendingTimers());

    expect(screen.getByText("New workspace dialog")).toBeVisible();
    expect(screen.queryByText("Spaces board")).toBeNull();
    popup.remove();
    Object.defineProperty(document, "elementsFromPoint", {
      configurable: true,
      value: originalElementsFromPoint,
    });
  });
});
