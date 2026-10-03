/**
 * Shared test fixture: every test gets a page that
 *   - never reaches the network beyond the local preview/API servers
 *     (external requests such as Google Fonts are aborted), and
 *   - records uncaught page errors, console errors and /api 5xx responses,
 *     which fail the test at teardown unless explicitly allowed.
 */
import { expect, test as base, type Page, type Request } from "@playwright/test";

/** Seeded by scripts/e2e_seed.py. */
export const DEMO = "2390001_mirage.dem";

/** In-flight /api requests per page (see settleApi). */
const inflight = new WeakMap<Page, Set<Request>>();

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

// Console noise that is not an app error: resource failures are reported by
// the browser for aborted external requests and expected 404s (e.g. avatar
// photos the seed marks as missing). /api 5xx are caught via responses.
const IGNORED_CONSOLE = [/Failed to load resource/i];

export interface PageProblems {
  pageErrors: string[];
  consoleErrors: string[];
  apiFailures: string[];
}

type Fixtures = {
  /** /api responses with a 5xx status that the test expects (by URL). */
  allowedApiFailures: RegExp[];
  problems: PageProblems;
};

export const test = base.extend<Fixtures>({
  allowedApiFailures: [[], { option: true }],

  problems: [
    async ({ page, allowedApiFailures }, use) => {
      const problems: PageProblems = { pageErrors: [], consoleErrors: [], apiFailures: [] };

      await page.route(
        (url) => !LOCAL_HOSTS.has(url.hostname),
        (route) => route.abort("blockedbyclient"),
      );

      const pending = new Set<Request>();
      inflight.set(page, pending);
      const tracked = (req: Request) =>
        new URL(req.url()).pathname.startsWith("/api/") &&
        !(req.headers()["accept"] ?? "").includes("text/event-stream");
      page.on("request", (req) => {
        if (tracked(req)) pending.add(req);
      });
      page.on("requestfinished", (req) => pending.delete(req));
      page.on("requestfailed", (req) => pending.delete(req));

      page.on("pageerror", (err) => problems.pageErrors.push(`${err.name}: ${err.message}`));
      page.on("console", (msg) => {
        if (msg.type() !== "error") return;
        const text = msg.text();
        if (IGNORED_CONSOLE.some((re) => re.test(text))) return;
        problems.consoleErrors.push(text);
      });
      page.on("response", (res) => {
        const url = new URL(res.url());
        if (!url.pathname.startsWith("/api/") || res.status() < 500) return;
        if (allowedApiFailures.some((re) => re.test(res.url()))) return;
        problems.apiFailures.push(`${res.status()} ${res.request().method()} ${url.pathname}`);
      });

      await use(problems);

      expect.soft(problems.pageErrors, "uncaught page errors").toEqual([]);
      expect.soft(problems.consoleErrors, "console errors").toEqual([]);
      expect.soft(problems.apiFailures, "/api 5xx responses").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/**
 * Wait until no /api request has been in flight for `quietMs`. Long-lived
 * streams (the Live page's SSE) are excluded; plain `networkidle` would
 * never settle while one is open.
 */
export async function settleApi(page: Page, quietMs = 600, timeoutMs = 15_000): Promise<void> {
  const pending = inflight.get(page);
  if (!pending) throw new Error("settleApi needs the page from the e2e fixture");
  const deadline = Date.now() + timeoutMs;
  let quietSince = Date.now();
  while (Date.now() < deadline) {
    if (pending.size > 0) quietSince = Date.now();
    else if (Date.now() - quietSince >= quietMs) return;
    await page.waitForTimeout(100);
  }
  throw new Error(`/api still busy after ${timeoutMs} ms: ${[...pending].map((r) => r.url()).join(", ")}`);
}

/**
 * Page width vs. viewport width. The viewport comes from the test config,
 * not `window.innerWidth`: under mobile emulation the browser zooms out to
 * fit over-wide content, which inflates innerWidth and hides the overflow.
 */
export async function horizontalOverflow(page: Page): Promise<{ scrollWidth: number; innerWidth: number }> {
  const scrollWidth = await page.evaluate(() =>
    Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
  );
  const innerWidth = page.viewportSize()?.width ?? (await page.evaluate(() => window.innerWidth));
  return { scrollWidth, innerWidth };
}

/** The viewport is phone-sized (the header collapses below 1024px). */
export function isCompact(page: Page): boolean {
  return (page.viewportSize()?.width ?? 1280) < 1024;
}
