import { expect, test } from "@playwright/test";
import headline from "../../results/headline.json";
import v01 from "../../results/study-vibeathon01.json";
import cvs from "../../results/commit-vs-ship.json";

const sentence = (id: string) => headline.candidates.find((c) => c.id === id)!.text;

test.describe("study", () => {
  test("/study shows the hackathon sentence, the 10 finalists and both commit-vs-ship lists", async ({ page }) => {
    await page.goto("/study");
    await expect(page).toHaveTitle("Study · Lights On");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(sentence("hackathon-quiet"));
    await expect(page.getByText(headline.basis).first()).toBeVisible();

    // one labelled facade row per cohort
    const rows = page.getByTestId("cohorts").getByRole("img");
    await expect(rows).toHaveCount(4);
    await expect(rows.first()).toHaveAttribute("aria-label", /active in the last 30 nights/);

    const table = page.getByTestId("v01-table");
    expect(v01.perProject).toHaveLength(10);
    await expect(table.locator("tbody tr")).toHaveCount(10);
    await expect(table.getByRole("link", { name: "aHand" })).toHaveAttribute("href", "/p/ahand");
    await expect(page.getByTestId("v01-summary")).toHaveText(`${v01.summary.liveUp} of ${v01.summary.finalists} live apps still answer`);

    const commits = page.getByTestId("cvs-commits");
    await expect(commits.locator("li")).toHaveCount(cvs.commitsNoVerifiedShip.length);
    for (const name of cvs.commitsNoVerifiedShip) await expect(commits).toContainText(name);
    const ships = page.getByTestId("cvs-ships");
    await expect(ships.locator("li")).toHaveCount(cvs.shipNightsWithoutCodeCommits.length);
    for (const s of cvs.shipNightsWithoutCodeCommits) await expect(ships).toContainText(s.name);
    await expect(page.locator("main")).not.toContainText(/\b(abandoned|dead|scam|inactive)\b/i);
  });

  test("a finalist links to its project page", async ({ page }) => {
    await page.goto("/study");
    await page.getByTestId("v01-table").getByRole("link", { name: "aHand" }).click();
    await expect(page).toHaveURL(/\/p\/ahand$/);
  });

  test("the landing and the header nav link to /study", async ({ page }) => {
    await page.goto("/");
    const strip = page.getByRole("region", { name: "From the study" });
    await expect(strip).toContainText(sentence("hackathon-quiet"));
    await expect(strip.getByRole("link", { name: "Read the study" })).toHaveAttribute("href", "/study");
    const nav = page.getByRole("navigation", { name: "Primary" });
    await expect(nav.getByRole("link", { name: "Study" })).toHaveAttribute("href", "/study");
    await nav.getByRole("link", { name: "Study" }).click();
    await expect(page).toHaveURL(/\/study$/);
    await expect(nav.getByRole("link", { name: "Study" })).toHaveAttribute("aria-current", "page");
  });

  test("/study/vibeathon-01 redirects to the section", async ({ page, request }) => {
    const res = await request.get("/study/vibeathon-01", { maxRedirects: 0 });
    expect(res.status()).toBe(307);
    expect(res.headers()["location"]).toBe("/study#vibeathon-01");
    await page.goto("/study/vibeathon-01");
    await expect(page).toHaveURL(/\/study#vibeathon-01$/);
    await expect(page.getByRole("heading", { level: 2, name: `Vibeathon 01, ${v01.daysSinceResults} days later` })).toBeInViewport();
  });
});
