/** Match replay of the seeded synthetic demo. */
import { DEMO, expect, settleApi, test } from "./fixtures";

const demoPath = `/replay/${encodeURIComponent(DEMO)}`;

test("demo picker opens the seeded demo with playback controls", async ({ page }) => {
  await page.goto("/replay");
  await expect(page.getByText(DEMO, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open", exact: true }).first().click();

  await expect(page).toHaveURL(new RegExp(`${demoPath.replace(/\./g, "\\.")}$`));
  for (const name of ["Previous round", "Play", "Next round"]) {
    await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
  }
  await expect(page.getByRole("link", { name: "Replay", exact: true })).toHaveAttribute("aria-current", "page");
});

test("play toggles to pause", async ({ page }) => {
  await page.goto(demoPath);
  const play = page.getByRole("button", { name: "Play", exact: true });
  await play.click();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(play).toBeVisible();
});

test("deep link ?round=2&t=5 opens without errors", async ({ page }) => {
  await page.goto(`${demoPath}?round=2&t=5`);
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/[?&]round=2/);
  await settleApi(page);
});

test("replay tabs switch between views", async ({ page }) => {
  await page.goto(demoPath);
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Economy", exact: true }).click();
  await expect(page).toHaveURL(/\/economy$/);
  await expect(page.getByText("Team Equipment Value by Round")).toBeVisible();

  await page.getByRole("link", { name: "Stats", exact: true }).click();
  await expect(page).toHaveURL(/\/stats$/);
  await expect(page.getByText(/Player Statistics · 3 rounds/)).toBeVisible();
  await expect(page.getByText("e2e_alpha").first()).toBeVisible();
  await settleApi(page);
});
