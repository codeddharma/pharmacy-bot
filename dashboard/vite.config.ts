import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the dashboard runs on :5173 and forwards API calls to the server on :3000.
// In production the server serves the built files itself (dashboard/dist).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:3000", changeOrigin: false },
      "/webhooks": "http://127.0.0.1:3000",
    },
  },
  build: { outDir: "dist", sourcemap: false },
});
