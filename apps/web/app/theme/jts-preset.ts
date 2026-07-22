import { definePreset } from "@primeuix/themes";
import Aura from "@primeuix/themes/aura";

const JtsPreset = definePreset(Aura, {
  primitive: {
    burgundy: {
      50: "#fff7f8",
      100: "#fdebed",
      200: "#f8d2d8",
      300: "#efa7b2",
      400: "#df7283",
      500: "#c84a60",
      600: "#aa3049",
      700: "#87233b",
      800: "#6e2034",
      900: "#5d1f30",
      950: "#350b19",
    },
    warm: {
      0: "#ffffff",
      50: "#fffdfb",
      100: "#fff8f3",
      200: "#fbeeea",
      300: "#eedbd5",
      400: "#cfaaa3",
      500: "#9a848c",
      600: "#6f5961",
      700: "#554048",
      800: "#39272e",
      900: "#24161b",
      950: "#160d11",
    },
  },
  semantic: {
    primary: {
      50: "{burgundy.50}",
      100: "{burgundy.100}",
      200: "{burgundy.200}",
      300: "{burgundy.300}",
      400: "{burgundy.400}",
      500: "{burgundy.500}",
      600: "{burgundy.600}",
      700: "{burgundy.700}",
      800: "{burgundy.800}",
      900: "{burgundy.900}",
      950: "{burgundy.950}",
    },
    borderRadius: {
      none: "0",
      xs: "0.25rem",
      sm: "0.5rem",
      md: "0.75rem",
      lg: "1rem",
      xl: "1.35rem",
    },
    focusRing: {
      width: "2px",
      style: "solid",
      color: "{primary.500}",
      offset: "2px",
      shadow: "0 0 0 3px color-mix(in srgb, {primary.500}, transparent 72%)",
    },
    formField: {
      paddingX: "0.875rem",
      paddingY: "0.6875rem",
      borderRadius: "{border.radius.md}",
      focusRing: {
        width: "2px",
        style: "solid",
        color: "color-mix(in srgb, {primary.500}, transparent 55%)",
        offset: "0",
        shadow: "0 0 0 3px color-mix(in srgb, {primary.500}, transparent 80%)",
      },
    },
    colorScheme: {
      light: {
        surface: {
          0: "{warm.0}",
          50: "{warm.50}",
          100: "{warm.100}",
          200: "{warm.200}",
          300: "{warm.300}",
          400: "{warm.400}",
          500: "{warm.500}",
          600: "{warm.600}",
          700: "{warm.700}",
          800: "{warm.800}",
          900: "{warm.900}",
          950: "{warm.950}",
        },
        primary: {
          color: "{primary.700}",
          contrastColor: "#ffffff",
          hoverColor: "{primary.800}",
          activeColor: "{primary.900}",
        },
        highlight: {
          background: "{primary.100}",
          focusBackground: "{primary.200}",
          color: "{primary.800}",
          focusColor: "{primary.900}",
        },
        formField: {
          background: "{surface.0}",
          disabledBackground: "{surface.200}",
          filledBackground: "{surface.100}",
          filledHoverBackground: "{surface.100}",
          filledFocusBackground: "{surface.0}",
          borderColor: "{surface.300}",
          hoverBorderColor: "{surface.400}",
          focusBorderColor: "{primary.color}",
          color: "{surface.900}",
          disabledColor: "{surface.500}",
          placeholderColor: "{surface.600}",
          iconColor: "{surface.500}",
          shadow: "0 1px 2px rgb(69 24 39 / 6%)",
        },
        text: {
          color: "{surface.900}",
          hoverColor: "{surface.950}",
          mutedColor: "{surface.600}",
          hoverMutedColor: "{surface.700}",
        },
        content: {
          background: "{surface.0}",
          hoverBackground: "{surface.100}",
          borderColor: "{surface.300}",
          color: "{text.color}",
          hoverColor: "{text.hover.color}",
        },
      },
      dark: {
        surface: {
          0: "#ffffff",
          50: "#fff4f0",
          100: "#f7e2e4",
          200: "#d6bdc5",
          300: "#b3959f",
          400: "#8f707a",
          500: "#755763",
          600: "#5d3d48",
          700: "#472b34",
          800: "#2e1b22",
          900: "#211419",
          950: "#160d11",
        },
        primary: {
          color: "{primary.300}",
          contrastColor: "{surface.950}",
          hoverColor: "{primary.200}",
          activeColor: "{primary.100}",
        },
        highlight: {
          background: "color-mix(in srgb, {primary.400}, transparent 82%)",
          focusBackground: "color-mix(in srgb, {primary.400}, transparent 72%)",
          color: "{primary.100}",
          focusColor: "#ffffff",
        },
        formField: {
          background: "{surface.900}",
          disabledBackground: "{surface.700}",
          filledBackground: "{surface.800}",
          filledHoverBackground: "{surface.800}",
          filledFocusBackground: "{surface.900}",
          borderColor: "{surface.700}",
          hoverBorderColor: "{surface.600}",
          focusBorderColor: "{primary.color}",
          color: "{surface.0}",
          disabledColor: "{surface.400}",
          placeholderColor: "{surface.300}",
          iconColor: "{surface.400}",
          shadow: "0 1px 2px rgb(0 0 0 / 28%)",
        },
        text: {
          color: "{surface.50}",
          hoverColor: "{surface.0}",
          mutedColor: "{surface.300}",
          hoverMutedColor: "{surface.200}",
        },
        content: {
          background: "{surface.900}",
          hoverBackground: "{surface.800}",
          borderColor: "{surface.700}",
          color: "{text.color}",
          hoverColor: "{text.hover.color}",
        },
      },
    },
  },
  components: {
    button: {
      root: {
        borderRadius: "{border.radius.md}",
        paddingX: "1rem",
        paddingY: "0.6875rem",
        label: {
          fontWeight: "700",
        },
      },
    },
    dialog: {
      root: {
        borderRadius: "{border.radius.xl}",
      },
      header: {
        padding: "1.5rem 1.5rem 0.75rem",
      },
      content: {
        padding: "0.75rem 1.5rem 1.25rem",
      },
      footer: {
        padding: "0.75rem 1.5rem 1.5rem",
      },
    },
    drawer: {
      header: {
        padding: "1.25rem",
      },
      content: {
        padding: "0 1.25rem 1.25rem",
      },
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
      columnTitle: {
        fontWeight: "700",
      },
      bodyCell: {
        padding: "0.875rem 1rem",
      },
      colorScheme: {
        light: {
          headerCell: {
            background: "{surface.100}",
            color: "{surface.700}",
          },
          row: {
            stripedBackground: "{surface.50}",
          },
        },
        dark: {
          headerCell: {
            background: "{surface.800}",
            color: "{surface.200}",
          },
          row: {
            stripedBackground: "{surface.950}",
          },
        },
      },
    },
    tag: {
      root: {
        borderRadius: "{border.radius.xl}",
        fontSize: "0.75rem",
        fontWeight: "700",
        padding: "0.3rem 0.625rem",
      },
    },
  },
});

export default JtsPreset;
