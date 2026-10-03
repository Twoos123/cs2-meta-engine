/** Header navigation: menu drawer on phones, inline links on desktop. */
import { expect, isCompact, test } from "./fixtures";

test("header nav reaches every section", async ({ page }) => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Main" });

  const go = async (label: string, path: RegExp) => {
    if (isCompact(page)) {
      const open = page.getByRole("button", { name: "Open menu" });
      await open.click();
      await expect(page.getByRole("button", { name: "Close menu" })).toHaveAttribute("aria-expanded", "true");
      await page.locator("#mobile-nav").getByRole("button", { name: label, exact: true }).click();
      // The drawer closes itself on navigation.
      await expect(page.getByRole("button", { name: "Open menu" })).toBeVisible();
      await expect(page.locator("#mobile-nav")).toHaveCount(0);
    } else {
      await nav.getByRole("button", { name: label, exact: true }).click();
    }
    await expect(page).toHaveURL(path);
  };

  if (isCompact(page)) {
    // Links stay hidden until the menu opens.
    await expect(nav.getByRole("button", { name: "Lineups", exact: true })).toHaveCount(0);
  }

  await go("Lineups", /\/lineups$/);
  await expect(page.getByRole("heading", { name: /Grenade lineups for/ })).toBeVisible();

  await go("Replay", /\/replay$/);
  await expect(page.getByRole("heading", { name: /Pick a demo/ })).toBeVisible();

  await go("Players", /\/players$/);
  await go("Anti-Strat", /\/anti-strat$/);
  await go("Matches", /\/matches$/);
  await go("Live", /\/live$/);
  await go("Ingest", /\/ingest$/);

  // Active section is marked for assistive tech.
  if (isCompact(page)) await page.getByRole("button", { name: "Open menu" }).click();
  const scope = isCompact(page) ? page.locator("#mobile-nav") : nav;
  await expect(scope.getByRole("button", { name: "Ingest", exact: true })).toHaveAttribute("aria-current", "page");

  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
});
