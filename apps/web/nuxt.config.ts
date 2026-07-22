import { defineNuxtConfig } from "nuxt/config";

const strictCompilerOptions = {
  exactOptionalPropertyTypes: true,
  noImplicitOverride: true,
  noUncheckedIndexedAccess: true,
};

export default defineNuxtConfig({
  compatibilityDate: "2026-07-22",
  devtools: { enabled: true },
  modules: ["@nuxt/eslint", "@primevue/nuxt-module"],
  components: [
    {
      path: "~/components",
      pathPrefix: false,
    },
  ],
  css: [
    "@fontsource-variable/dm-sans/wght.css",
    "@fontsource-variable/newsreader/wght.css",
    "@join-the-six/design-tokens/tokens.css",
    "primeicons/primeicons.css",
    "~/assets/css/main.css",
  ],
  typescript: {
    strict: true,
    typeCheck: true,
    tsConfig: {
      compilerOptions: { ...strictCompilerOptions },
    },
    sharedTsConfig: {
      compilerOptions: { ...strictCompilerOptions },
    },
    nodeTsConfig: {
      compilerOptions: { ...strictCompilerOptions },
    },
  },
  nitro: {
    typescript: {
      tsConfig: {
        compilerOptions: { ...strictCompilerOptions },
      },
    },
  },
  runtimeConfig: {
    apiBaseInternal: "http://localhost:4000/api/v1",
    public: {
      apiBase: "/api/v1",
    },
  },
  routeRules: {
    "/": { prerender: true },
    "/admin": { ssr: false },
    "/admin/**": { ssr: false },
    "/join/**": { ssr: true },
    "/feedback/**": { ssr: true },
    "/register/**": { ssr: true },
    "/legal/**": { prerender: true, noScripts: true },
  },
  primevue: {
    autoImport: false,
    importTheme: {
      as: "JtsTheme",
      from: "~/theme/jts-theme",
    },
    components: {
      include: [
        "Avatar",
        "Button",
        "Checkbox",
        "Column",
        "DataTable",
        "DatePicker",
        "Dialog",
        "Drawer",
        "InputText",
        "Message",
        "PanelMenu",
        "Select",
        "Tag",
        "Textarea",
        "Toast",
        "Toolbar",
      ],
    },
    directives: {
      include: [],
    },
    composables: {
      include: [],
    },
    options: {
      ripple: true,
    },
  },
  app: {
    head: {
      titleTemplate: "%s · Join The Six",
      meta: [
        {
          name: "description",
          content:
            "Join The Six dinner registration and operations experience.",
        },
      ],
    },
  },
});
