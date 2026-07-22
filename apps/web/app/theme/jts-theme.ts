import JtsPreset from "./jts-preset";

/**
 * PrimeVue theme wrapper consumed by `@primevue/nuxt-module` (see
 * `nuxt.config.ts` → `primevue.importTheme`).
 *
 * - `darkModeSelector: ".jts-dark"` — dark mode is driven by the single
 *   `jts-dark` class on <html>, the same signal the design tokens use. The
 *   `useTheme()` composable owns that class; nothing else toggles it.
 * - `cssLayer` — PrimeVue's built-in styles live in the `primevue` cascade
 *   layer so our own (unlayered) CSS overrides them without specificity wars.
 */
export default {
  preset: JtsPreset,
  options: {
    prefix: "p",
    darkModeSelector: ".jts-dark",
    cssLayer: {
      name: "primevue",
      order: "theme, base, primevue",
    },
  },
};
