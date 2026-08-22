import { expect, test } from "@playwright/test";

test("keeps workspace controls usable and chrome contained at responsive widths", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Search spaces" }).click();

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 768, height: 1024 },
    { width: 320, height: 800 },
  ]) {
    await page.setViewportSize(viewport);

    const spacesButton = page.getByRole("button", { name: "Open Spaces" });
    const myTimeButton = page.getByRole("button", { name: "My time" });
    const newWorkspaceButton = page.getByRole("button", {
      name: "New workspace",
    });
    const search = page.getByRole("searchbox", {
      name: "Search local workspaces",
    });

    await expect(spacesButton).toBeVisible();
    await expect(myTimeButton).toBeVisible();
    await expect(newWorkspaceButton).toBeVisible();
    await expect(search).toBeVisible();

    const [headerBox, spacesButtonBox, myTimeButtonBox, searchBox] =
      await Promise.all([
        page.getByRole("banner").boundingBox(),
        spacesButton.boundingBox(),
        myTimeButton.boundingBox(),
        search.boundingBox(),
      ]);

    expect(headerBox).not.toBeNull();
    expect(spacesButtonBox).not.toBeNull();
    expect(myTimeButtonBox).not.toBeNull();
    expect(searchBox).not.toBeNull();
    expect(spacesButtonBox!.height).toBeGreaterThanOrEqual(28);
    expect(spacesButtonBox!.height).toBeLessThanOrEqual(36);
    expect(myTimeButtonBox!.height).toBeGreaterThanOrEqual(32);
    expect(myTimeButtonBox!.height).toBeLessThanOrEqual(44);
    expect(searchBox!.height).toBeGreaterThanOrEqual(28);
    expect(searchBox!.height).toBeLessThanOrEqual(44);
    expect(spacesButtonBox!.y).toBeGreaterThanOrEqual(headerBox!.y);
    expect(spacesButtonBox!.y + spacesButtonBox!.height).toBeLessThanOrEqual(
      headerBox!.y + headerBox!.height,
    );

    const horizontalGeometry = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(horizontalGeometry.scrollWidth).toBe(horizontalGeometry.clientWidth);
  }
});

test("keeps compact workflow controls and primary actions visually distinct", async ({
  page,
}) => {
  await page.goto("/");
  await page.setViewportSize({ width: 1440, height: 900 });

  await expect(
    page.getByRole("button", { name: "New workspace" }),
  ).toHaveCount(1);

  await page.getByRole("button", { name: "New workspace" }).click();
  const dialog = page.getByRole("dialog", { name: "New workspace" });
  await expect(
    dialog.getByText("Choose at least one local repository to continue."),
  ).toBeVisible();

  const jira = dialog.getByRole("radio", { name: "Jira" });
  const importButton = dialog.getByRole("button", { name: "Import" });
  const review = dialog.getByRole("button", { name: "Review repositories" });
  const [jiraBox, importBox, reviewBox] = await Promise.all([
    jira.boundingBox(),
    importButton.boundingBox(),
    review.boundingBox(),
  ]);

  expect(jiraBox!.height).toBeGreaterThanOrEqual(26);
  expect(jiraBox!.height).toBeLessThanOrEqual(28);
  expect(importBox!.height).toBeGreaterThanOrEqual(26);
  expect(importBox!.height).toBeLessThanOrEqual(28);
  expect(reviewBox!.height).toBeGreaterThanOrEqual(43);
  expect(reviewBox!.height).toBeLessThanOrEqual(45);
  await expect(review).toBeDisabled();

  await dialog.getByRole("button", { name: "Close new workspace" }).click();
  await page
    .getByRole("button", {
      name: "Open Environment and integrations",
      exact: true,
    })
    .click();

  const settings = page.getByRole("dialog", {
    name: "Environment & integrations",
  });
  const verify = settings.getByRole("button", { name: "Verify all" });
  await expect(verify).toBeVisible();
  await expect(verify).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(verify).toHaveCSS("background-color", "rgb(11, 99, 206)");

  await settings
    .getByRole("tab", { name: "General Local behavior" })
    .click();
  await settings
    .getByRole("radio", {
      name: "Dark Low-glare surfaces for terminals and focused sessions.",
    })
    .check({ force: true });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(verify).toHaveCSS("color", "rgb(7, 26, 46)");
  await expect(verify).toHaveCSS("background-color", "rgb(105, 173, 255)");

  await settings
    .getByRole("radio", {
      name: "Light Bright surfaces for daylight and high ambient light.",
    })
    .check({ force: true });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});
