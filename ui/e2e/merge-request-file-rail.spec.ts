import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

test("scrolls a long MR file list without moving its parent", async ({ page }) => {
  const fileRailStylesheet = await readFile(
    resolve(
      process.cwd(),
      "src/variants/local-workspace/MergeRequestWorkingChanges.module.css",
    ),
    "utf8",
  );
  const rows = Array.from(
    { length: 24 },
    (_, index) => `
      <button class="fileRow" type="button">
        <span class="fileName">
          <b>file-${index + 1}.go</b>
          <small>internal/apis</small>
        </span>
      </button>`,
  ).join("");

  await page.setViewportSize({ width: 1_440, height: 846 });
  await page.setContent(`
    <style>
      html, body { margin: 0; }
      .outer { width: 1440px; height: 520px; overflow-y: auto; }
      .fixture { display: flex; height: 520px; }
      .after { height: 520px; }
      ${fileRailStylesheet}
    </style>
    <div class="outer" data-testid="outer-scroll">
      <div class="fixture">
        <section class="comparison">
          <div class="layout">
            <nav class="files" aria-label="MR and local files">
              <div class="filesHeader"><strong>Files</strong><span>24</span></div>
              <label class="fileSearch"><input aria-label="Find file" /></label>
              <div class="fileList">${rows}</div>
            </nav>
            <main class="fileContent"></main>
          </div>
        </section>
      </div>
      <div class="after"></div>
    </div>
  `);

  const fileList = page.locator(".fileList");
  const outer = page.getByTestId("outer-scroll");
  const dimensions = await fileList.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight);

  await fileList.hover();
  await page.mouse.wheel(0, 120);
  await expect
    .poll(() => fileList.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await expect(outer).toHaveJSProperty("scrollTop", 0);

  await fileList.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await fileList.hover();
  await page.mouse.wheel(0, 240);
  await expect(outer).toHaveJSProperty("scrollTop", 0);
});
