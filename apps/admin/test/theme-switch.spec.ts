import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it, vi } from "vitest";

type ThemeMode = "light" | "dark" | "system";
type ResolvedTheme = "light" | "dark";

function readAdminFile(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${relativePath}`, import.meta.url)),
    "utf8",
  );
}

/**
 * `src/lib/useTheme.ts` reaches for window/document/localStorage at import time
 * (it owns the `dark` class on <html>). In vitest's node environment those
 * globals are absent, so we stub a minimal DOM before importing and then
 * unit-test the pure `resolveTheme(mode, systemDark)` logic through the real
 * module export.
 */
let resolveTheme: (mode: ThemeMode, systemDark: boolean) => ResolvedTheme;

beforeAll(async () => {
  const media = { matches: false, addEventListener: () => {} };
  vi.stubGlobal("window", { matchMedia: () => media });
  vi.stubGlobal("matchMedia", () => media);
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
  });
  vi.stubGlobal("document", {
    documentElement: { classList: { toggle: () => {} } },
  });
  // Runtime-only specifier: the theme module lives in the app project (DOM lib);
  // a computed URL keeps it out of this node test project's type program while
  // vitest still loads the real implementation at runtime.
  const moduleUrl = new URL("../src/lib/useTheme.ts", import.meta.url).href;
  const module = (await import(moduleUrl)) as {
    resolveTheme: (mode: ThemeMode, systemDark: boolean) => ResolvedTheme;
  };
  resolveTheme = module.resolveTheme;
});

describe("theme switching", () => {
  it("resolves explicit appearance modes regardless of the system", () => {
    expect(resolveTheme("light", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("dark", true)).toBe("dark");
  });

  it("resolves system mode from the current OS preference", () => {
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("system", true)).toBe("dark");
  });

  it("applies the saved or system theme before first paint (no flash)", () => {
    const html = readAdminFile("index.html");

    expect(html).toContain("localStorage.getItem('jts-theme')");
    expect(html).toContain("classList.toggle('dark',d)");
  });

  it("drives dark mode from a single class shared by tokens, HeroUI and Tailwind", () => {
    const globals = readAdminFile("src/styles/globals.css");
    const tokens = readFileSync(
      fileURLToPath(
        new URL(
          "../../../packages/design-tokens/src/tokens.css",
          import.meta.url,
        ),
      ),
      "utf8",
    );

    expect(globals).toContain("@custom-variant dark");
    expect(globals).toContain("--accent: var(--jts-color-primary);");
    expect(tokens).toContain(":root.dark");
  });

  it("exposes the appearance hook contract from the theme module", () => {
    const module = readAdminFile("src/lib/useTheme.ts");

    expect(module).toContain("export function useTheme");
    expect(module).toContain("export function setThemeMode");
    expect(module).toContain("export const THEME_STORAGE_KEY");
    expect(module).toContain('THEME_STORAGE_KEY = "jts-theme"');
  });
});
