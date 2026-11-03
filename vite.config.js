
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "Voice Coach",
        short_name: "Coach",
        display: "standalone",
        theme_color: "#111111",
        background_color: "#ffffff",
        icons: [
          {
            src: "/icon-192.png",
            sizes: "192x192",
            type: "image/png"
          },
          {
            src: "/icon-512.png",
            sizes: "512x512",
            type: "image/png"
          }
        ]
      }
    })
  ],

  server: {
    host: "0.0.0.0",
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true
      },
      "/live-audio": {
        target: "ws://localhost:3001",
        ws: true
      }
    }
  }
});
