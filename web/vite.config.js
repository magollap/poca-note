import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const root = path.dirname(fileURLToPath(import.meta.url));
const target = process.env.POCA_API_URL || "http://localhost:8787";
const host = process.env.POCA_HOST || "127.0.0.1";

export default defineConfig({
  root,
  plugins: [react()],
  server: {
    port: 5173,
    host,
    proxy: {
      "/api": { target, changeOrigin: false },
      "/events": { target, changeOrigin: false },
    },
  },
  build: {
    outDir: path.join(root, "dist"),
    emptyOutDir: true,
    sourcemap: false,
  },
});
