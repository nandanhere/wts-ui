import { writeFile } from "node:fs/promises";
import { documentIdForPath, expect, mountPlanning, test, workspaceId } from "./fixtures/planningDocuments";

for (const width of [1440, 375]) {
  test(`nested planning folders preserve file identity at ${width}px`, async ({ page, planningOrigin }, testInfo) => {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
    const fixture = await mountPlanning(page, planningOrigin);
    const files = page.getByRole("navigation", { name: "Planning files", exact: true });
    const file = (path: string) => files.getByRole("button", { name: path, exact: true });
    const checkoutPlan = ".todo/checkout/PLAN.md";
    const checkoutKanban = ".todo/checkout/KANBAN.md";
    const reportingPlan = ".todo/reporting/PLAN.md";
    const reportingKanban = ".todo/reporting/KANBAN.md";
    const documentRequest = (path: string) => `/api/v1/workspaces/${workspaceId}/planning/documents/${documentIdForPath(path)}`;
    try {
      await expect(page.getByRole("heading", { name: "Workspace plan", exact: true })).toBeVisible();
      for (const path of [checkoutPlan, checkoutKanban, reportingPlan, reportingKanban]) await expect(file(path)).toBeVisible();
      for (const folder of [".todo", ".todo/checkout", ".todo/reporting"]) {
        await expect(files.getByRole("button", { name: `Collapse ${folder} folder`, exact: true })).toHaveAttribute("aria-expanded", "true");
      }
      await file(checkoutPlan).click();
      await expect(page.getByRole("heading", { name: "Checkout plan", exact: true })).toBeVisible();
      await expect(file(checkoutPlan)).toHaveAttribute("aria-current", "page");
      await expect(page.locator('[data-ui="planning.document-toolbar"]')).toContainText(checkoutPlan);
      expect(fixture.requests.filter(request => request.method === "GET" && request.path.endsWith("/planning/documents/" + documentIdForPath(checkoutPlan))).length).toBeGreaterThan(0);
      const layout = await page.evaluate(() => ({
        width: document.documentElement.scrollWidth,
        overflow: [...document.querySelectorAll("*")].flatMap(element => {
          const rect = element.getBoundingClientRect();
          return rect.right > innerWidth + 1 ? [{ tag: element.tagName, className: element.getAttribute("class"), label: element.getAttribute("aria-label"), right: rect.right }] : [];
        }),
      }));
      await testInfo.attach("planning-layout.json", { body: JSON.stringify(layout, null, 2), contentType: "application/json" });
      expect(layout.width, JSON.stringify(layout.overflow)).toBe(width);
      const geometry = await files.getByRole("button").evaluateAll(elements => elements.map(element => {
        const rect = element.getBoundingClientRect();
        return { name: element.getAttribute("aria-label"), x: rect.x, right: rect.right, fontSize: Number.parseFloat(getComputedStyle(element).fontSize) };
      }));
      for (const control of geometry) {
        expect(control.x, `${control.name} starts inside the viewport`).toBeGreaterThanOrEqual(0);
        expect(control.right, `${control.name} ends inside the viewport`).toBeLessThanOrEqual(width);
        expect(control.fontSize, `${control.name} has readable text`).toBeGreaterThanOrEqual(12);
      }
      await page.screenshot({ animations: "disabled", fullPage: true, path: testInfo.outputPath(`nested-planning-${width}.png`) });

      await files.getByRole("button", { name: "Collapse .todo/checkout folder", exact: true }).click();
      await expect(file(checkoutPlan)).toHaveCount(0);
      await expect(file(reportingPlan)).toBeVisible();
      const search = page.getByRole("searchbox", { name: "Search planning files", exact: true });
      await search.fill(".todo/checkout/KANBAN.md");
      await expect(file(checkoutKanban)).toBeVisible();
      await expect(file(reportingKanban)).toHaveCount(0);
      await search.clear();
      await expect(files.getByRole("button", { name: "Expand .todo/checkout folder", exact: true })).toBeVisible();
      await expect(file(checkoutKanban)).toHaveCount(0);
      await search.fill(".todo/checkout/KANBAN.md");
      await file(checkoutKanban).click();
      await expect(page.getByRole("heading", { name: "Checkout Kanban", exact: true })).toBeVisible();
      await search.clear();
      await expect(files.getByRole("button", { name: "Collapse .todo/checkout folder", exact: true })).toBeVisible();
      await file(checkoutPlan).click();

      await page.getByRole("button", { name: "Checkout Kanban", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Checkout Kanban", exact: true })).toBeVisible();
      await expect(file(checkoutKanban)).toHaveAttribute("aria-current", "page");
      await page.getByRole("button", { name: "Checkout plan", exact: true }).click();
      await page.getByRole("button", { name: "Reporting plan", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Reporting plan", exact: true })).toBeVisible();
      await expect(file(reportingPlan)).toHaveAttribute("aria-current", "page");

      const original = fixture.documents.get(documentIdForPath(reportingPlan))!;
      const savedContents = "# Reporting plan\n\nThe export totals now include retry checks.\n";
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      await page.getByRole("textbox", { name: `Edit ${reportingPlan}`, exact: true }).fill(savedContents);
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByText("The export totals now include retry checks.", { exact: true })).toBeVisible();
      expect(fixture.requests.filter(request => request.method !== "GET")).toEqual([
        { method: "PUT", path: documentRequest(reportingPlan), body: { expectedSha256: original.sha256, contents: savedContents } },
      ]);
      expect(fixture.documents.get("plan")!.contents).toContain("# Workspace plan");
      expect(fixture.documents.get(documentIdForPath(checkoutPlan))!.contents).toContain("Keep checkout retries safe.");
      await file(checkoutPlan).click();
      await file(reportingPlan).click();
      await expect(page.getByText("The export totals now include retry checks.", { exact: true })).toBeVisible();
      await expect(page.locator('[data-ui="planning.document-toolbar"]')).toContainText(reportingPlan);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      await page.screenshot({ animations: "disabled", fullPage: true, path: testInfo.outputPath(`nested-planning-saved-${width}.png`) });
      expect(fixture.blocked).toEqual([]);
      expect(fixture.errors).toEqual([]);
    } finally {
      const path = testInfo.outputPath("planning-http-evidence.json");
      await writeFile(path, JSON.stringify({ conditions: "Real planning panel and HTTP client. All API requests use in-memory fixture data. Only known fixture document IDs accept a save. External requests and other writes are blocked.", width, requests: fixture.requests, blocked: fixture.blocked, errors: fixture.errors }, null, 2));
      await testInfo.attach("planning-http-evidence.json", { path, contentType: "application/json" });
    }
  });
}
