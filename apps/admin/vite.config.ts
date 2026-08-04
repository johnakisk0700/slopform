import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// The backend HTTP API listens on API_PORT (see repo root .env / .env.example),
// which is 4000 in local development. The admin SPA is served on the origin the
// backend already trusts for CORS (WEB_ORIGIN=http://localhost:3000) so the
// same-origin /api proxy works end to end.
//
// API_PROXY_TARGET lets the containerised dev stack reach the API by service
// name (http://api:4000) instead of the host loopback.
const apiProxyTarget = process.env.API_PROXY_TARGET ?? "http://localhost:4000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // Mermaid is imported only for assistant messages containing a Mermaid
    // fence. Its generated parser is an indivisible ~663 kB lazy chunk.
    chunkSizeWarningLimit: 700,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "auth",
              test: /node_modules[\\/]@clerk[\\/]/,
              includeDependenciesRecursively: true,
            },
            {
              name: "ui",
              test: /node_modules[\\/]@heroui[\\/]/,
              // Recursive on purpose. Non-recursive grouping let HeroUI's own
              // dependencies (react-stately's ToastQueue among them) land in
              // whichever app chunk referenced them first, so this chunk
              // imported the entry and route chunks back — a cycle that left
              // bindings uninitialized while this chunk's top level ran
              // (`new ToastQueue` threw «ze is not a constructor» and the
              // admin never booted).
              includeDependenciesRecursively: true,
            },
            {
              name: "markdown",
              test: /node_modules[\\/](?:highlight\.js|react-markdown|rehype-[^\\/]+|remark-[^\\/]+|unified)[\\/]/,
              includeDependenciesRecursively: true,
            },
          ],
        },
      },
    },
  },
  server: {
    // 3000 by default, because `WEB_ORIGIN` and the docs assume it. `PORT`
    // overrides it for the times something else already holds 3000 — the
    // browser talks to this server and this server proxies `/api`, so the
    // origin the backend sees is unchanged and nothing about CORS depends on
    // which port the tab is on.
    port: Number(process.env["PORT"] ?? 3000),
    proxy: {
      "/api": {
        target: apiProxyTarget,
        changeOrigin: true,
      },
    },
  },
});
