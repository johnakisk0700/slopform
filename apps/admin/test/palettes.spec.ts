import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  AA,
  BADGE_TONE_FLOOR,
  BADGE_TONES,
  contrastRatio,
  deltaE,
  PRIMARY_STATUS_FLOOR,
} from "./colour-metrics";

/**
 * The selectable palettes (`packages/design-tokens/src/palettes.css`).
 *
 * A palette repaints the whole panel for whoever picks it, so each one is held
 * to the same AA floor as the default tokens: the twelve pairs
 * `theme-tokens.spec.ts` asserts, recomputed here per palette per theme. The
 * wiring is asserted too — one id list shared by the CSS, the store, the
 * pre-paint script and the operator menu, because a palette that exists in
 * only three of those four places is either unreachable or a flash of the
 * wrong field.
 *
 * Beyond contrast, this file holds a palette to being LEGIBLE AS A SYSTEM:
 * that its five badge tones can be told apart from one another, that its
 * primary is not mistakable for a status, and that its lit sidebar numeral is
 * the theme's own brand rather than a colour invented for that one spot. Those
 * three went unmeasured in the first cut, and all three were wrong in shipped
 * palettes — see the individual tests.
 */

function readRepoFile(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${relativePath}`, import.meta.url)),
    "utf8",
  );
}

const palettesCss = readRepoFile(
  "../../packages/design-tokens/src/palettes.css",
);
const storeSource = readRepoFile("src/lib/usePalette.ts");
const shellHtml = readRepoFile("index.html");
const menuSource = readRepoFile("src/components/admin/AdminUserMenu.tsx");

/** Every semantic colour token a palette must repaint, both themes. */
const REQUIRED_TOKENS = [
  "--jts-color-canvas",
  "--jts-color-surface",
  "--jts-color-surface-raised",
  "--jts-color-surface-sunken",
  "--jts-color-surface-overlay",
  "--jts-color-surface-strong",
  "--jts-color-border-subtle",
  "--jts-color-border",
  "--jts-color-border-strong",
  "--jts-color-text",
  "--jts-color-text-muted",
  "--jts-color-text-subtle",
  "--jts-color-text-on-strong",
  "--jts-color-text-on-strong-muted",
  "--jts-color-primary",
  "--jts-color-primary-hover",
  "--jts-color-primary-active",
  "--jts-color-primary-contrast",
  "--jts-color-primary-soft",
  "--jts-color-primary-soft-hover",
  "--jts-color-primary-border",
  "--jts-color-accent",
  "--jts-color-accent-soft",
  "--jts-color-link",
  "--jts-color-link-hover",
  "--jts-color-focus",
  "--jts-color-success",
  "--jts-color-success-soft",
  "--jts-color-success-border",
  "--jts-color-warning",
  "--jts-color-warning-soft",
  "--jts-color-warning-border",
  "--jts-color-danger",
  "--jts-color-danger-soft",
  "--jts-color-danger-border",
  "--jts-color-info",
  "--jts-color-info-soft",
  "--jts-color-info-border",
  "--jts-color-highlight",
  "--jts-color-highlight-text",
  // The sidebar is the largest single colour surface on screen, so a palette
  // that leaves it alone does not read as a palette at all.
  "--jts-color-sidebar-active-index",
];

const OVERRIDE_PALETTES = ["graphite", "noir", "amphora", "linen", "iris"];

function paletteBlock(
  id: string,
  theme: "light" | "dark",
): Map<string, string> {
  const selector =
    theme === "light"
      ? `:root[data-palette="${id}"]:not(.dark) {`
      : `:root[data-palette="${id}"].dark {`;
  const open = palettesCss.indexOf(selector);
  expect(open, selector).toBeGreaterThan(-1);
  const start = palettesCss.indexOf("{", open);
  const end = palettesCss.indexOf("}", start);
  const vars = new Map<string, string>();
  for (const match of palettesCss
    .slice(start + 1, end)
    .matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    const name = match[1];
    const value = match[2];
    if (name && value) vars.set(name, value.trim());
  }
  return vars;
}

/** Reads one semantic colour, failing loudly rather than measuring undefined. */
function tone(block: Map<string, string>, role: string): string {
  const value = block.get(`--jts-color-${role}`);
  if (!value) throw new Error(`Missing --jts-color-${role}`);
  return value;
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

describe("palettes.css", () => {
  it("defines every semantic colour token in every palette, both themes, flat", () => {
    for (const id of OVERRIDE_PALETTES) {
      for (const theme of ["light", "dark"] as const) {
        const block = paletteBlock(id, theme);
        for (const token of REQUIRED_TOKENS) {
          expect(block.get(token), `${id}/${theme}/${token}`).toMatch(
            /^#[0-9a-fA-F]{6,8}$/,
          );
        }
      }
    }
  });

  it("gives every palette its own sidebar, in both themes", () => {
    // The first cut of these palettes pinned the wine slab into all of them,
    // and four of the six were indistinguishable where it mattered most: the
    // menu did not change when the theme did. Distinctness is the contract.
    for (const theme of ["light", "dark"] as const) {
      const slabs = OVERRIDE_PALETTES.map(
        (id) => paletteBlock(id, theme).get("--jts-color-surface-strong") ?? "",
      );
      // The house theme's own slab is in tokens.css, so it joins the
      // comparison from there rather than from a palette block.
      const houseTheme = theme === "light" ? "#4a1c2a" : "#3a1826";
      const all = [...slabs, houseTheme];
      expect(new Set(all).size, `${theme}: ${all.join(" ")}`).toBe(all.length);
    }
  });

  it("holds nothing but comments and well-formed rule blocks", () => {
    // A generator once wrote its own success line onto the same stream as the
    // CSS; prettier folded the stray words into the selector list of the first
    // theme, and that theme silently stopped applying while every text-matching
    // assertion still passed. Parse the shape, not just the strings.
    const withoutComments = palettesCss.replace(/\/\*[\s\S]*?\*\//g, "");
    const rules = withoutComments.match(/[^{}]*\{[^{}]*\}/g) ?? [];
    expect(rules.length).toBe(OVERRIDE_PALETTES.length * 2);
    for (const rule of rules) {
      const selector = (rule.split("{")[0] ?? "").trim();
      expect(selector, selector).toMatch(
        /^:root\[data-palette="[\w-]+"\](:not\(\.dark\)|\.dark)$/,
      );
    }
    // Nothing may survive outside a rule but whitespace.
    expect(withoutComments.replace(/[^{}]*\{[^{}]*\}/g, "").trim()).toBe("");
  });

  it("keeps the five badge tones tellable apart, perceptually", () => {
    // These five paint the pills in `FeedbackBadges`, which an operator reads
    // as a COLUMN — the amber and the red are found before a single word is.
    //
    // The previous version of this test compared hex strings, and everything
    // below passed it: noir shipped `#9a5b00` as both its accent and its
    // warning (byte-identical — caught only because `new Set` deduped them),
    // and in dark mode its warning `#d9973a`, accent `#e0a33f` and danger
    // `#f5b25c` sat within ΔE 5.4 of one another, so an error and a warning
    // were the same amber smear. Graphite's dark info and accent were ΔE 3.3
    // apart. Strings cannot see any of that.
    for (const id of OVERRIDE_PALETTES) {
      for (const theme of ["light", "dark"] as const) {
        const block = paletteBlock(id, theme);
        for (let i = 0; i < BADGE_TONES.length; i += 1) {
          for (let j = i + 1; j < BADGE_TONES.length; j += 1) {
            const first = BADGE_TONES[i] ?? "";
            const second = BADGE_TONES[j] ?? "";
            const a = tone(block, first);
            const b = tone(block, second);
            expect(
              deltaE(a, b),
              `${id}/${theme}: ${first} ${a} vs ${second} ${b}`,
            ).toBeGreaterThanOrEqual(BADGE_TONE_FLOOR);
          }
        }
      }
    }
  });

  it("keeps the primary from being read as a status", () => {
    // Graphite's steel primary sat ΔE 7.8 from its own slate info, so a
    // primary button and an informational chip were the same blue-grey.
    for (const id of OVERRIDE_PALETTES) {
      for (const theme of ["light", "dark"] as const) {
        const block = paletteBlock(id, theme);
        const primary = tone(block, "primary");
        for (const status of ["info", "success", "warning", "danger"]) {
          expect(
            deltaE(primary, tone(block, status)),
            `${id}/${theme}: primary ${primary} vs ${status}`,
          ).toBeGreaterThanOrEqual(PRIMARY_STATUS_FLOOR);
        }
      }
    }
  });

  it("gives every theme its own brand colour", () => {
    // The whole reason this pass happened: the first cut kept wine as the
    // primary in every theme, so the field changed and the buttons, the chat
    // bubbles and the progress bars stayed pink whatever was picked.
    for (const theme of ["light", "dark"] as const) {
      const primaries = OVERRIDE_PALETTES.map(
        (id) => paletteBlock(id, theme).get("--jts-color-primary") ?? "",
      );
      const houseTheme = theme === "light" ? "#8f2440" : "#f0a2b1";
      const all = [...primaries, houseTheme];
      expect(new Set(all).size, `${theme}: ${all.join(" ")}`).toBe(all.length);
    }
  });

  it("lights the active numeral with the theme's own brand, not a spot colour", () => {
    // The rule: the numeral is the theme's DARK primary, in BOTH modes.
    //
    // It cannot simply be `--jts-color-primary`, because the sidebar slab is
    // dark in both modes and a light theme's primary is dark ink meant for
    // paper — it would sink into the slab. The dark primary is by construction
    // the same brand hue already tuned to sit on a dark surface, so it is the
    // one value that is both legible there and recognisably the theme.
    //
    // Without this rule every palette invented its own tint and the numeral
    // became the one colour on screen that belonged to nothing: graphite lit
    // `#8dc0e0` over a `#2c5f80` primary and a `#5c6b78` accent, ΔE 28 from
    // the nearest thing it shared a screen with. Half the palettes reached for
    // primary and half for accent, so the motif meant nothing either way.
    // `AdminNavigation`'s drawer variant paints this numeral `text-primary`;
    // the sidebar should not disagree with it.
    for (const id of OVERRIDE_PALETTES) {
      const brand = tone(paletteBlock(id, "dark"), "primary");
      for (const theme of ["light", "dark"] as const) {
        const block = paletteBlock(id, theme);
        expect(
          tone(block, "sidebar-active-index"),
          `${id}/${theme}: numeral must be the dark primary`,
        ).toBe(brand);
        // Small text on the slab, so AA large would not be enough.
        expect(
          contrastRatio(brand, tone(block, "surface-strong")),
          `${id}/${theme}: active numeral on sidebar`,
        ).toBeGreaterThanOrEqual(AA);
      }
    }
  });

  it("keeps the accent usable as label ink, not only as a fill", () => {
    // `FeedbackBadges` once had to spend full-strength ink on its accent pill
    // because copper measured 3.93:1 on surface, which made that one tone the
    // exception in an otherwise uniform set. A tone that cannot carry its own
    // label is not a tone; every palette now clears AA for it.
    for (const id of OVERRIDE_PALETTES) {
      for (const theme of ["light", "dark"] as const) {
        const block = paletteBlock(id, theme);
        expect(
          contrastRatio(tone(block, "accent"), tone(block, "surface")),
          `${id}/${theme}: accent as label ink on surface`,
        ).toBeGreaterThanOrEqual(AA);
      }
    }
  });

  it("keeps every tone readable both tinted and solid", () => {
    // The two shapes `FeedbackBadges` renders: a tinted pill (`text-<tone>` on
    // `bg-<tone>-soft`) and the solid one for the badge an operator must not
    // skim past (`text-canvas` on `bg-<tone>`). tokens.css is held to both for
    // warning alone; a palette repaints all of them, so it answers for all of
    // them. Linen shipped a success fill at 4.45:1 against canvas.
    for (const id of OVERRIDE_PALETTES) {
      for (const theme of ["light", "dark"] as const) {
        const block = paletteBlock(id, theme);
        const canvas = tone(block, "canvas");
        for (const role of BADGE_TONES) {
          const ink = tone(block, role);
          expect(
            contrastRatio(ink, tone(block, `${role}-soft`)),
            `${id}/${theme}: ${role} label on its own tint`,
          ).toBeGreaterThanOrEqual(AA);
          expect(
            contrastRatio(canvas, ink),
            `${id}/${theme}: canvas label on solid ${role}`,
          ).toBeGreaterThanOrEqual(AA);
        }
      }
    }
  });

  it("scopes every light block with :not(.dark) so dark keeps winning", () => {
    for (const id of OVERRIDE_PALETTES) {
      expect(palettesCss).toContain(`:root[data-palette="${id}"]:not(.dark) {`);
      expect(palettesCss).toContain(`:root[data-palette="${id}"].dark {`);
    }
    // A bare light selector would tie with `:root.dark` and win on order.
    expect(palettesCss).not.toMatch(/:root\[data-palette="[\w-]+"\] \{/);
  });

  for (const id of OVERRIDE_PALETTES) {
    it(`keeps every asserted AA pair at or above 4.5:1 (${id})`, () => {
      for (const theme of ["light", "dark"] as const) {
        const block = paletteBlock(id, theme);
        for (const [foreground, background] of PAIRS) {
          const fg = block.get(foreground);
          const bg = block.get(background);
          expect(
            Boolean(fg && bg),
            `${id}/${theme}: ${foreground}/${background}`,
          ).toBe(true);
          if (!fg || !bg) continue;
          expect(
            contrastRatio(fg, bg),
            `${id}/${theme}: ${foreground} on ${background}`,
          ).toBeGreaterThanOrEqual(AA);
        }
      }
    });
  }
});

