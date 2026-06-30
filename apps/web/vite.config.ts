import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// https://vite.dev/config/
// Use a subpath on GitHub Pages; local dev stays at root.
const base = process.env.CI ? "/badgr.me/" : "/";

export default defineConfig({
  base,
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "Alarmed",
        short_name: "Alarmed",
        description: "Review and manage reminders that nag until they're dealt with.",
        theme_color: "#34A853",
        background_color: "#F2F2F7",
        display: "standalone",
        icons: [
          {
            src: "favicon.svg",
            sizes: "any",
            type: "image/svg+xml",
          },
        ],
      },
    }),
  ],
});
