import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  const media = {
    matches: false,
    addEventListener: () => undefined,
  };
  vi.stubGlobal("window", { matchMedia: () => media });
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => undefined,
  });
  vi.stubGlobal("document", {
    documentElement: { classList: { toggle: () => undefined } },
  });
});

import { resolveTheme, THEME_STORAGE_KEY } from "../src/lib/useTheme";

describe("theme switching", () => {
  it("resolves explicit modes regardless of the system preference", () => {
    expect(resolveTheme("light", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("dark", true)).toBe("dark");
  });

  it("resolves system mode from the current OS preference", () => {
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("system", true)).toBe("dark");
  });

  it("uses the documented storage key for the preference", () => {
    expect(THEME_STORAGE_KEY).toBe("jts-theme");
  });
});
