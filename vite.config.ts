import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  base: "/restaurant-insight-studio/",
  plugins: [react()],
  build: { rollupOptions: { input: { studio: resolve(__dirname, "index.html"), report: resolve(__dirname, "report.html") } } },
});
