import { describe, expect, it } from "vitest";
import JtsPreset from "../app/theme/jts-preset";

interface ColorScheme {
  surface: Record<string, string>;
  formField: {
    background: string;
    placeholderColor: string;
  };
}

interface ThemeUnderTest {
  primitive: {
    warm: Record<string, string>;
  };
  semantic: {
    colorScheme: {
      light: ColorScheme;
      dark: ColorScheme;
    };
  };
  components: {
    datatable: {
      headerCell: Record<string, string>;
      colorScheme: {
        light: { headerCell: Record<string, string> };
        dark: { headerCell: Record<string, string> };
      };
    };
  };
}

const theme = JtsPreset as unknown as ThemeUnderTest;

function resolveColor(scheme: ColorScheme, token: string): string {
  if (token.startsWith("#")) return token;

  const match = /^\{(surface|warm)\.(\d+)}$/.exec(token);
  if (!match) throw new Error(`Unsupported color token: ${token}`);

  const [, namespace, scale] = match;
  const value =
    namespace === "surface"
      ? scheme.surface[scale]
      : theme.primitive.warm[scale];

  if (!value) throw new Error(`Missing color token: ${token}`);
  return resolveColor(scheme, value);
}

function relativeLuminance(hex: string): number {
  const channels = hex
    .slice(1)
    .match(/.{2}/g)
    ?.map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
    );

  if (!channels || channels.length !== 3) {
    throw new Error(`Expected a six-digit hex color, received: ${hex}`);
  }

  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrastRatio(foreground: string, background: string): number {
  const luminances = [
    relativeLuminance(foreground),
    relativeLuminance(background),
  ].sort((left, right) => right - left);

  return (luminances[0] + 0.05) / (luminances[1] + 0.05);
}

describe("JtsPreset", () => {
  it.each(["light", "dark"] as const)(
    "keeps %s form placeholders above normal-text AA contrast",
    (name) => {
      const scheme = theme.semantic.colorScheme[name];
      const placeholder = resolveColor(
        scheme,
        scheme.formField.placeholderColor,
      );
      const background = resolveColor(scheme, scheme.formField.background);

      expect(contrastRatio(placeholder, background)).toBeGreaterThanOrEqual(
        4.5,
      );
    },
  );

  it("keeps DataTable header colors inside their matching scheme", () => {
    expect(theme.components.datatable.headerCell).toMatchObject({
      padding: "0.75rem 1rem",
    });
    expect(theme.components.datatable.colorScheme.light.headerCell).toEqual({
      background: "{surface.100}",
      color: "{surface.700}",
    });
    expect(theme.components.datatable.colorScheme.dark.headerCell).toEqual({
      background: "{surface.800}",
      color: "{surface.200}",
    });
  });
});
