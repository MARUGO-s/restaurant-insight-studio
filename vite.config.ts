import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/restaurant-insight-studio/",
  plugins: [react()],
});
