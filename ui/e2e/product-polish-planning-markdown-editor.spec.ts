import { documentIdForPath, expect, mountPlanning, test, workspaceId } from "./fixtures/planningDocuments";

// The Markdown edit mode must look like the preview, keep the file layout, and save Markdown.
test("planning files open in a formatted Markdown editor that saves only the changed text", async ({ page, planningOrigin }, testInfo) => {
  const fixture = await mountPlanning(page, planningOrigin);
  const path = ".todo/checkout/KANBAN.md";
  const files = page.getByRole("navigation", { name: "Planning files", exact: true });
  await files.getByRole("button", { name: path, exact: true }).click();
  await expect(page.getByRole("heading", { name: "Orders Kanban", exact: true })).toBeVisible();
  const original = fixture.documents.get(documentIdForPath(path))!;

  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const modes = page.getByRole("group", { name: "Edit mode" });
  await expect(modes.getByRole("button", { name: "Markdown", exact: true })).toHaveAttribute("aria-pressed", "true");
  const editor = page.getByRole("textbox", { name: `Edit ${path}`, exact: true });
  await expect(editor).toHaveAttribute("contenteditable", "true");
  await expect(editor.getByRole("heading", { name: "Orders Kanban" })).toBeVisible();
  await expect(editor.getByRole("checkbox")).toHaveCount(2);
  await expect(page.getByRole("toolbar", { name: "Formatting" })).toBeVisible();

  await editor.getByRole("heading", { name: "Orders Kanban" }).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" v2");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Owner: billing team.");

  const layout = await page.evaluate(() => {
    const shell = document.querySelector('[data-edit-mode="markdown"]')!.getBoundingClientRect();
    const toolbar = document.querySelector('[data-ui="planning.rich-toolbar"]')!.getBoundingClientRect();
    return { width: document.documentElement.scrollWidth, viewport: innerWidth, toolbarInside: toolbar.left >= shell.left - 1 && toolbar.right <= shell.right + 1 };
  });
  expect(layout.width, "The editor adds no page scroll.").toBe(layout.viewport);
  expect(layout.toolbarInside, "The formatting toolbar stays inside the editor.").toBe(true);
  await page.screenshot({ animations: "disabled", path: testInfo.outputPath("planning-markdown-editor.png") });

  await modes.getByRole("button", { name: "Source", exact: true }).click();
  const expected = original.contents.replace("# Orders Kanban\n", "# Orders Kanban v2\n\nOwner: billing team.\n");
  await expect(page.getByRole("textbox", { name: `Edit ${path}`, exact: true })).toHaveValue(expected);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Orders Kanban v2", exact: true })).toBeVisible();
  expect(fixture.requests.filter(request => request.method === "PUT")).toEqual([
    { method: "PUT", path: `/api/v1/workspaces/${workspaceId}/planning/documents/${documentIdForPath(path)}`, body: { expectedSha256: original.sha256, contents: expected } },
  ]);
  expect(fixture.blocked).toEqual([]);
  expect(fixture.errors).toEqual([]);
});
