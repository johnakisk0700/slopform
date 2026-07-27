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

  // The dark theme builds every `-soft` fill with `color-mix(in srgb, …)`, so
  // without this branch no tinted pairing could be measured at all — the soft
  // chips the feedback inbox labels its notes with would go unasserted in the
  // one theme where they are hardest to get right. `in srgb` interpolates the
  // gamma-encoded channels directly, which is what this reproduces.
  const mix = /^color-mix\(\s*in srgb\s*,([\s\S]+)\)$/.exec(value);
  if (mix) {
    const parts = (mix[1] ?? "").split(",").map((part) => part.trim());
    const [first, second] = parts;
    if (parts.length !== 2 || first === undefined || second === undefined) {
      throw new Error(`Unsupported color-mix: ${value}`);
    }
    const percent = /([\d.]+)%/.exec(first);
    const weight = percent?.[1] === undefined ? 0.5 : Number(percent[1]) / 100;
    const from = resolveHex(
      vars,
      first.replace(/[\d.]+%/, "").trim(),
      depth + 1,
    );
    const onto = resolveHex(vars, second, depth + 1);
    const channels = [0, 1, 2].map((index) => {
      const start = 1 + index * 2;
      const a = Number.parseInt(from.slice(start, start + 2), 16);
      const b = Number.parseInt(onto.slice(start, start + 2), 16);
      return Math.round(a * weight + b * (1 - weight));
    });
    return `#${channels
      .map((channel) => channel.toString(16).padStart(2, "0"))
      .join("")}`;
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
  // The inbox's NEEDS ATTENTION group heading, which is the strip an operator
  // scans for first. It is the same pairing the app-wide warning banner uses,
  // so asserting it covers both.
  [
    "--jts-color-warning",
    "--jts-color-warning-soft",
    "attention group heading on its tint",
  ],
  // The feedback inbox's sunken answer cards and the profile link that opens a
  // respondent, both introduced with the inbox design pass. The OPEN and CLOSED
  // group headings sit on the same fill, at ink and ink-muted respectively.
  ["--jts-color-text", "--jts-color-surface-sunken", "card text on sunken"],
  [
    "--jts-color-text-muted",
    "--jts-color-surface-sunken",
    "card label on sunken",
  ],
  ["--jts-color-primary", "--jts-color-surface", "inline link on surface"],
  // The "Staff note" badge, so a hand-written note can never be mistaken for
  // participant testimony. HeroUI's soft accent chip pairs `--accent-soft-
  // foreground` with `--accent-soft`, which the bridge maps to these two.
  [
    "--jts-color-primary",
    "--jts-color-primary-soft",
    "soft accent chip label on its tint",
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
