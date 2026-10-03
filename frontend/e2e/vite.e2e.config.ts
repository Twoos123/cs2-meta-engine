/**
 * Vite config for the e2e run: the app's own config plus a `vite preview`
 * proxy to the e2e backend and a separate build dir. The base config only
 * proxies /api for the dev server, and hard-codes :8000 — which may be a
 * developer's own backend, so the suite uses its own port instead.
 */
import { defineConfig, mergeConfig } from "vite";
import base from "../vite.config";

const apiPort = process.env.E2E_API_PORT ?? "8765";
const webPort = Number(process.env.E2E_WEB_PORT ?? "4173");

export default mergeConfig(
  base,
  defineConfig({
    build: { outDir: "e2e/.dist", emptyOutDir: true },
    preview: {
      host: "127.0.0.1",
      port: webPort,
      strictPort: true,
      proxy: {
        "/api": { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true },
      },
    },
  }),
);
