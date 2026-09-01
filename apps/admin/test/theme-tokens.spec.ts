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
 * Resolves the real design tokens (`packages/design-tokens/src/tokens.css`) for
 * both themes and asserts that the critical text/background pairs clear WCAG AA
 * contrast. Because the tokens are the single source of truth that HeroUI, the
 * Tailwind bridge and hand-written CSS all consume, passing here means the whole
 * admin panel meets AA in light and dark.
 *
 * The house theme also answers to the legibility rules `palettes.spec.ts` holds
 * the five selectable themes to — tone separation and the lit numeral. Those
 * rules describe what makes a set of colours readable as a system, and the
 * default theme is not exempt from being readable.
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

function contrastOf(
  vars: Map<string, string>,
  foreground: string,
  background: string,
): number {
  return contrastRatio(
    resolveHex(vars, `var(${foreground})`),
    resolveHex(vars, `var(${background})`),
  );
}

/** The house theme's own resolved value for one semantic colour. */
function colour(vars: Map<string, string>, role: string): string {
  return resolveHex(vars, `var(--jts-color-${role})`);
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
  ["--jts-color-rose", "--jts-color-rose-soft", "gossip tea label on its tint"],
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
            contrastOf(vars, foreground, background),
          ).toBeGreaterThanOrEqual(AA);
        },
      );
    });
  }
});

describe("house theme legibility", () => {
  for (const [theme, vars] of [
    ["light", lightVars],
    ["dark", darkVars],
  ] as const) {
    describe(theme, () => {
      it("keeps the five badge tones tellable apart", () => {
        // Copper is the tightest value in the file: it sits between the amber
        // warning and the coral danger by definition, so it buys its distance
        // in lightness rather than hue. At its old L*45 it measured ΔE 12.0
        // from danger — on the line. See the primitive's comment.
        for (let i = 0; i < BADGE_TONES.length; i += 1) {
          for (let j = i + 1; j < BADGE_TONES.length; j += 1) {
            const first = BADGE_TONES[i] ?? "";
            const second = BADGE_TONES[j] ?? "";
            const a = colour(vars, first);
            const b = colour(vars, second);
            expect(
              deltaE(a, b),
              `${first} ${a} vs ${second} ${b}`,
            ).toBeGreaterThanOrEqual(BADGE_TONE_FLOOR);
          }
        }
      });

      it("keeps the primary from being read as a status", () => {
        const primary = colour(vars, "primary");
        for (const status of ["info", "success", "warning", "danger"]) {
          expect(
            deltaE(primary, colour(vars, status)),
            `primary ${primary} vs ${status}`,
          ).toBeGreaterThanOrEqual(PRIMARY_STATUS_FLOOR);
        }
      });

      it("keeps every tone readable both tinted and solid", () => {
        const canvas = colour(vars, "canvas");
        for (const role of BADGE_TONES) {
          const ink = colour(vars, role);
          expect(
            contrastRatio(ink, colour(vars, `${role}-soft`)),
            `${role} label on its own tint`,
          ).toBeGreaterThanOrEqual(AA);
          expect(
            contrastRatio(canvas, ink),
            `canvas label on solid ${role}`,
          ).toBeGreaterThanOrEqual(AA);
        }
      });

      it("keeps the accent usable as label ink", () => {
        expect(
          contrastRatio(colour(vars, "accent"), colour(vars, "surface")),
          "accent as label ink on surface",
        ).toBeGreaterThanOrEqual(AA);
      });

      it("keeps rose readable as tea tint and clear of danger and brand", () => {
        const rose = colour(vars, "rose");
        expect(
          contrastRatio(rose, colour(vars, "rose-soft")),
          "rose label on its own tint",
        ).toBeGreaterThanOrEqual(AA);
        expect(
          contrastRatio(colour(vars, "canvas"), rose),
          "canvas label on solid rose",
        ).toBeGreaterThanOrEqual(AA);
        expect(
          deltaE(rose, colour(vars, "danger")),
          `rose ${rose} vs danger`,
        ).toBeGreaterThanOrEqual(PRIMARY_STATUS_FLOOR);
        expect(
          deltaE(rose, colour(vars, "primary")),
          `rose ${rose} vs primary`,
        ).toBeGreaterThanOrEqual(PRIMARY_STATUS_FLOOR);
      });

      it("lights the sidebar numeral with the theme's dark primary", () => {
        // The slab is wine in both modes, so the numeral is the dark primary
        // in both modes — the same rule every palette answers to. Here that
        // value is wine-300, which is why this token needs no dark override.
        const brand = colour(darkVars, "primary");
        expect(colour(vars, "sidebar-active-index")).toBe(brand);
        expect(
          contrastRatio(brand, colour(vars, "surface-strong")),
          "active numeral on the sidebar slab",
        ).toBeGreaterThanOrEqual(AA);
      });
    });
  }
});
