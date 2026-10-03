/** Catch-all route. */
import { expect, test } from "./fixtures";

test("unknown route shows the 404 page and Go home returns to /", async ({ page }) => {
  await page.goto("/no/such/route");
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await expect(page.getByText("/no/such/route")).toBeVisible();

  await page.getByRole("button", { name: "Go home", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { level: 1, name: /Read the meta/ })).toBeVisible();
});
