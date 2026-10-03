/**
 * Playwright e2e suite: seeded backend + production build served by
 * `vite preview`, exercised at phone and desktop sizes.
 *
 *   npx playwright install chromium   # once
 *   npm run e2e
 *
 * Ports default to 8765 (API) and 4173 (web) so the suite never collides
 * with a dev setup on :8000 / :5173. Override with E2E_API_PORT /
 * E2E_WEB_PORT. The seeded data dir defaults to <tmp>/cs2-e2e-data
 * (E2E_DATA_DIR); it is wiped and rebuilt on every run.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

const apiPort = process.env.E2E_API_PORT ?? "8765";
const webPort = process.env.E2E_WEB_PORT ?? "4173";
const python = process.env.E2E_PYTHON ?? "python";
const dataDir = path.resolve(process.env.E2E_DATA_DIR ?? path.join(os.tmpdir(), "cs2-e2e-data"));
// The backend's cwd must exist before the webServer spawns; the seed step
// (first half of its command) fills it.
fs.mkdirSync(dataDir, { recursive: true });

const isCI = !!process.env.CI;
// The no-op proxy that keeps the backend offline (see below).
const deadProxy = "http://127.0.0.1:9";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./e2e/.results",
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  workers: isCI ? 2 : undefined,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: isCI
    ? [["github"], ["list"], ["html", { outputFolder: "e2e/.report", open: "never" }]]
    : [["list"], ["html", { outputFolder: "e2e/.report", open: "never" }]],

  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  projects: [
    {
      name: "mobile",
      use: {
        ...devices["Pixel 7"],
        viewport: { width: 375, height: 812 },
      },
    },
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
      },
    },
  ],

  webServer: [
    {
      name: "api",
      command:
        `${python} "${path.join(repoRoot, "scripts", "e2e_seed.py")}" . && ` +
        `${python} -m uvicorn backend.main:app --host 127.0.0.1 --port ${apiPort} --no-access-log`,
      cwd: dataDir,
      url: `http://127.0.0.1:${apiPort}/api/health`,
      timeout: 120_000,
      reuseExistingServer: false,
      stdout: "ignore",
      stderr: "pipe",
      env: {
        PYTHONPATH: repoRoot,
        DEMO_DIR: path.join(dataDir, "demos"),
        DB_PATH: path.join(dataDir, "data", "lineups.db"),
        DATABASE_URL: "",
        ADMIN_TOKEN: "",
        ANTHROPIC_API_KEY: "",
        OPENROUTER_API_KEY: "",
        FACEIT_API_KEY: "",
        LIQUIPEDIA_API_KEY: "",
        IMPORT_WATCH_AUTOSTART: "false",
        // No external calls from the suite: any outbound HTTP(S) the backend
        // tries (Liquipedia, HLTV, FACEIT) goes to a closed local port and
        // fails fast, which is exactly the offline path the pages must handle.
        HTTP_PROXY: deadProxy,
        HTTPS_PROXY: deadProxy,
        http_proxy: deadProxy,
        https_proxy: deadProxy,
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
        PYTHONUNBUFFERED: "1",
      },
    },
    {
      name: "web",
      command:
        "npx vite build --config e2e/vite.e2e.config.ts --logLevel warn && " +
        "npx vite preview --config e2e/vite.e2e.config.ts",
      cwd: here,
      url: `http://127.0.0.1:${webPort}`,
      timeout: 180_000,
      reuseExistingServer: false,
      env: { E2E_API_PORT: apiPort, E2E_WEB_PORT: webPort },
    },
  ],
});
