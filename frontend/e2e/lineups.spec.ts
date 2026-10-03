/** Lineups dashboard against the seeded de_mirage clusters. */
import { expect, settleApi, test } from "./fixtures";

const SMOKES = ["Mirage Window Smoke", "Mirage Stairs Smoke", "Mirage Jungle Smoke", "Mirage CT Smoke"];
const FLASHES = ["Mirage A Ramp Flash", "Mirage Top Mid Flash"];

test.describe("lineups", () => {
  // No AI key in CI: the describe endpoint answers 503 on purpose.
  test.use({ allowedApiFailures: [/\/api\/lineups\/\d+\/describe/] });

  test("seeded cards render and grenade chips switch", async ({ page }) => {
    await page.goto("/lineups");
    const types = page.getByRole("group", { name: "Grenade type" });
    const smoke = types.getByRole("button", { name: "Smoke", exact: true });
    const flash = types.getByRole("button", { name: "Flash", exact: true });

    await expect(smoke).toHaveAttribute("aria-pressed", "true");
    for (const label of SMOKES) await expect(page.getByText(label, { exact: true })).toBeVisible();
    await expect(page.getByText(FLASHES[0], { exact: true })).toHaveCount(0);

    await flash.click();
    await expect(flash).toHaveAttribute("aria-pressed", "true");
    await expect(smoke).toHaveAttribute("aria-pressed", "false");
    for (const label of FLASHES) await expect(page.getByText(label, { exact: true })).toBeVisible();
    await expect(page.getByText(SMOKES[0], { exact: true })).toHaveCount(0);

    await smoke.click();
    await expect(page.getByText(SMOKES[0], { exact: true })).toBeVisible();
    await settleApi(page);
  });

  test("side filter narrows to CT lineups", async ({ page }) => {
    await page.goto("/lineups");
    await expect(page.getByText("Mirage Window Smoke", { exact: true })).toBeVisible();
    await page.getByRole("group", { name: "Side" }).getByRole("button", { name: "CT", exact: true }).click();
    await expect(page.getByText("Mirage Connector Smoke", { exact: true })).toBeVisible();
    await expect(page.getByText("Mirage Window Smoke", { exact: true })).toHaveCount(0);
  });

  test("AI Describe shows the backend's error without a key", async ({ page }) => {
    await page.goto("/lineups");
    await expect(page.getByText("Mirage Window Smoke", { exact: true })).toBeVisible();

    const describe = page.getByRole("button", { name: "AI Describe", exact: true }).first();
    const response = page.waitForResponse((r) => /\/api\/lineups\/\d+\/describe/.test(r.url()));
    await describe.click();
    expect((await response).status()).toBe(503);

    await expect(page.getByText(/No AI API key configured/).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry AI Describe" }).first()).toBeVisible();
  });
});
