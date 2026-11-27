import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// App version is baked in at build time so browser-preview mode can show it too.
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8")) as {
  version?: string;
};

// Set by `tauri dev` when targeting a remote/mobile device; unused for desktop but harmless.
const devHost = process.env.TAURI_DEV_HOST;
const tauriDebug = Boolean(process.env.TAURI_ENV_DEBUG);

export default defineConfig({
  root: "src-frontend",
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_ENV_"],
  define: {
    __NEXUM_VERSION__: JSON.stringify(pkg.version ?? "0.0.0"),
  },
  server: {
    port: 1420,
    strictPort: true,
    host: devHost || false,
    hmr: devHost ? { protocol: "ws", host: devHost, port: 1421 } : undefined,
    watch: {
      ignored: ["**/src-tauri/**", "**/nexum-agent/**"],
    },
  },
  preview: {
    port: 1420,
    strictPort: true,
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: "es2021",
    chunkSizeWarningLimit: 1500,
    sourcemap: tauriDebug,
    minify: tauriDebug ? false : "esbuild",
  },
});
