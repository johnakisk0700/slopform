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
              includeDependenciesRecursively: false,
            },
            {
              name: "ui",
              test: /node_modules[\\/]@heroui[\\/]/,
              includeDependenciesRecursively: false,
            },
            {
              name: "markdown",
              test: /node_modules[\\/](?:highlight\.js|react-markdown|rehype-[^\\/]+|remark-[^\\/]+|unified)[\\/]/,
              includeDependenciesRecursively: false,
            },
          ],
        },
      },
    },
  },
  server: {
    port: 3000,
    proxy: {
      "/api": {
        target: apiProxyTarget,
        changeOrigin: true,
      },
    },
  },
});
