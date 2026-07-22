import {
  applyTheme,
  resolveTheme,
  THEME_STORAGE_KEY,
  useTheme,
  type ThemeMode,
} from "~/composables/useTheme";

/**
 * Hydrates the theme preference from storage into reactive state and keeps the
 * `jts-dark` class in sync with the OS while the user is in "system" mode.
 *
 * The inline head script in `nuxt.config.ts` has already applied the correct
 * class before first paint; this plugin only wires up reactive state and the
 * live OS listener.
 */
export default defineNuxtPlugin(() => {
  const { mode, systemDark } = useTheme();

  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") {
      mode.value = stored as ThemeMode;
    }
  } catch {
    // Ignore storage failures; fall back to the "system" default.
  }

  applyTheme(resolveTheme(mode.value));

  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", (event) => {
    systemDark.value = event.matches;
    if (mode.value === "system") {
      applyTheme(event.matches ? "dark" : "light");
    }
  });
});
