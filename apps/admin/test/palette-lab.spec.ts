import { beforeAll, describe, expect, it } from "vitest";

/**
 * The palette lab exists to audition palettes, and an audition of an
 * inaccessible panel would be a trap: whichever candidate wins becomes the
 * real tokens. So every candidate is held to the same AA floor as
 * `theme-tokens.spec.ts` holds the shipped tokens — the same twelve pairs,
 * both themes, recomputed here from the candidate's own flat values.
 *
 * As in the other feature specs, the real module is loaded through a computed
 * URL so it stays out of this node project's type program while vitest still
 * exercises the shipped implementation.
 */

interface TestCandidate {
  id: string;
  label: string;
  note: string;
  tokens: {
    light: Record<string, string>;
    dark: Record<string, string>;
  };
}

interface PaletteLabModule {
  PALETTE_LAB_TOKENS: readonly string[];
  PALETTE_CANDIDATES: readonly TestCandidate[];
  paletteLabOverrides: (
    candidateId: string | null,
    isDark: boolean,
  ) => Record<string, string> | null;
}

async function loadModule<T>(relativePath: string): Promise<T> {
  const moduleUrl = new URL(`../${relativePath}`, import.meta.url).href;
  return (await import(moduleUrl)) as T;
}

let lab: PaletteLabModule;

beforeAll(async () => {
  lab = await loadModule<PaletteLabModule>(
    "src/features/cookbook/paletteLab.ts",
  );
});

function luminance(hex: string): number {
  const [r = 0, g = 0, b = 0] = (hex.slice(1, 7).match(/.{2}/g) ?? [])
    .map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
    );
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

function contrast(foreground: string, background: string): number {
  const [high, low] = [luminance(foreground), luminance(background)].sort(
    (a, b) => b - a,
  );
  return ((high ?? 0) + 0.05) / ((low ?? 0) + 0.05);
}

// The same pairings theme-tokens.spec.ts asserts against tokens.css.
const PAIRS: [string, string][] = [
  ["--jts-color-text", "--jts-color-surface"],
  ["--jts-color-text-muted", "--jts-color-surface"],
  ["--jts-color-text-subtle", "--jts-color-surface"],
  ["--jts-color-text-muted", "--jts-color-surface-raised"],
  ["--jts-color-text-on-strong", "--jts-color-surface-strong"],
  ["--jts-color-primary-contrast", "--jts-color-primary"],
  ["--jts-color-canvas", "--jts-color-warning"],
  ["--jts-color-warning", "--jts-color-warning-soft"],
  ["--jts-color-text", "--jts-color-surface-sunken"],
  ["--jts-color-text-muted", "--jts-color-surface-sunken"],
  ["--jts-color-primary", "--jts-color-surface"],
  ["--jts-color-primary", "--jts-color-primary-soft"],
];

describe("palette lab candidates", () => {
  it("carries the boosted set plus the researched systems, ids unique", () => {
    expect(lab.PALETTE_CANDIDATES.length).toBeGreaterThanOrEqual(4);
    const ids = lab.PALETTE_CANDIDATES.map((candidate) => candidate.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("defines every lab token in every candidate, both themes", () => {
    for (const candidate of lab.PALETTE_CANDIDATES) {
      for (const theme of ["light", "dark"] as const) {
        for (const token of lab.PALETTE_LAB_TOKENS) {
          expect(
            candidate.tokens[theme][token],
            `${candidate.id}/${theme}/${token}`,
          ).toMatch(/^#[0-9a-fA-F]{6,8}$/);
        }
      }
    }
  });

  it("keeps every asserted AA pair at or above 4.5:1, both themes", () => {
    for (const candidate of lab.PALETTE_CANDIDATES) {
      for (const theme of ["light", "dark"] as const) {
        const tokens = candidate.tokens[theme];
        for (const [foreground, background] of PAIRS) {
          const fg = tokens[foreground];
          const bg = tokens[background];
          expect(fg, `${candidate.id}/${theme}/${foreground}`).toBeDefined();
          expect(bg, `${candidate.id}/${theme}/${background}`).toBeDefined();
          if (!fg || !bg) continue;
          expect(
            contrast(fg, bg),
            `${candidate.id}/${theme}: ${foreground} on ${background}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });
});

describe("paletteLabOverrides", () => {
  it("returns the matching theme half for a known id", () => {
    const first = lab.PALETTE_CANDIDATES[0];
    expect(first).toBeDefined();
    if (!first) return;
    expect(lab.paletteLabOverrides(first.id, false)).toBe(first.tokens.light);
    expect(lab.paletteLabOverrides(first.id, true)).toBe(first.tokens.dark);
  });

  it("returns null for no selection and for an unknown id", () => {
    expect(lab.paletteLabOverrides(null, false)).toBeNull();
    expect(lab.paletteLabOverrides("no-such-palette", true)).toBeNull();
  });
});
