import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Mermaid desktop runtime contract", () => {
  it("does not freeze Object.prototype before Mermaid imports", () => {
    const config = JSON.parse(
      readFileSync(resolve(process.cwd(), "../src-tauri/tauri.conf.json"), "utf8"),
    ) as {
      app?: { security?: { freezePrototype?: boolean } };
    };

    expect(config.app?.security?.freezePrototype).toBe(false);
  });
});
