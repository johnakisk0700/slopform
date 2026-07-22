import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveTheme } from "../app/composables/useTheme";

function readWebFile(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${relativePath}`, import.meta.url)),
    "utf8",
  );
}

describe("theme switching", () => {
  it("resolves explicit appearance modes directly", () => {
    expect(resolveTheme("light")).toBe("light");
    expect(resolveTheme("dark")).toBe("dark");
  });

  it("resolves system mode to light without a matching dark media query", () => {
    // In the test environment there is no `prefers-color-scheme: dark`.
    expect(resolveTheme("system")).toBe("light");
  });

  it("drives dark mode from a single class shared by tokens and PrimeVue", () => {
    const theme = readWebFile("app/theme/jts-theme.ts");
    const tokens = readFileSync(
      fileURLToPath(
        new URL(
          "../../../packages/design-tokens/src/tokens.css",
          import.meta.url,
        ),
      ),
      "utf8",
    );

    expect(theme).toContain('darkModeSelector: ".jts-dark"');
    expect(theme).toContain('name: "primevue"');
    expect(tokens).toContain(":root.jts-dark");
  });

  it("applies the saved or system theme before first paint (no flash)", () => {
    const config = readWebFile("nuxt.config.ts");

    expect(config).toContain("localStorage.getItem('jts-theme')");
    expect(config).toContain("classList.toggle('jts-dark',d)");
    expect(config).toContain('tagPosition: "head"');
  });

  it("exposes the appearance control from the user menu", () => {
    const menu = readWebFile("app/components/admin/AdminUserMenu.vue");

    expect(menu).toContain("useTheme()");
    expect(menu).toContain("SelectButton");
    expect(menu).toContain('value: "system"');
  });
});
