import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * The package's own build-time guard: it refuses to publish tokens that are
 * structurally broken.
 *
 * Scope, deliberately: PRESENCE AND SHAPE, not colour science. Whether a
 * palette's tones can be told apart, and whether each pairing clears AA, is
 * measured in `apps/admin/test/{theme-tokens,palettes}.spec.ts`, which own the
 * CIEDE2000 and contrast maths. Reimplementing that here would put the floors
 * in two places and let them drift. What this file catches is the class of
 * mistake that would otherwise ship silently from inside this package: a new
 * palette missing half its tokens, a block that never applies, or a numeral
 * that belongs to no theme.
 */

const read = async (relative) =>
  readFile(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const tokensCss = await read("../src/tokens.css");
const palettesCss = await read("../src/palettes.css");

const failures = [];

/* ---- tokens.css: the tokens every consumer assumes exist ---- */

const requiredTokens = [
  "--jts-color-canvas",
  "--jts-color-surface",
  "--jts-color-surface-strong",
  "--jts-color-text",
  "--jts-color-text-on-strong",
  "--jts-color-primary",
  "--jts-color-focus",
  "--jts-color-sidebar-active-index",
  "--jts-font-sans",
  "--jts-font-display",
  "--jts-space-4",
  "--jts-radius-md",
];

for (const token of requiredTokens) {
  if (!tokensCss.includes(`${token}:`)) {
    failures.push(`tokens.css is missing ${token}`);
  }
}

/* ---- palettes.css: every theme repaints the whole semantic colour layer ---- */

/**
 * A palette that defines only some of these is not a lighter-touch palette —
 * it is a palette with the previous theme showing through the gaps, because
 * the unset tokens keep whatever tokens.css left in the cascade.
 */
const requiredPaletteTokens = [
  "canvas",
  "surface",
  "surface-raised",
  "surface-sunken",
  "surface-overlay",
  "surface-strong",
  "border-subtle",
  "border",
  "border-strong",
  "text",
  "text-muted",
  "text-subtle",
  "text-on-strong",
  "text-on-strong-muted",
  "primary",
  "primary-hover",
  "primary-active",
  "primary-contrast",
  "primary-soft",
  "primary-soft-hover",
  "primary-border",
  "accent",
  "accent-soft",
  "link",
  "link-hover",
  "focus",
  "success",
  "success-soft",
  "success-border",
  "warning",
  "warning-soft",
  "warning-border",
  "danger",
  "danger-soft",
  "danger-border",
  "info",
  "info-soft",
  "info-border",
  "highlight",
  "highlight-text",
  "sidebar-active-index",
].map((role) => `--jts-color-${role}`);

const blocks = new Map();
const ruleShape = /([^{}]*)\{([^{}]*)\}/g;
const withoutComments = palettesCss.replace(/\/\*[\s\S]*?\*\//g, "");

for (const [, rawSelector, body] of withoutComments.matchAll(ruleShape)) {
  const selector = rawSelector.trim();
  const parsed =
    /^:root\[data-palette="([\w-]+)"\](:not\(\.dark\)|\.dark)$/.exec(selector);
  if (!parsed) {
    failures.push(`palettes.css has an unexpected selector: ${selector}`);
    continue;
  }
  const [, id, mode] = parsed;
  const declarations = new Map();
  for (const [, name, value] of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    declarations.set(name, value.trim());
  }
  blocks.set(`${id}/${mode === ".dark" ? "dark" : "light"}`, declarations);
}

// Anything outside a rule would have been folded into the next selector by the
// formatter — which is how a generator's stray success line once silently
// disabled a whole theme while every text search still found its tokens.
const stray = withoutComments.replace(ruleShape, "").trim();
if (stray) {
  failures.push(
    `palettes.css has content outside any rule: ${stray.slice(0, 60)}`,
  );
}

const ids = [...new Set([...blocks.keys()].map((key) => key.split("/")[0]))];

for (const id of ids) {
  for (const mode of ["light", "dark"]) {
    const declarations = blocks.get(`${id}/${mode}`);
    if (!declarations) {
      failures.push(`palettes.css: ${id} has no ${mode} block`);
      continue;
    }
    for (const token of requiredPaletteTokens) {
      const value = declarations.get(token);
      if (!value) {
        failures.push(`palettes.css: ${id}/${mode} is missing ${token}`);
      } else if (!/^#[0-9a-f]{6}([0-9a-f]{2})?$/.test(value)) {
        // Flat resolved hexes only: a theme is a finished coat of paint, not a
        // second token graph. A `var()` here would resolve against whatever
        // tokens.css holds and quietly follow the house theme.
        failures.push(
          `palettes.css: ${id}/${mode} ${token} is not a flat hex (${value})`,
        );
      }
    }
  }

  // The one cross-token rule cheap enough to state without colour maths, and
  // the easiest to get wrong when adding a palette: the lit sidebar numeral is
  // the theme's dark primary, in both modes.
  const brand = blocks.get(`${id}/dark`)?.get("--jts-color-primary");
  for (const mode of ["light", "dark"]) {
    const numeral = blocks
      .get(`${id}/${mode}`)
      ?.get("--jts-color-sidebar-active-index");
    if (brand && numeral && numeral !== brand) {
      failures.push(
        `palettes.css: ${id}/${mode} numeral ${numeral} is not the dark primary ${brand}`,
      );
    }
  }
}

if (failures.length > 0) {
  throw new Error(
    `Design token verification failed:\n  - ${failures.join("\n  - ")}`,
  );
}
