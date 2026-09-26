import { defineConfig } from "vitest/config";

// Tauri loads the dev server from a fixed URL (tauri.conf.json `devUrl`), so
// the port is pinned and strict: a Vite that quietly moved to the next free
// port would leave the window blank.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1430,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 2000,
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