describe("palette wiring", () => {
  it("keeps the store, the CSS, the pre-paint script and the menu on one id list", () => {
    // The store leads with the default; the CSS carries only the overrides.
    expect(storeSource).toContain('id: "join-the-six"');
    for (const id of OVERRIDE_PALETTES) {
      expect(storeSource, `store: ${id}`).toContain(`id: "${id}"`);
      expect(shellHtml, `pre-paint: ${id}`).toContain(`'${id}'`);
    }
    expect(shellHtml).toContain("jts-palette");
    expect(shellHtml).toContain("'join-the-six'");
    expect(menuSource).toContain("usePalette");
    expect(menuSource).toContain("PALETTES.map");
  });

  it("represents the default palette as the absence of the attribute", () => {
    expect(palettesCss).not.toContain('data-palette="join-the-six"');
    expect(storeSource).toContain("removeAttribute(PALETTE_ATTRIBUTE)");
  });

  it("imports palettes.css after tokens.css in the bridge", () => {
    const globals = readRepoFile("src/styles/globals.css");
    const tokensAt = globals.indexOf("design-tokens/tokens.css");
    const palettesAt = globals.indexOf("design-tokens/palettes.css");
    expect(tokensAt).toBeGreaterThan(-1);
    expect(palettesAt).toBeGreaterThan(tokensAt);
  });
});
