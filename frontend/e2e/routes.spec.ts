/**
 * Every route renders against the seeded backend with no uncaught errors,
 * no /api 5xx (both enforced by the fixture) and no sideways page scroll.
 */
import type { Locator, Page } from "@playwright/test";
import { DEMO, expect, horizontalOverflow, settleApi, test } from "./fixtures";

const demo = encodeURIComponent(DEMO);

const ROUTES: { path: string; ready: (page: Page) => Locator }[] = [
  { path: "/", ready: (p) => p.getByRole("heading", { level: 1, name: /Read the meta/ }) },
  { path: "/lineups", ready: (p) => p.getByText("Mirage Window Smoke") },
  { path: "/replay", ready: (p) => p.getByText(DEMO, { exact: true }) },
  { path: `/replay/${demo}`, ready: (p) => p.getByRole("button", { name: "Play", exact: true }) },
  { path: `/replay/${demo}/economy`, ready: (p) => p.getByText("Team Equipment Value by Round") },
  { path: `/replay/${demo}/stats`, ready: (p) => p.getByText(/Player Statistics · 3 rounds/) },
  { path: "/anti-strat", ready: (p) => p.getByRole("heading", { level: 1, name: /Scout the/ }) },
  { path: "/players", ready: (p) => p.getByText("e2e_alpha").first() },
  { path: "/matches", ready: (p) => p.getByRole("heading", { level: 1, name: /Tournaments/ }) },
  { path: "/ingest", ready: (p) => p.getByRole("heading", { level: 1, name: /Pull matches/ }) },
  { path: "/live", ready: (p) => p.getByRole("heading", { level: 1, name: "Live radar" }) },
  { path: "/definitely-not-a-page", ready: (p) => p.getByRole("heading", { name: "Page not found" }) },
];

for (const route of ROUTES) {
  test(`renders ${route.path}`, async ({ page }) => {
    await page.goto(route.path);
    await expect(route.ready(page)).toBeVisible();
    await settleApi(page);

    const { scrollWidth, innerWidth } = await horizontalOverflow(page);
    expect(scrollWidth, "page should not scroll horizontally").toBeLessThanOrEqual(innerWidth);
  });
}
