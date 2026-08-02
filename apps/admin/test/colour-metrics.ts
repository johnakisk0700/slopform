/**
 * Colour measurements shared by `theme-tokens.spec.ts` (the house theme, whose
 * values live in tokens.css behind `var()` and `color-mix()`) and
 * `palettes.spec.ts` (the five selectable themes, whose values are flat hexes).
 *
 * Not a `.spec.ts` file, so vitest's `include` leaves it alone.
 *
 * WHY ΔE AND NOT `!==`. The palette suite used to assert that two meanings
 * differed by comparing their hex strings. That passes for `#d9973a` against
 * `#e0a33f` — two ambers no one can tell apart — and it caught noir's accent
 * and warning only because they happened to be byte-identical. Distinctness is
 * a perceptual claim, so it is measured perceptually. CIEDE2000 is the current
 * CIE recommendation and, unlike plain Euclidean Lab distance, it corrects for
 * the eye's poor discrimination in the blues and its sharp discrimination in
 * the neutrals — which is the difference between passing noir and failing it.
 */

/** Just-noticeable difference is ~2.3. These floors are far above it because
 *  a badge is 10px of text seen in peripheral vision, in a column of other
 *  badges, by someone scanning rather than reading. */
export const AA = 4.5;

/** The tones that appear as pills, often in the same row. */
export const BADGE_TONES = [
  "info",
  "success",
  "warning",
  "danger",
  "accent",
] as const;

/** Pill against pill: they are compared side by side, so the bar is high. */
export const BADGE_TONE_FLOOR = 12;

/** Primary is a button, not a pill — it is rarely adjacent to a status, so it
 *  answers to a looser floor. It still has to clear it: «the thing you press»
 *  must never read as «something is wrong». */
export const PRIMARY_STATUS_FLOOR = 10;

function channels(hex: string): [number, number, number] {
  const parts = hex.slice(1, 7).match(/.{2}/g) ?? [];
  const [r = 0, g = 0, b = 0] = parts.map(
    (channel) => Number.parseInt(channel, 16) / 255,
  );
  return [r, g, b];
}

const linearise = (channel: number): number =>
  channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;

export function relativeLuminance(hex: string): number {
  const [r, g, b] = channels(hex).map(linearise) as [number, number, number];
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

export function contrastRatio(foreground: string, background: string): number {
  const [high, low] = [
    relativeLuminance(foreground),
    relativeLuminance(background),
  ].sort((a, b) => b - a);
  return ((high ?? 0) + 0.05) / ((low ?? 0) + 0.05);
}

/** CIELAB (D65, 2°). */
export function lab(hex: string): [number, number, number] {
  const [r, g, b] = channels(hex).map(linearise) as [number, number, number];
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number): number =>
    t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

const rad = (degrees: number): number => (degrees * Math.PI) / 180;

/** CIEDE2000 colour difference. */
export function deltaE(first: string, second: string): number {
  const [l1, a1, b1] = lab(first);
  const [l2, a2, b2] = lab(second);

  const c1 = Math.hypot(a1, b1);
  const c2 = Math.hypot(a2, b2);
  const cBar = (c1 + c2) / 2;
  const g = 0.5 * (1 - Math.sqrt(cBar ** 7 / (cBar ** 7 + 25 ** 7)));

  const aPrime1 = (1 + g) * a1;
  const aPrime2 = (1 + g) * a2;
  const cPrime1 = Math.hypot(aPrime1, b1);
  const cPrime2 = Math.hypot(aPrime2, b2);

  const hue = (b: number, a: number): number => {
    if (b === 0 && a === 0) return 0;
    const degrees = (Math.atan2(b, a) * 180) / Math.PI;
    return degrees < 0 ? degrees + 360 : degrees;
  };
  const hPrime1 = hue(b1, aPrime1);
  const hPrime2 = hue(b2, aPrime2);

  const deltaL = l2 - l1;
  const deltaC = cPrime2 - cPrime1;

  let deltaSmallH = 0;
  if (cPrime1 * cPrime2 !== 0) {
    deltaSmallH = hPrime2 - hPrime1;
    if (deltaSmallH > 180) deltaSmallH -= 360;
    else if (deltaSmallH < -180) deltaSmallH += 360;
  }
  const deltaH =
    2 * Math.sqrt(cPrime1 * cPrime2) * Math.sin(rad(deltaSmallH) / 2);

  const lBar = (l1 + l2) / 2;
  const cPrimeBar = (cPrime1 + cPrime2) / 2;

  let hBar: number;
  if (cPrime1 * cPrime2 === 0) {
    hBar = hPrime1 + hPrime2;
  } else {
    hBar = (hPrime1 + hPrime2) / 2;
    if (Math.abs(hPrime1 - hPrime2) > 180) {
      hBar += hPrime1 + hPrime2 < 360 ? 180 : -180;
    }
  }

  const t =
    1 -
    0.17 * Math.cos(rad(hBar - 30)) +
    0.24 * Math.cos(rad(2 * hBar)) +
    0.32 * Math.cos(rad(3 * hBar + 6)) -
    0.2 * Math.cos(rad(4 * hBar - 63));

  const sL = 1 + (0.015 * (lBar - 50) ** 2) / Math.sqrt(20 + (lBar - 50) ** 2);
  const sC = 1 + 0.045 * cPrimeBar;
  const sH = 1 + 0.015 * cPrimeBar * t;

  const rT =
    -Math.sin(rad(2 * (30 * Math.exp(-(((hBar - 275) / 25) ** 2))))) *
    (2 * Math.sqrt(cPrimeBar ** 7 / (cPrimeBar ** 7 + 25 ** 7)));

  return Math.sqrt(
    (deltaL / sL) ** 2 +
      (deltaC / sC) ** 2 +
      (deltaH / sH) ** 2 +
      rT * (deltaC / sC) * (deltaH / sH),
  );
}
