import { expect, test, type Page } from "@playwright/test";
import { keccak256, toBytes } from "viem";
import { RULES_TEXT } from "../../src/lib/shift/rules";

const BACKER = "0x60bc5323c0e0e9144af0b35ce8de119fc743e345";

const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

async function openLastNight(page: Page) {
  await page.goto("/p/revoke-cash");
  const panes = page.getByTestId("night-strip").locator("button");
  await expect(panes).toHaveCount(90);
  await panes.last().click();
  const drawer = page.getByTestId("night-drawer");
  await expect(drawer).toBeVisible();
  return drawer;
}

test.describe("project page", () => {
  test("revoke-cash: header, 90-night strip, drawer with evidence by tier", async ({ page }) => {
    const drawer = await openLastNight(page);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Revoke.cash");
    await expect(page.getByTestId("project-status")).toContainText(/Lit \d+ of the last 30/);
    await expect(drawer.getByRole("heading", { name: /Night of/ })).toBeVisible();
    await expect(drawer).toContainText("VERIFIED");
    await expect(drawer).toContainText("REPORTED");
    await expect(drawer.getByText("Repo", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
  });

  test("Verify on a reconstructed night re-hashes the bundle and says it was never attested", async ({ page }) => {
    const drawer = await openLastNight(page);
    await expect(drawer.getByTestId("attestation-state")).toHaveText(/never attested|not attested yet|0x/);
    const reconstructed = (await drawer.getByTestId("attestation-state").textContent())?.includes("never attested");
    test.skip(!reconstructed, "the latest night is observed now; covered by the live-night checks");
    await drawer.getByRole("button", { name: "Verify in this browser" }).click();
    const checks = drawer.getByTestId("verify-checks");
    await expect(checks).toContainText("never attested");
    await expect(checks.locator("li").first()).toContainText("PASS");
  });

  test("the evidence route returns a body whose keccak256 equals its hash", async ({ page, request }) => {
    const drawer = await openLastNight(page);
    const href = await drawer.locator('a[href^="/api/v1/evidence/"]').first().getAttribute("href");
    expect(href).toMatch(/^\/api\/v1\/evidence\/0x[0-9a-f]{64}$/);
    const res = await request.get(href!);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("application/json");
    expect(res.headers()["cache-control"]).toContain("immutable");
    const body = await res.text();
    expect(keccak256(toBytes(body))).toBe(href!.split("/").pop());
    expect((await request.get("/api/v1/evidence/0x1234")).status()).toBe(400);
    expect((await request.get(`/api/v1/evidence/0x${"00".repeat(32)}`)).status()).toBe(404);
  });

  test("keyboard: arrows move along the strip, Enter opens the night", async ({ page }) => {
    await page.goto("/p/revoke-cash");
    const panes = page.getByTestId("night-strip").locator("button");
    await panes.last().focus();
    await page.keyboard.press("ArrowLeft");
    await expect(panes.nth(88)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("night-drawer")).toBeVisible();
  });

  test("run a shift now: streams steps into a checklist and ends with the attestation line", async ({ page }) => {
    await page.route("**/api/shift/live?project=revoke-cash", (route) =>
      route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: [
          ": lights on",
          "",
          "event: step",
          'data: {"at":"2026-11-06T12:00:00Z","key":"repo","label":"Reading the repo","state":"start"}',
          "",
          "event: step",
          'data: {"at":"2026-11-06T12:00:01Z","key":"repo","label":"Reading the repo","state":"ok","detail":"3 commits"}',
          "",
          "event: done",
          'data: {"status":"building","evidenceHash":null,"attestationUid":null,"txHash":null,"attestSkipped":"gas_cap"}',
          "",
          "",
        ].join("\n"),
      }),
    );
    await page.goto("/p/revoke-cash");
    const live = page.getByTestId("live-shift");
    await live.getByRole("button", { name: "Run a shift now" }).click();
    await expect(live.locator("li")).toHaveCount(1);
    await expect(live).toContainText("3 commits");
    await expect(live).toContainText("attestation: skipped (the daily gas cap is reached)");
  });

  test("run a shift now: a 429 shows when to retry, a 503 says it is unavailable", async ({ page }) => {
    let n = 0;
    await page.route("**/api/shift/live?project=revoke-cash", (route) =>
      ++n === 1
        ? route.fulfill({ status: 429, headers: { "retry-after": "240", "content-type": "application/json" }, body: '{"error":"rate_limited","reason":"per_ip","retryAfterSec":240}' })
        : route.fulfill({ status: 503, headers: { "content-type": "application/json" }, body: '{"error":"misconfigured"}' }),
    );
    await page.goto("/p/revoke-cash");
    const live = page.getByTestId("live-shift");
    await live.getByRole("button", { name: "Run a shift now" }).click();
    await expect(live.getByRole("alert")).toContainText("Try again in 4 min");
    await live.getByRole("button", { name: "Run again" }).click();
    await expect(live.getByRole("alert")).toContainText("not available");
  });

  test("unknown project is a 404", async ({ page }) => {
    const res = await page.goto("/p/no-such-project");
    expect(res?.status()).toBe(404);
  });
});

