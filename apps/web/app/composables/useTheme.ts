import { computed } from "vue";

/** User-selectable appearance preference. */
export type ThemeMode = "light" | "dark" | "system";
/** The concrete theme after resolving `system` against the OS. */
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "jts-theme";
const DARK_CLASS = "jts-dark";

function systemPrefersDark(): boolean {
  return (
    import.meta.client &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === "system") return systemPrefersDark() ? "dark" : "light";
  return mode;
}

/** Toggle the single dark-mode signal on <html>. */
export function applyTheme(resolved: ResolvedTheme): void {
  if (!import.meta.client) return;
  document.documentElement.classList.toggle(DARK_CLASS, resolved === "dark");
}

/**
 * Appearance state for the admin panel.
 *
 * The single source of truth for "is it dark" is the `jts-dark` class on
 * <html> — shared by the design tokens and PrimeVue's `darkModeSelector`. This
 * composable manages the user's preference (light / dark / system), persists
 * it, and keeps that class in sync. Pre-paint application lives in the inline
 * head script (see `nuxt.config.ts`); OS-change handling lives in
 * `plugins/theme.client.ts`.
 */
export function useTheme() {
  const mode = useState<ThemeMode>("jts-theme-mode", () => "system");
  // Reactive mirror of the OS preference so `resolved`/`isDark` update when the
  // system theme changes while in "system" mode (the plugin owns the listener).
  const systemDark = useState<boolean>("jts-theme-system-dark", () =>
    systemPrefersDark(),
  );

  const resolved = computed<ResolvedTheme>(() =>
    mode.value === "system"
      ? systemDark.value
        ? "dark"
        : "light"
      : mode.value,
  );
  const isDark = computed(() => resolved.value === "dark");

  function setMode(next: ThemeMode): void {
    mode.value = next;
    if (!import.meta.client) return;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage can be unavailable (private mode); the class still updates.
    }
    applyTheme(resolveTheme(next));
  }

  return { mode, systemDark, resolved, isDark, setMode };
}
