import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

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

  it("keeps the meanings inside a theme tellable apart", () => {
    // Noir shipped its single hue as both «the button you press» and «this
    // wants a human», which made a primary action and a warning the same
    // colour. One theme may be monochrome; it may not be ambiguous.
    for (const id of OVERRIDE_PALETTES) {
      for (const theme of ["light", "dark"] as const) {
        const block = paletteBlock(id, theme);
        const roles = ["primary", "success", "warning", "danger", "info"];
        const values = roles.map((role) => block.get(`--jts-color-${role}`));
        expect(
          new Set(values).size,
          `${id}/${theme}: ${roles.join("/")} = ${values.join(" ")}`,
        ).toBe(roles.length);
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

  it("relights the active numeral with the slab it sits on", () => {
    for (const id of OVERRIDE_PALETTES) {
      for (const theme of ["light", "dark"] as const) {
        const block = paletteBlock(id, theme);
        const numeral = block.get("--jts-color-sidebar-active-index");
        const slab = block.get("--jts-color-surface-strong");
        expect(numeral, `${id}/${theme}`).toBeDefined();
        expect(slab, `${id}/${theme}`).toBeDefined();
        if (!numeral || !slab) continue;
        // Small text on the slab: AA large would not be enough.
        expect(
          contrast(numeral, slab),
          `${id}/${theme}: active numeral on sidebar`,
        ).toBeGreaterThanOrEqual(4.5);
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
            contrast(fg, bg),
            `${id}/${theme}: ${foreground} on ${background}`,
          ).toBeGreaterThanOrEqual(4.5);
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
