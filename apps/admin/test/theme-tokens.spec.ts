import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Resolves the real design tokens (`packages/design-tokens/src/tokens.css`) for
 * both themes and asserts that the critical text/background pairs clear WCAG AA
 * contrast. Because the tokens are the single source of truth that HeroUI, the
 * Tailwind bridge and hand-written CSS all consume, passing here means the whole
 * admin panel meets AA in light and dark.
 */
const tokensCss = readFileSync(
  fileURLToPath(
    new URL("../../../packages/design-tokens/src/tokens.css", import.meta.url),
  ),
  "utf8",
);

function blockVars(selector: string): Map<string, string> {
  const open = tokensCss.indexOf(`${selector} {`);
  if (open === -1) throw new Error(`Missing token block: ${selector}`);
  const start = tokensCss.indexOf("{", open);
  const end = tokensCss.indexOf("}", start);
  const body = tokensCss.slice(start + 1, end);
  const vars = new Map<string, string>();
  for (const match of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    const name = match[1];
    const value = match[2];
    if (name && value) vars.set(name, value.trim());
  }
  return vars;
}

const lightVars = blockVars(":root");
// Dark only overrides the semantic layer; primitives are inherited from :root.
const darkVars = new Map([...lightVars, ...blockVars(":root.dark")]);

function resolveHex(
  vars: Map<string, string>,
  token: string,
  depth = 0,
): string {
  if (depth > 20) throw new Error(`Token cycle resolving: ${token}`);
  const value = token.trim();

  if (value.startsWith("#")) {
    const hex = value.slice(1);
    const full =
      hex.length === 3
        ? hex
            .split("")
            .map((c) => c + c)
            .join("")
        : hex;
    if (full.length !== 6) throw new Error(`Unexpected hex: ${value}`);
    return `#${full.toLowerCase()}`;
  }

  const ref = /^var\((--[\w-]+)\)$/.exec(value);
  if (ref) {
    const key = ref[1];
    const next = key ? vars.get(key) : undefined;
    if (!next) throw new Error(`Missing token: ${key ?? value}`);
    return resolveHex(vars, next, depth + 1);
  }

  throw new Error(`Cannot resolve "${value}" to a plain hex colour`);
}

function relativeLuminance(hex: string): number {
  const [r = 0, g = 0, b = 0] = (hex.slice(1).match(/.{2}/g) ?? [])
    .map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
    );
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

function contrastRatio(
  vars: Map<string, string>,
  foreground: string,
  background: string,
): number {
  const [high, low] = [
    relativeLuminance(resolveHex(vars, `var(${foreground})`)),
    relativeLuminance(resolveHex(vars, `var(${background})`)),
  ].sort((a, b) => b - a);
  return ((high ?? 0) + 0.05) / ((low ?? 0) + 0.05);
}

// [foreground token, background token, human label]
const pairs: [string, string, string][] = [
  ["--jts-color-text", "--jts-color-surface", "body text on surface"],
  ["--jts-color-text-muted", "--jts-color-surface", "muted text on surface"],
  ["--jts-color-text-subtle", "--jts-color-surface", "caption text on surface"],
  [
    "--jts-color-text-muted",
    "--jts-color-surface-raised",
    "form placeholder on input",
  ],
  [
    "--jts-color-text-on-strong",
    "--jts-color-surface-strong",
    "sidebar text on wine",
  ],
  [
    "--jts-color-primary-contrast",
    "--jts-color-primary",
    "button label on primary",
  ],
  // The solid "Needs attention" pill. HeroUI's primary chip variant pairs
  // `--warning` with `--warning-foreground`, which the bridge maps to these two
  // tokens, so the emphasis the feedback inbox leans on is measured rather than
  // assumed.
  [
    "--jts-color-canvas",
    "--jts-color-warning",
    "attention pill label on solid warning",
  ],
];

describe("design tokens contrast", () => {
  for (const [theme, vars] of [
    ["light", lightVars],
    ["dark", darkVars],
  ] as const) {
    describe(theme, () => {
      it.each(pairs)(
        "keeps %s / %s (%s) at or above AA 4.5:1",
        (foreground, background) => {
          expect(
            contrastRatio(vars, foreground, background),
          ).toBeGreaterThanOrEqual(4.5);
        },
      );
    });
  }
});
