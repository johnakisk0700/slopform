import { defineNuxtConfig } from "nuxt/config";

const strictCompilerOptions = {
  exactOptionalPropertyTypes: true,
  noImplicitOverride: true,
  noUncheckedIndexedAccess: true,
};

export default defineNuxtConfig({
  compatibilityDate: "2026-07-22",
  devtools: { enabled: true },
  experimental: {
    payloadExtraction: "client",
  },
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
    "/admin": {
      ssr: false,
      headers: { "x-robots-tag": "noindex, nofollow" },
    },
    "/admin/**": {
      ssr: false,
      headers: { "x-robots-tag": "noindex, nofollow" },
    },
    "/join/**": { ssr: true },
    "/feedback/**": {
      ssr: true,
      headers: { "x-robots-tag": "noindex, nofollow" },
    },
    "/register/**": {
      ssr: true,
      headers: { "x-robots-tag": "noindex, nofollow" },
    },
    "/legal/**": {
      prerender: true,
      noScripts: true,
      headers: { "x-robots-tag": "noindex, nofollow" },
    },
  },
  hooks: {
    "build:manifest": (manifest) => {
      for (const chunk of Object.values(manifest)) {
        if (!chunk.isEntry) continue;

        // Route-aware NuxtLink prefetching handles these after hydration.
        chunk.dynamicImports = [];
        if (chunk.assets) {
          chunk.assets = chunk.assets.filter(
            (asset) => !/^primeicons\.[^.]+\.svg$/.test(asset),
          );
        }
      }
    },
  },
  primevue: {
    autoImport: false,
    importTheme: {
      as: "JtsTheme",
      from: "~/theme/jts-theme",
    },
    components: {
      include: ["Button", "Checkbox", "InputText", "Select", "Textarea"],
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
      title: "Join The Six",
      htmlAttrs: { lang: "en" },
      link: [{ rel: "icon", type: "image/svg+xml", href: "/favicon.svg" }],
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
