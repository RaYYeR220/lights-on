import { expect, test, type Page } from "@playwright/test";

const towerReady = async (page: Page) => {
  await expect(page.getByTestId("tower-canvas")).toBeVisible();
  // the engine sizes the canvas and positions the overlay links once it runs
  await expect.poll(() => page.getByTestId("tower-canvas").evaluate((c: HTMLCanvasElement) => c.width)).toBeGreaterThan(100);
  await expect.poll(() => page.locator("[data-b='0']").evaluate((el: HTMLElement) => el.style.width)).not.toBe("");
};

const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test.describe("landing", () => {
  test("renders the claim, the tower and real counts", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Know by morning if\s*they're still shipping\./);
    await towerReady(page);
    await expect(page.getByText(/\d+ watched/).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "See last night's shift" })).toHaveAttribute("href", "/night");
  });

  test("the sr-only list mirrors one item per project window", async ({ page }) => {
    await page.goto("/");
    await towerReady(page);
    const items = page.getByTestId("tower-list").locator("li");
    const windows = page.locator("[data-tower-bays] [data-slug]");
    const n = await windows.count();
    expect(n).toBeGreaterThan(0);
    await expect(items).toHaveCount(n);
    const ground = await page.getByText(/projects watched/).textContent();
    expect(Number(ground?.match(/(\d+) projects watched/)?.[1])).toBe(n);
    // the list adds no tab stops
    for (const tab of await items.locator("a").evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).tabIndex))) {
      expect(tab).toBe(-1);
    }
  });

  test("a window opens its project page", async ({ page }) => {
    await page.goto("/");
    await towerReady(page);
    const first = page.locator("[data-tower-bays] [data-slug]").first();
    const slug = await first.getAttribute("data-slug");
    await first.scrollIntoViewIfNeeded();
    await first.click();
    await expect(page).toHaveURL(new RegExp(`/p/${slug}$`));
  });

  test("keyboard: one tab stop, arrows move, Enter opens", async ({ page }) => {
    await page.goto("/");
    await towerReady(page);
    const bays = page.locator("[data-tower-bays] [data-b]");
    const tabbable = await bays.evaluateAll((els) => els.filter((e) => (e as HTMLElement).tabIndex === 0).length);
    expect(tabbable).toBe(1);
    await page.locator("[data-b='0']").focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator("[data-b='1']")).toBeFocused();
    const slug = await page.locator("[data-b='1']").getAttribute("data-slug");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/p/${slug}$`));
  });

  test("hover shows the window card", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await towerReady(page);
    const first = page.locator("[data-b='0']");
    await first.scrollIntoViewIfNeeded();
    await first.hover();
    const card = page.locator("[data-on][aria-hidden='true']").filter({ hasText: "of the last 30 nights" });
    await expect(card).toBeVisible();
  });

  test("check your bags validates and routes to /b/<address>", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Check your bags" }).click();
    const field = page.getByLabel("Wallet address or ENS name");
    await expect(field).toBeFocused();
    await field.fill("not an address");
    await field.press("Enter");
    await expect(page.getByRole("alert").filter({ hasText: "0x address" })).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
    await field.fill("0x1111111111111111111111111111111111111111");
    await field.press("Enter");
    await expect(page).toHaveURL(/\/b\/0x1111111111111111111111111111111111111111$/);
  });

  test("no horizontal scroll at 375px, and the tower fits", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/");
    await towerReady(page);
    expect(await noHorizontalScroll(page)).toBe(true);
    await page.getByRole("button", { name: "Check your bags" }).click();
    expect(await noHorizontalScroll(page)).toBe(true);
  });

  test("touch: the first tap shows the card, the second opens the project", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    await page.goto("/");
    await towerReady(page);
    const first = page.locator("[data-tower-bays] [data-slug]").first();
    const slug = await first.getAttribute("data-slug");
    await first.scrollIntoViewIfNeeded();
    await first.tap();
    await expect(page.locator("[data-on][aria-hidden='true']").filter({ hasText: "of the last 30 nights" })).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
    await first.tap();
    await expect(page).toHaveURL(new RegExp(`/p/${slug}$`));
    await ctx.close();
  });

  test("reduced motion still renders the final building", async ({ browser }) => {
    const ctx = await browser.newContext({ reducedMotion: "reduce" });
    const page = await ctx.newPage();
    await page.goto("/");
    await towerReady(page);
    await expect(page.getByRole("heading", { level: 1 })).toHaveCSS("opacity", "1");
    await ctx.close();
  });
});

test.describe("linked pages exist", () => {
  for (const [path, heading] of [
    ["/night", "Last night's shift"],
    ["/methodology", "How a night is decided"],
    ["/docs", "Read it from your own code"],
    ["/b", "Check your bags"],
    ["/add", "Add a project to the watch"],
  ] as const) {
    test(`${path} renders`, async ({ page }) => {
      const res = await page.goto(path);
      expect(res?.status()).toBe(200);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(heading);
      await page.setViewportSize({ width: 375, height: 812 });
      expect(await noHorizontalScroll(page)).toBe(true);
    });
  }
});
