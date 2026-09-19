import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UiCallouts } from "./UiCallouts";

afterEach(() => {
  document.documentElement.removeAttribute("data-ui-debug");
  document.documentElement.removeAttribute("data-ui-region-picker");
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Option region picker", () => {
  const listeners: Array<() => void> = [];
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
      x: 20, y: 30, left: 20, top: 30, right: 320, bottom: 230, width: 300, height: 200,
      toJSON: () => ({}),
    }));
  });
  afterEach(() => { listeners.splice(0).forEach((remove) => remove()); });

  function listen() {
    const listener = vi.fn();
    window.addEventListener("wts:ui-region-selected", listener);
    listeners.push(() => window.removeEventListener("wts:ui-region-selected", listener));
    return listener;
  }

  it("selects the focused region with Option-Enter without activating its button", () => {
    const listener = listen(); const onClick = vi.fn();
    render(<><section data-ui="spaces.toolbar" data-ui-label="Spaces toolbar"><button onClick={onClick}>Create workspace</button></section><UiCallouts /></>);
    const button = screen.getByRole("button", { name: "Create workspace" }); button.focus();
    expect(fireEvent.keyDown(button, { key: "Enter", code: "Enter", altKey: true })).toBe(false);
    expect(listener).toHaveBeenCalledOnce(); expect(listener.mock.calls[0][0].detail.id).toBe("spaces.toolbar");
    expect(onClick).not.toHaveBeenCalled();
    expect(document.documentElement).not.toHaveAttribute("data-ui-region-picker");
  });

  it("keeps Option-Enter available to text fields and AltGraph input", () => {
    const listener = listen();
    render(<><section data-ui="spaces.toolbar" data-ui-label="Spaces toolbar"><input aria-label="Workspace name" /></section><UiCallouts /></>);
    const input = screen.getByRole("textbox"); input.focus();
    expect(fireEvent.keyDown(input, { key: "Enter", altKey: true })).toBe(true);
    expect(fireEvent.keyDown(window, { key: "Enter", altKey: true, ctrlKey: true })).toBe(true);
    expect(listener).not.toHaveBeenCalled();
  });

  it("selects a region with Option-click and prevents the normal pointer and click actions", async () => {
    const onPointerDown = vi.fn();
    const onClick = vi.fn();
    const listener = listen();
    render(<><main data-ui="spaces.board" data-ui-label="Spaces board"><section data-ui="spaces.toolbar" data-ui-label="Spaces toolbar"><button onPointerDown={onPointerDown} onClick={onClick}>Create workspace</button></section></main><UiCallouts /></>);
    const button = screen.getByRole("button", { name: "Create workspace" });
    fireEvent.keyDown(window, { key: "Alt", code: "AltLeft", altKey: true });
    fireEvent.pointerMove(button, { clientX: 50, clientY: 60, altKey: true });
    await act(async () => vi.runOnlyPendingTimers());
    expect(document.documentElement).toHaveAttribute("data-ui-region-picker");
    expect(screen.getByText("Spaces toolbar")).toBeVisible();
    fireEvent.pointerDown(button, { clientX: 50, clientY: 60, altKey: true, button: 0 });
    fireEvent.click(button, { clientX: 50, clientY: 60, altKey: true, button: 0 });
    expect(onPointerDown).not.toHaveBeenCalled();
    expect(onClick).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledOnce();
    expect((listener.mock.calls[0]![0] as CustomEvent).detail).toMatchObject({
      schemaVersion: 1, id: "spaces.toolbar", label: "Spaces toolbar", route: expect.any(String),
      rect: { x: 20, y: 30, width: 300, height: 200 },
      visibleText: "Create workspace", ancestors: [{ id: "spaces.board", label: "Spaces board" }],
      captureAllowed: true,
    });
  });

  it.each(["release", "blur", "Escape"])("clears the picker on %s and permits a normal click", (reset) => {
    const onClick = vi.fn();
    const listener = listen();
    render(<><section data-ui="spaces.toolbar" data-ui-label="Spaces toolbar"><button onClick={onClick}>Create workspace</button></section><UiCallouts /></>);
    fireEvent.keyDown(window, { key: "Alt", code: "AltLeft", altKey: true });
    expect(document.documentElement).toHaveAttribute("data-ui-region-picker");
    if (reset === "release") fireEvent.keyUp(window, { key: "Alt", code: "AltLeft" });
    else if (reset === "blur") fireEvent.blur(window);
    else fireEvent.keyDown(window, { key: "Escape", altKey: true });
    expect(document.documentElement).not.toHaveAttribute("data-ui-region-picker");
    fireEvent.click(screen.getByRole("button"), { clientX: 50, clientY: 60 });
    expect(onClick).toHaveBeenCalledOnce();
    expect(listener).not.toHaveBeenCalled();
  });

  it("keeps Option typing and AltGraph outside the picker", () => {
    const onClick = vi.fn();
    const listener = listen();
    render(<><section data-ui="spaces.toolbar" data-ui-label="Spaces toolbar"><input aria-label="Workspace name" onClick={onClick} /></section><UiCallouts /></>);
    const input = screen.getByRole("textbox");
    input.focus();
    expect(fireEvent.keyDown(input, { key: "Alt", code: "AltLeft", altKey: true })).toBe(true);
    fireEvent.click(input, { clientX: 50, clientY: 60, altKey: true });
    expect(onClick).toHaveBeenCalledOnce();
    expect(document.documentElement).not.toHaveAttribute("data-ui-region-picker");
    input.blur();
    fireEvent.keyUp(window, { key: "Alt" });
    fireEvent.keyDown(window, { key: "AltGraph", code: "AltRight", altKey: true, ctrlKey: true });
    expect(listener).not.toHaveBeenCalled();
    expect(document.documentElement).not.toHaveAttribute("data-ui-region-picker");
  });

  it("captures visible context without field values, hidden text, private regions, or arbitrary data", () => {
    const listener = listen();
    render(<><section data-ui="workspace.summary" data-ui-label="Workspace summary" data-token="secret-dataset"><p>Visible status</p><p hidden>Hidden secret</p><p style={{ display: "none" }}>CSS secret</p><input type="password" defaultValue="secret-password" /><textarea defaultValue="secret-draft" /><div contentEditable suppressContentEditableWarning>secret-editor</div><div data-ui-context="exclude">secret-chat</div><details><summary>Details</summary><p>Closed secret</p></details><button disabled>Run checks</button></section><UiCallouts /></>);
    fireEvent.keyDown(window, { key: "Alt", code: "AltLeft", altKey: true });
    fireEvent.click(screen.getByText("Visible status"), { clientX: 50, clientY: 60, altKey: true });
    expect(listener).toHaveBeenCalledOnce();
    const selection = (listener.mock.calls[0]![0] as CustomEvent).detail;
    expect(selection.visibleText).toContain("Visible status");
    expect(JSON.stringify(selection)).not.toMatch(/secret|Hidden|Closed/);
    expect(selection.controls).toContainEqual({ role: "button", label: "Run checks", disabled: true });
    expect(selection.captureAllowed).toBe(false);
  });

  it("removes the picker overlay before notifying the chat listener", () => {
    const listener = vi.fn(() => expect(screen.queryByTestId("ui-callouts-overlay")).not.toBeInTheDocument());
    window.addEventListener("wts:ui-region-selected", listener);
    listeners.push(() => window.removeEventListener("wts:ui-region-selected", listener));
    render(<><section data-ui="spaces.toolbar" data-ui-label="Spaces toolbar">Toolbar content</section><UiCallouts /></>);
    fireEvent.keyDown(window, { key: "Alt", code: "AltLeft", altKey: true });
    fireEvent.click(screen.getByText("Toolbar content"), { clientX: 50, clientY: 60, altKey: true });
    expect(listener).toHaveBeenCalledOnce();
  });

  it("does not activate a control when Option is released between pointer down and click", () => {
    const listener = listen();
    const onClick = vi.fn();
    render(<><section data-ui="spaces.toolbar" data-ui-label="Spaces toolbar"><button onClick={onClick}>Remove workspace</button></section><UiCallouts /></>);
    const button = screen.getByRole("button");
    fireEvent.keyDown(window, { key: "Alt", altKey: true });
    fireEvent.pointerDown(button, { clientX: 50, clientY: 60, altKey: true, button: 0 });
    fireEvent.keyUp(window, { key: "Alt" });
    fireEvent.click(button, { clientX: 50, clientY: 60, button: 0 });
    expect(onClick).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    fireEvent.pointerDown(button, { clientX: 50, clientY: 60, button: 0 });
    fireEvent.click(button, { clientX: 50, clientY: 60, button: 0 });
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("keeps excluded chat controls usable while Option is held", () => {
    const listener = listen();
    const onClick = vi.fn();
    render(<><main data-ui="spaces.board" data-ui-label="Spaces board"><aside data-ui-context="exclude"><button onClick={onClick}>Chat history</button></aside></main><UiCallouts /></>);
    fireEvent.keyDown(window, { key: "Alt", altKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Chat history" }), { clientX: 50, clientY: 60, altKey: true });
    expect(onClick).toHaveBeenCalledOnce();
    expect(listener).not.toHaveBeenCalled();
  });

  it("bounds context and clips the selected region to the viewport", () => {
    const listener = listen();
    render(<><section data-ui="workspace.summary" data-ui-label="Workspace summary">{Array.from({ length: 30 }, (_, index) => <button key={index}>Action {index}</button>)}<p>{"visible ".repeat(2_000)}</p></section><UiCallouts /></>);
    const region = screen.getByText("visible ".repeat(2_000).trim()).parentElement!;
    vi.spyOn(region, "getBoundingClientRect").mockReturnValue({ x: -20, y: -30, left: -20, top: -30, width: 500, height: 400, right: 480, bottom: 370, toJSON: () => ({}) });
    fireEvent.keyDown(window, { key: "Alt", altKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Action 0" }), { clientX: 50, clientY: 60, altKey: true });
    const selection = (listener.mock.calls[0]![0] as CustomEvent).detail;
    expect(selection.visibleText.length).toBeLessThanOrEqual(6_000);
    expect(selection.controls).toHaveLength(24);
    expect(selection.rect).toEqual({ x: 0, y: 0, width: 480, height: 370 });
  });

  it("captures visible content inside an open shadow root", () => {
    const listener = listen();
    render(<><section data-ui="workspace.diff" data-ui-label="Workspace diff"><div data-testid="code-host" /></section><UiCallouts /></>);
    screen.getByTestId("code-host").attachShadow({ mode: "open" }).innerHTML = "<pre>const retryLimit = 5;</pre><input value='private-value'>";
    fireEvent.keyDown(window, { key: "Alt", altKey: true });
    fireEvent.click(screen.getByTestId("code-host"), { clientX: 50, clientY: 60, altKey: true });
    const selection = (listener.mock.calls[0]![0] as CustomEvent).detail;
    expect(selection.visibleText).toBe("const retryLimit = 5;");
    expect(JSON.stringify(selection)).not.toContain("private-value");
    expect(selection.captureAllowed).toBe(false);
  });

  it("blocks screenshots when a private overlay overlaps the selected crop", () => {
    const listener = listen();
    render(<><section data-ui="workspace.summary" data-ui-label="Workspace summary">Visible summary</section><aside data-ui-context="exclude">Private conversation</aside><UiCallouts /></>);
    fireEvent.keyDown(window, { key: "Alt", altKey: true });
    fireEvent.click(screen.getByText("Visible summary"), { clientX: 50, clientY: 60, altKey: true });
    const selection = (listener.mock.calls[0]![0] as CustomEvent).detail;
    expect(selection.captureAllowed).toBe(false);
    expect(selection.visibleText).toBe("Visible summary");
  });

  it("omits custom textbox values from context and disables its screenshot", () => {
    const listener = listen();
    render(<><section data-ui="workspace.summary" data-ui-label="Workspace summary"><p>Visible summary</p><div role="textbox">private-textbox-value</div></section><UiCallouts /></>);
    fireEvent.keyDown(window, { key: "Alt", altKey: true });
    fireEvent.click(screen.getByText("Visible summary"), { clientX: 50, clientY: 60, altKey: true });
    const selection = (listener.mock.calls[0]![0] as CustomEvent).detail;
    expect(selection.captureAllowed).toBe(false);
    expect(JSON.stringify(selection)).not.toContain("private-textbox-value");
  });
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
    expect(
      screen.getByText("Hover over a region. Say its name or ID to Codex."),
    ).toBeVisible();

    fireEvent.pointerMove(screen.getByTestId("spaces-board"), {
      clientX: 80,
      clientY: 80,
    });
    await act(async () => vi.runOnlyPendingTimers());
    expect(screen.getByText("Spaces toolbar")).toBeVisible();
    expect(screen.getByText("spaces.toolbar")).toBeVisible();
    expect(screen.queryByText("Spaces board")).toBeNull();

    fireEvent.pointerMove(screen.getByTestId("spaces-board"), {
      clientX: 30,
      clientY: 30,
    });
    await act(async () => vi.runOnlyPendingTimers());
    expect(screen.getByText("Spaces board")).toBeVisible();
    expect(screen.getByText("spaces.board")).toBeVisible();
    expect(screen.queryByText("spaces.toolbar")).toBeNull();
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