test.describe("night pages", () => {
  test("/night is honest about live vs reconstructed", async ({ page }) => {
    await page.goto("/night");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Last night's shift");
    const notice = page.getByTestId("night-notice");
    if (await notice.isVisible()) {
      await expect(notice).toContainText("No live shift has run yet");
      await expect(notice).toContainText("05:00 UTC");
      await expect(notice).toContainText("preview");
      await expect(page.getByText("reconstructed: never attested")).toBeVisible();
      await expect(page.getByText(/multiAttest tx/)).toHaveCount(0);
    } else {
      await expect(page.getByText(/multiAttest tx|not attested yet/).first()).toBeVisible();
    }
  });

  test("/night/<date> validates the date", async ({ page }) => {
    expect((await page.goto("/night/2026-02-30"))?.status()).toBe(404);
    expect((await page.goto("/night/2026-11-05"))?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("The shift of 5 Nov 2026");
  });
});

test.describe("backer pages", () => {
  test("/b offers a real backer", async ({ page }) => {
    await page.goto("/b");
    await expect(page.getByText("a real Corvo Edge backer · 0x60bc…e345")).toBeVisible();
    await page.getByRole("link", { name: "Try a real backer" }).click();
    await expect(page).toHaveURL(new RegExp(`/b/${BACKER}$`));
    await expect(page.getByTestId("backer-projects")).toContainText("Corvo Edge", { timeout: 45_000 });
  });

  test("/b/<address> shows the projects and the briefing", async ({ page }) => {
    await page.goto(`/b/${BACKER}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Bags of 0x60bc…e345");
    await expect(page.getByTestId("backer-projects")).toContainText("ETH on Vibestarter");
    await expect(page.getByTestId("briefing")).toContainText("Corvo Edge");
  });

  test("a bad address explains itself", async ({ page }) => {
    await page.goto("/b/not-an-address");
    await expect(page.getByText("That is not a wallet address or an ENS name.")).toBeVisible();
  });
});

test.describe("reference pages", () => {
  test("/methodology quotes every rule verbatim and lists the limits", async ({ page }) => {
    await page.goto("/methodology");
    const rules = page.getByTestId("rules").locator("li");
    await expect(rules).toHaveCount(RULES_TEXT.length);
    for (let i = 0; i < RULES_TEXT.length; i++) await expect(rules.nth(i)).toHaveText(RULES_TEXT[i]);
    await expect(page.getByTestId("limits")).toContainText("Private repos");
  });

  test("/docs documents REST, MCP and verify", async ({ page }) => {
    await page.goto("/docs");
    await expect(page.getByText("GET /api/v1/evidence/{hash}")).toBeVisible();
    await expect(page.getByText(/claude mcp add --transport http lights-on/)).toBeVisible();
    await expect(page.getByText(/"mcpServers"/)).toBeVisible();
  });

  test("/add explains that community projects are unlisted", async ({ page }) => {
    await page.goto("/add");
    await expect(page.getByText("Community-added projects are unlisted")).toBeVisible();
  });

  for (const path of ["/p/revoke-cash", "/night", `/b/${BACKER}`, "/methodology", "/docs", "/add"]) {
    test(`${path} has no horizontal scroll at 375px`, async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 812 });
      await page.goto(path);
      expect(await noHorizontalScroll(page)).toBe(true);
    });
  }
});
