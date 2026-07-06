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
        name: "badgr.me",
        short_name: "badgr.me",
        description: "Reminders that badger you until they're dealt with.",
        theme_color: "#F0A32F",
        background_color: "#17181A",
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
