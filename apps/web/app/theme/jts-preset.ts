import { definePreset } from "@primeuix/themes";
import Aura from "@primeuix/themes/aura";

/**
 * Join The Six PrimeVue preset.
 *
 * Design principle: the design tokens in `@join-the-six/design-tokens`
 * (`tokens.css`) are the single source of truth. This preset does not invent
 * its own colours — it maps PrimeVue's semantic slots onto our `--jts-*`
 * variables, so every PrimeVue component matches hand-written CSS and flips
 * light/dark automatically through the `.jts-dark` class. To restyle the app,
 * edit a token; you rarely touch this file.
 *
 * The primitive `surface` scale is the one thing defined per colour-scheme
 * (light ramps 0→dark, dark ramps 0→light) because PrimeVue components
 * reference raw `surface.N` steps for subtle neutrals.
 */
const JtsPreset = definePreset(Aura, {
  primitive: {
    borderRadius: {
      none: "0",
      xs: "var(--jts-radius-xs)",
      sm: "var(--jts-radius-sm)",
      md: "var(--jts-radius-md)",
      lg: "var(--jts-radius-lg)",
      xl: "var(--jts-radius-xl)",
    },
    // Remap Aura's status ramps to our earthy hues so every PrimeVue status
    // surface (Tag, Message, badges, severity buttons) matches the palette
    // instead of Aura's default emerald/sky/orange/red.
    green: {
      50: "var(--jts-forest-50)",
      100: "var(--jts-forest-100)",
      300: "var(--jts-forest-300)",
      500: "var(--jts-forest-500)",
      600: "var(--jts-forest-600)",
      700: "var(--jts-forest-700)",
    },
    sky: {
      50: "var(--jts-slate-50)",
      100: "var(--jts-slate-100)",
      300: "var(--jts-slate-300)",
      500: "var(--jts-slate-500)",
      600: "var(--jts-slate-600)",
      700: "var(--jts-slate-700)",
    },
    orange: {
      50: "var(--jts-amber-50)",
      100: "var(--jts-amber-100)",
      300: "var(--jts-amber-300)",
      500: "var(--jts-amber-500)",
      600: "var(--jts-amber-600)",
      700: "var(--jts-amber-700)",
    },
    red: {
      50: "var(--jts-terracotta-50)",
      100: "var(--jts-terracotta-100)",
      300: "var(--jts-terracotta-300)",
      500: "var(--jts-terracotta-500)",
      600: "var(--jts-terracotta-600)",
      700: "var(--jts-terracotta-700)",
    },
  },
  semantic: {
    // Brand ramp — shared across both schemes (the active role differs below).
    primary: {
      50: "var(--jts-wine-50)",
      100: "var(--jts-wine-100)",
      200: "var(--jts-wine-200)",
      300: "var(--jts-wine-300)",
      400: "var(--jts-wine-400)",
      500: "var(--jts-wine-500)",
      600: "var(--jts-wine-600)",
      700: "var(--jts-wine-700)",
      800: "var(--jts-wine-800)",
      900: "var(--jts-wine-900)",
      950: "var(--jts-wine-950)",
    },
    borderRadius: {
      none: "0",
      xs: "var(--jts-radius-xs)",
      sm: "var(--jts-radius-sm)",
      md: "var(--jts-radius-md)",
      lg: "var(--jts-radius-lg)",
      xl: "var(--jts-radius-xl)",
    },
    focusRing: {
      width: "2px",
      style: "solid",
      color: "var(--jts-color-focus)",
      offset: "2px",
      shadow: "var(--jts-focus-ring)",
    },
    formField: {
      paddingX: "0.875rem",
      paddingY: "0.6875rem",
      borderRadius: "var(--jts-radius-md)",
      focusRing: {
        width: "2px",
        style: "solid",
        color: "var(--jts-color-focus)",
        offset: "0",
        shadow: "var(--jts-focus-ring)",
      },
    },
    colorScheme: {
      light: {
        surface: {
          0: "var(--jts-clay-0)",
          50: "var(--jts-clay-50)",
          100: "var(--jts-clay-100)",
          200: "var(--jts-clay-200)",
          300: "var(--jts-clay-300)",
          400: "var(--jts-clay-400)",
          500: "var(--jts-clay-500)",
          600: "var(--jts-clay-600)",
          700: "var(--jts-clay-700)",
          800: "var(--jts-clay-800)",
          900: "var(--jts-clay-900)",
          950: "var(--jts-clay-950)",
        },
        primary: {
          color: "var(--jts-color-primary)",
          contrastColor: "var(--jts-color-primary-contrast)",
          hoverColor: "var(--jts-color-primary-hover)",
          activeColor: "var(--jts-color-primary-active)",
        },
        highlight: {
          background: "var(--jts-color-highlight)",
          focusBackground: "var(--jts-color-highlight)",
          color: "var(--jts-color-highlight-text)",
          focusColor: "var(--jts-color-highlight-text)",
        },
        text: {
          color: "var(--jts-color-text)",
          hoverColor: "var(--jts-color-text)",
          mutedColor: "var(--jts-color-text-muted)",
          hoverMutedColor: "var(--jts-color-text)",
        },
        content: {
          background: "var(--jts-color-surface)",
          hoverBackground: "var(--jts-color-surface-sunken)",
          borderColor: "var(--jts-color-border)",
          color: "var(--jts-color-text)",
          hoverColor: "var(--jts-color-text)",
        },
        overlay: {
          select: { background: "var(--jts-color-surface-overlay)" },
          popover: { background: "var(--jts-color-surface-overlay)" },
          modal: { background: "var(--jts-color-surface-overlay)" },
        },
        formField: {
          background: "var(--jts-color-surface-raised)",
          disabledBackground: "var(--jts-color-surface-sunken)",
          filledBackground: "var(--jts-color-surface-sunken)",
          filledHoverBackground: "var(--jts-color-surface-sunken)",
          filledFocusBackground: "var(--jts-color-surface-raised)",
          borderColor: "var(--jts-color-border-strong)",
          hoverBorderColor: "var(--jts-color-primary)",
          focusBorderColor: "var(--jts-color-primary)",
          color: "var(--jts-color-text)",
          disabledColor: "var(--jts-color-text-subtle)",
          placeholderColor: "var(--jts-color-text-muted)",
          iconColor: "var(--jts-color-text-muted)",
          shadow: "var(--jts-shadow-xs)",
        },
      },
      dark: {
        surface: {
          0: "#ffffff",
          50: "#fbeef0",
          100: "#e7d5db",
          200: "#c9adb8",
          300: "#9e7f8b",
          400: "#75585f",
          500: "#573a46",
          600: "#3f2a33",
          700: "#301f27",
          800: "#281922",
          900: "#1e131a",
          950: "#150c10",
        },
        primary: {
          color: "var(--jts-color-primary)",
          contrastColor: "var(--jts-color-primary-contrast)",
          hoverColor: "var(--jts-color-primary-hover)",
          activeColor: "var(--jts-color-primary-active)",
        },
        highlight: {
          background: "var(--jts-color-highlight)",
          focusBackground: "var(--jts-color-highlight)",
          color: "var(--jts-color-highlight-text)",
          focusColor: "var(--jts-color-highlight-text)",
        },
        text: {
          color: "var(--jts-color-text)",
          hoverColor: "var(--jts-color-text)",
          mutedColor: "var(--jts-color-text-muted)",
          hoverMutedColor: "var(--jts-color-text)",
        },
        content: {
          background: "var(--jts-color-surface)",
          hoverBackground: "var(--jts-color-surface-sunken)",
          borderColor: "var(--jts-color-border)",
          color: "var(--jts-color-text)",
          hoverColor: "var(--jts-color-text)",
        },
        overlay: {
          select: { background: "var(--jts-color-surface-overlay)" },
          popover: { background: "var(--jts-color-surface-overlay)" },
          modal: { background: "var(--jts-color-surface-overlay)" },
        },
        formField: {
          background: "var(--jts-color-surface-raised)",
          disabledBackground: "var(--jts-color-surface-sunken)",
          filledBackground: "var(--jts-color-surface-sunken)",
          filledHoverBackground: "var(--jts-color-surface-sunken)",
          filledFocusBackground: "var(--jts-color-surface-raised)",
          borderColor: "var(--jts-color-border-strong)",
          hoverBorderColor: "var(--jts-color-primary)",
          focusBorderColor: "var(--jts-color-primary)",
          color: "var(--jts-color-text)",
          disabledColor: "var(--jts-color-text-subtle)",
          placeholderColor: "var(--jts-color-text-muted)",
          iconColor: "var(--jts-color-text-muted)",
          shadow: "var(--jts-shadow-xs)",
        },
      },
    },
  },
  components: {
    button: {
      root: {
        borderRadius: "var(--jts-radius-md)",
        paddingX: "1rem",
        paddingY: "0.6875rem",
        gap: "0.5rem",
        label: { fontWeight: "700" },
      },
    },
    card: {
      root: {
        borderRadius: "var(--jts-radius-md)",
        shadow: "var(--jts-shadow-sm)",
      },
    },
    dialog: {
      root: { borderRadius: "var(--jts-radius-xl)" },
      header: { padding: "1.5rem 1.5rem 0.75rem" },
      content: { padding: "0.75rem 1.5rem 1.25rem" },
      footer: { padding: "0.75rem 1.5rem 1.5rem" },
    },
    popover: {
      root: { borderRadius: "var(--jts-radius-lg)" },
    },
    drawer: {
      header: { padding: "1.25rem" },
      content: { padding: "0 1.25rem 1.25rem" },
    },
    toolbar: {
      root: {
        background: "transparent",
        borderColor: "transparent",
        borderRadius: "0",
        padding: "1.125rem 1.25rem",
      },
    },
    datatable: {
      headerCell: { padding: "0.75rem 1rem" },
      columnTitle: { fontWeight: "700" },
      bodyCell: { padding: "0.875rem 1rem" },
      colorScheme: {
        light: {
          headerCell: {
            background: "var(--jts-color-surface-sunken)",
            color: "var(--jts-color-text-muted)",
          },
          row: {
            stripedBackground:
              "color-mix(in srgb, var(--jts-color-text) 3%, var(--jts-color-surface))",
          },
        },
        dark: {
          headerCell: {
            background: "var(--jts-color-surface-sunken)",
            color: "var(--jts-color-text-muted)",
          },
          row: {
            stripedBackground:
              "color-mix(in srgb, #ffffff 4%, var(--jts-color-surface))",
          },
        },
      },
    },
    // Tags read as ledger "stamps": squared, tiny, heavy, uppercase (the
    // uppercase/tracking half lives in main.css — not a PrimeVue tag token).
    tag: {
      root: {
        borderRadius: "var(--jts-radius-sm)",
        fontSize: "0.7rem",
        fontWeight: "800",
        padding: "0.25rem 0.5rem",
      },
    },
  },
});

export default JtsPreset;
