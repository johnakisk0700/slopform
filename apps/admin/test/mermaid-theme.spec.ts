import { describe, expect, it } from "vitest";

import {
  MERMAID_FLOW_ROLES,
  mixHex,
  withMermaidRoleDefs,
} from "../src/lib/mermaidTheme";
import type { MermaidPalette } from "../src/lib/mermaidTheme";

const palette: MermaidPalette = {
  "--jts-color-surface": "#ffffff",
  "--jts-color-surface-sunken": "#f0f0f0",
  "--jts-color-surface-raised": "#fafafa",
  "--jts-color-text": "#111111",
  "--jts-color-text-muted": "#555555",
  "--jts-color-border": "#cccccc",
  "--jts-color-primary": "#661122",
  "--jts-color-primary-soft": "#f0dfe3",
  "--jts-color-accent": "#8a4a1f",
  "--jts-color-success": "#16704a",
  "--jts-color-warning": "#7a5a08",
  "--jts-color-danger": "#b3261e",
  "--jts-color-info": "#4a5966",
};

describe("Mermaid theme helpers", () => {
  it("mixes two hex colours according to the first colour's weight", () => {
    expect(mixHex("#000000", "#ffffff", 1)).toBe("#000000");
    expect(mixHex("#000000", "#ffffff", 0)).toBe("#ffffff");
    expect(mixHex("#000000", "#ffffff", 0.5)).toBe("#808080");
  });

  it("adds role definitions only to flowcharts", () => {
    const flowchart = withMermaidRoleDefs(
      "flowchart LR\n  A:::decision --> B:::ok",
      palette,
    );
    const sequence = withMermaidRoleDefs(
      "sequenceDiagram\n  A->>B: hello",
      palette,
    );

    for (const role of MERMAID_FLOW_ROLES) {
      expect(flowchart).toContain(`classDef ${role} fill:`);
    }
    expect(sequence).not.toContain("classDef");
  });
});
