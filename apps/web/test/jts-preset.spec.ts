import { describe, expect, it } from "vitest";
import JtsPreset from "../app/theme/jts-preset";

/**
 * The preset must not hardcode colours. It maps PrimeVue's semantic slots onto
 * the `--jts-*` design tokens so a single token edit restyles every PrimeVue
 * component in both themes. These tests protect that contract; the concrete
 * colour values (and their contrast) are verified in `theme-tokens.spec.ts`.
 */
interface Scheme {
  primary: { color: string };
  text: { color: string; mutedColor: string };
  content: { background: string };
  formField: { background: string; placeholderColor: string };
}

const theme = JtsPreset as unknown as {
  semantic: { colorScheme: { light: Scheme; dark: Scheme } };
  components: {
    datatable: {
      headerCell: Record<string, string>;
      colorScheme: {
        light: { headerCell: Record<string, string> };
        dark: { headerCell: Record<string, string> };
      };
    };
  };
};

describe("JtsPreset", () => {
  it.each(["light", "dark"] as const)(
    "maps %s semantic colours onto design tokens (no hardcoded role hex)",
    (name) => {
      const scheme = theme.semantic.colorScheme[name];

      expect(scheme.primary.color).toBe("var(--jts-color-primary)");
      expect(scheme.text.color).toBe("var(--jts-color-text)");
      expect(scheme.text.mutedColor).toBe("var(--jts-color-text-muted)");
      expect(scheme.content.background).toBe("var(--jts-color-surface)");
      expect(scheme.formField.background).toBe(
        "var(--jts-color-surface-raised)",
      );
      expect(scheme.formField.placeholderColor).toBe(
        "var(--jts-color-text-muted)",
      );
    },
  );

  it("keeps DataTable header colours scheme-scoped and token-driven", () => {
    const { datatable } = theme.components;

    expect(datatable.headerCell).toMatchObject({ padding: "0.75rem 1rem" });
    expect(datatable.colorScheme.light.headerCell).toEqual({
      background: "var(--jts-color-surface-sunken)",
      color: "var(--jts-color-text-muted)",
    });
    expect(datatable.colorScheme.dark.headerCell).toEqual({
      background: "var(--jts-color-surface-sunken)",
      color: "var(--jts-color-text-muted)",
    });
  });
});
