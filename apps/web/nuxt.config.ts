import { defineNuxtConfig } from "nuxt/config";

import { validateWebEnvironment } from "./environment.server.js";

const environment = validateWebEnvironment(process.env);

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
    "@fontsource-variable/manrope/wght.css",
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
    apiBaseInternal: environment.NUXT_API_BASE_INTERNAL,
    public: {
      apiBase: environment.NUXT_PUBLIC_API_BASE,
    },
  },
  routeRules: {
    "/": { redirect: "/admin" },
    "/admin": {
      ssr: false,
      headers: { "x-robots-tag": "noindex, nofollow" },
    },
    "/admin/**": {
      ssr: false,
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
    directives: {
      include: [],
    },
    composables: {
      include: [],
    },
    options: {
      // Flat/editorial UI — no material ripple on interactions.
      ripple: false,
    },
  },
  app: {
    head: {
      title: "Join The Six",
      htmlAttrs: { lang: "en" },
      link: [{ rel: "icon", type: "image/svg+xml", href: "/favicon.svg" }],
      script: [
        {
          // Apply the saved (or system) theme before first paint so there is
          // no light/dark flash. Mirrors the logic in `useTheme()`; the single
          // signal is the `jts-dark` class on <html>.
          innerHTML:
            "(function(){try{var s=localStorage.getItem('jts-theme');var d=s==='dark'||((!s||s==='system')&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('jts-dark',d);}catch(e){}})();",
          tagPosition: "head",
        },
      ],
      meta: [
        {
          name: "description",
          content: "Private Join The Six administration and operations panel.",
        },
        { name: "robots", content: "noindex, nofollow" },
      ],
    },
  },
});
