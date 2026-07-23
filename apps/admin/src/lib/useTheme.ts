import { useSyncExternalStore } from "react";

/** User-selectable appearance preference. */
export type ThemeMode = "light" | "dark" | "system";
/** The concrete theme after resolving `system` against the OS. */
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "jts-theme";
const DARK_CLASS = "dark";

interface ThemeState {
  mode: ThemeMode;
  systemDark: boolean;
}

/**
 * Appearance state for the admin panel.
 *
 * The single source of truth for "is it dark" is the `dark` class on <html> —
 * shared by the design tokens, HeroUI and Tailwind. The pre-paint script in
 * `index.html` applies it before first paint (no flash); this store owns it
 * afterwards. A module-level store (rather than context) keeps every
 * `useTheme()` consumer in sync — the operator menu renders both in the
 * sidebar and in the small-screen top bar.
 */
function readStoredMode(): ThemeMode {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") {
      return stored;
    }
  } catch {
    // Storage can be unavailable (private mode); fall through to the default.
  }
  return "system";
}

const media = window.matchMedia("(prefers-color-scheme: dark)");

let state: ThemeState = { mode: readStoredMode(), systemDark: media.matches };
const listeners = new Set<() => void>();

export function resolveTheme(
  mode: ThemeMode,
  systemDark: boolean,
): ResolvedTheme {
  if (mode === "system") return systemDark ? "dark" : "light";
  return mode;
}

function applyTheme(resolved: ResolvedTheme): void {
  document.documentElement.classList.toggle(DARK_CLASS, resolved === "dark");
}

function setState(next: ThemeState): void {
  state = next;
  applyTheme(resolveTheme(next.mode, next.systemDark));
  for (const listener of listeners) listener();
}

media.addEventListener("change", (event) => {
  setState({ ...state, systemDark: event.matches });
});

// The pre-paint script already set the class; re-applying is idempotent and
// covers the edge where storage changed between document start and module load.
applyTheme(resolveTheme(state.mode, state.systemDark));

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): ThemeState {
  return state;
}

export function setThemeMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // The class still updates; the preference just won't persist.
  }
  setState({ ...state, mode });
}

export function useTheme() {
  const { mode, systemDark } = useSyncExternalStore(subscribe, getSnapshot);
  const resolved = resolveTheme(mode, systemDark);

  return {
    mode,
    resolved,
    isDark: resolved === "dark",
    setMode: setThemeMode,
  };
}
