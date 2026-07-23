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
