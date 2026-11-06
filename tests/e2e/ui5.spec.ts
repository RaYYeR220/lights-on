import { expect, test, type Page } from "@playwright/test";

const SECTIONS = ["How a night works", "Who it's for", "Why now"] as const;

const sections = (page: Page) => page.getByTestId("landing-sections");

/** Wait for the building to size itself: the sections below it share its width (--tower-bw). */
const towerSized = (page: Page) =>
  expect
    .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--tower-bw").trim()))
    .not.toBe("");

test.describe("the landing explains itself below the fold", () => {
  test("the hero fold is unchanged at 1440x900: the claim and both CTAs above the fold, the new sections below it", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    const h1 = page.getByRole("heading", { level: 1 });
    await expect(h1).toHaveText(/Know by morning if\s*they're still shipping\./);
    await expect(h1).toBeInViewport({ ratio: 1 });
    await expect(page.getByText("Every night an agent checks the projects you backed")).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole("link", { name: "See last night's shift" })).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole("button", { name: "Check your bags" })).toBeInViewport({ ratio: 1 });
    // the hero section is still the first thing in main, and nothing new sits inside it
    await expect(page.locator("main > section").first()).toHaveAttribute("aria-labelledby", "hero-title");
    await expect(page.locator('section[aria-labelledby="hero-title"]').getByTestId("landing-sections")).toHaveCount(0);
    for (const name of SECTIONS) await expect(page.getByRole("heading", { level: 2, name, exact: true })).not.toBeInViewport();
  });

  test("the study strip and the three sections are visible after scrolling, in order", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    const strip = page.getByRole("region", { name: "From the study" });
    await strip.scrollIntoViewIfNeeded();
    await expect(strip).toBeVisible();
    let lastTop = -Infinity;
    for (const name of SECTIONS) {
      const region = page.getByRole("region", { name, exact: true });
      const heading = region.getByRole("heading", { level: 2, name, exact: true });
      await heading.scrollIntoViewIfNeeded();
      await expect(heading).toBeInViewport();
      await expect(region).toBeVisible();
      const top = await region.evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
      expect(top).toBeGreaterThan(lastTop);
      lastTop = top;
    }
    const steps = page.getByRole("region", { name: "How a night works", exact: true }).getByRole("listitem");
    await expect(steps.getByRole("heading", { level: 3 })).toHaveText(["Read", "Decide", "Explain", "Attest"]);
  });

  test("every new link answers 200, and every #anchor lands on an element", async ({ page, request }) => {
    await page.goto("/");
    const hrefs = [...new Set(await sections(page).locator("a").evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? "")))];
    expect(hrefs.length).toBeGreaterThanOrEqual(8);
    expect(hrefs.some((h) => /^\/p\/[a-z0-9-]+$/.test(h))).toBe(true);
    for (const href of hrefs) {
      expect(href, href).toMatch(/^\//);
      const [pathname, anchor] = href.split("#");
      const res = await request.get(pathname);
      expect(res.status(), href).toBe(200);
      if (anchor) expect(await res.text(), `${href}: no id="${anchor}"`).toContain(`id="${anchor}"`);
    }
  });

  test("no horizontal scroll at 375px, and the grids are one column", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/");
    await towerSized(page);
    await sections(page).scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    // html clips overflow-x, so also check that nothing in the new sections pokes past the viewport
    const outside = await sections(page).evaluate((root) => {
      const vw = document.documentElement.clientWidth;
      return [...root.querySelectorAll("*")]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && (r.right > vw + 0.5 || r.left < -0.5);
        })
        .map((el) => `${el.tagName.toLowerCase()} ${el.textContent?.slice(0, 40)}`);
    });
    expect(outside).toEqual([]);
    for (const name of ["How a night works", "Who it's for"]) {
      const xs = await page
        .getByRole("region", { name, exact: true })
        .getByRole("listitem")
        .evaluateAll((lis) => lis.map((li) => Math.round(li.getBoundingClientRect().left)));
      expect(xs.length).toBe(4);
      expect(new Set(xs).size, name).toBe(1);
    }
  });
});

test.describe("study table styling (review minors)", () => {
  test("muted cells are ink-3 by specificity, and the sticky row header is opaque on the table's own fill", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/study");
    const table = page.getByTestId("v01-table");
    const ink3 = await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.color = "var(--ink-3)";
      document.body.append(probe);
      const c = getComputedStyle(probe).color;
      probe.remove();
      return c;
    });
    const muted = table.locator("td[class]").first();
    await expect(muted).toHaveCSS("color", ink3);
    const plain = table.locator("td:not([class])").first();
    await expect(plain).not.toHaveCSS("color", ink3);
    const th = table.locator("tbody th").first();
    await expect(th).toHaveCSS("position", "sticky");
    // the panel fill laid over the ground: an opaque colour under a gradient of the same fill
    await expect(th).toHaveCSS("background-color", "rgb(17, 24, 36)");
    expect(await th.evaluate((el) => getComputedStyle(el).backgroundImage)).toContain("rgba(16, 23, 35, 0.72)");
  });
});
