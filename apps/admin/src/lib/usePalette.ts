import { useSyncExternalStore } from "react";

/**
 * Palette state for the admin panel — the second and last appearance axis.
 *
 * `useTheme` owns dark; this store owns which field is painted, via the
 * `data-palette` attribute on <html>. The two never mix: a palette carries a
 * light and a dark half in `palettes.css`, and the `dark` class alone decides
 * which half applies. House Wine is the default palette — `tokens.css` itself —
 * and is represented by the ABSENCE of the attribute, so with storage empty or
 * unavailable the panel is exactly what tokens.css says.
 *
 * The pre-paint script in `index.html` stamps the stored attribute before
 * first paint, mirroring the theme script; this store owns it afterwards.
 */
export const PALETTE_STORAGE_KEY = "jts-palette";

export interface PaletteOption {
  id: string;
  label: string;
  /** One short clause of provenance, shown nowhere yet — kept for tooling. */
  origin: string;
}

/** Display order. The house theme leads because it is the default. */
export const PALETTES: readonly PaletteOption[] = [
  { id: "join-the-six", label: "Slopform", origin: "the house wine" },
  { id: "graphite", label: "Graphite", origin: "cool neutral under steel" },
  {
    id: "noir",
    label: "Noir",
    origin: "one hue, spent only on what wants you",
  },
  { id: "amphora", label: "Amphora", origin: "Flexoki ink, Aegean glaze" },
  { id: "linen", label: "Linen", origin: "Radix Colors sand under copper" },
  { id: "iris", label: "Iris", origin: "Rosé Pine on its own iris" },
];

const DEFAULT_PALETTE = "join-the-six";
const PALETTE_ATTRIBUTE = "data-palette";

function isKnownPalette(value: string | null): value is string {
  return value !== null && PALETTES.some((palette) => palette.id === value);
}

function readStoredPalette(): string {
  try {
    const stored = localStorage.getItem(PALETTE_STORAGE_KEY);
    if (isKnownPalette(stored)) return stored;
  } catch {
    // Storage can be unavailable (private mode); fall through to the default.
  }
  return DEFAULT_PALETTE;
}

let paletteId = readStoredPalette();
const listeners = new Set<() => void>();

function applyPalette(id: string): void {
  if (id === DEFAULT_PALETTE) {
    document.documentElement.removeAttribute(PALETTE_ATTRIBUTE);
  } else {
    document.documentElement.setAttribute(PALETTE_ATTRIBUTE, id);
  }
}

// The pre-paint script already stamped the attribute; re-applying is
// idempotent and covers storage changing between document start and now.
applyPalette(paletteId);

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): string {
  return paletteId;
}

export function setPalette(id: string): void {
  if (!isKnownPalette(id)) return;
  try {
    localStorage.setItem(PALETTE_STORAGE_KEY, id);
  } catch {
    // The attribute still updates; the preference just won't persist.
  }
  paletteId = id;
  applyPalette(id);
  for (const listener of listeners) listener();
}

export function usePalette() {
  const palette = useSyncExternalStore(subscribe, getSnapshot);
  return { palette, setPalette };
}
