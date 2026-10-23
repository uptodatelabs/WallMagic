import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri v2 dev server expectations:
// - `devUrl` in src-tauri/tauri.conf.json points to http://localhost:1420
// - `beforeDevCommand` runs `npm run dev`
// The dev server must bind 1420 and the watcher must ignore `src-tauri/` so that
// Rust rebuilds do not trigger a frontend reload loop.
export default defineConfig({
  plugins: [react()],
  build: {
    // `frontendDist` in tauri.conf.json points to ../dist (i.e. <repo-root>/dist)
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
