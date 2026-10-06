import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiPort = Number(process.env.ANIKA_PORT ?? 4317);

export default defineConfig({
  plugins: [react()],
  root: "src/ui",
  build: { outDir: "../../dist", emptyOutDir: true },
  server: { proxy: { "/api": `http://127.0.0.1:${apiPort}` } },
});
