import { definePreset } from "@primeuix/themes";
import Aura from "@primeuix/themes/aura";

const JtsPreset = definePreset(Aura, {
  primitive: {
    plum: {
      50: "#faf7fb",
      100: "#f1e9f3",
      200: "#dfcfe4",
      300: "#c5a6ce",
      400: "#a478b1",
      500: "#85568f",
      600: "#6f4377",
      700: "#59365f",
      800: "#482d4d",
      900: "#3b283f",
      950: "#231325",
    },
  },
  semantic: {
    primary: {
      50: "{plum.50}",
      100: "{plum.100}",
      200: "{plum.200}",
      300: "{plum.300}",
      400: "{plum.400}",
      500: "{plum.500}",
      600: "{plum.600}",
      700: "{plum.700}",
      800: "{plum.800}",
      900: "{plum.900}",
      950: "{plum.950}",
    },
    focusRing: {
      width: "2px",
      style: "solid",
      color: "{primary.500}",
      offset: "2px",
    },
  },
});

export default JtsPreset;
