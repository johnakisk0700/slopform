import { beforeAll, describe, expect, it } from "vitest";

/**
 * Source-module imports must stay dynamic: `tsconfig.node` has no DOM lib, and
 * `mermaidTheme.ts` reads `document` / canvas at resolve time.
 */
type MermaidThemeModule = {
  MERMAID_FLOW_ROLES: readonly string[];
  mixHex: (a: string, b: string, weight: number) => string;
  withMermaidRoleDefs: (
    chart: string,
    palette: Record<string, string>,
  ) => string;
};

const stubPalette = {
  "--jts-color-surface": "#f5f0eb",
  "--jts-color-surface-sunken": "#ebe4dc",
  "--jts-color-surface-raised": "#fffaf5",
  "--jts-color-text": "#2a1a20",
  "--jts-color-text-muted": "#6b5560",
  "--jts-color-border": "#d4c4b8",
  "--jts-color-primary": "#6b2d3e",
  "--jts-color-primary-soft": "#f0dce2",
  "--jts-color-accent": "#b86b3d",
  "--jts-color-success": "#3d6b4f",
  "--jts-color-warning": "#b8860b",
  "--jts-color-danger": "#b54a3a",
  "--jts-color-info": "#5a6b7a",
};

let theme: MermaidThemeModule;

beforeAll(async () => {
  theme = (await import(
    new URL("../src/lib/mermaidTheme.ts", import.meta.url).href
  )) as MermaidThemeModule;
});

describe("mermaidTheme", () => {
  it("mixes hex colours toward the second stop", () => {
    expect(theme.mixHex("#000000", "#ffffff", 1)).toBe("#000000");
    expect(theme.mixHex("#000000", "#ffffff", 0)).toBe("#ffffff");
    expect(theme.mixHex("#000000", "#ffffff", 0.5)).toBe("#808080");
  });

  it("injects role classDefs only for flowcharts", () => {
    const flowchart = theme.withMermaidRoleDefs(
      `flowchart LR\n  A["Start"]:::ok --> B["End"]:::risk`,
      stubPalette,
    );
    for (const role of theme.MERMAID_FLOW_ROLES) {
      expect(flowchart).toContain(`classDef ${role} fill:`);
    }

    const sequence = theme.withMermaidRoleDefs(
      `sequenceDiagram\n  A->>B: hi`,
      stubPalette,
    );
    expect(sequence).not.toContain("classDef");
  });
});
