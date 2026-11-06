import { expect, test } from "@playwright/test";

test.describe("founder claim", () => {
  test("/claim/<slug> renders the connect step", async ({ page }) => {
    await page.goto("/claim/corvo-edge");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Claim Corvo Edge");
    const flow = page.getByTestId("claim-flow");
    await expect(flow.getByRole("heading", { name: /Connect the founder wallet/ })).toBeVisible();
    await expect(flow.getByText("Nothing is sent on chain")).toBeVisible();
    const connect = flow.getByRole("button", { name: "Browser wallet" });
    await expect(connect).toBeVisible();
    // this browser has no wallet: the page says so instead of failing silently
    await connect.click();
    await expect(flow.getByRole("alert")).toContainText(/No browser wallet found|did not connect/);
  });

  test("/claim for an unknown project is a 404", async ({ page }) => {
    expect((await page.goto("/claim/no-such-project"))?.status()).toBe(404);
  });

  test("the project page links to its claim flow", async ({ page }) => {
    await page.goto("/p/corvo-edge");
    await page.getByRole("link", { name: /Claim it|Founder tools/ }).click();
    await expect(page).toHaveURL(/\/claim\/corvo-edge$/);
  });
});

test.describe("add a project", () => {
  test("validates in the browser before anything is sent", async ({ page }) => {
    let calls = 0;
    await page.route("**/api/v1/watch", (route) => {
      calls++;
      return route.fulfill({ status: 500, body: "{}" });
    });
    await page.goto("/add");
    const form = page.getByTestId("watch-form");
    await form.getByRole("button", { name: "Add to the watch" }).click();
    await expect(form.getByText(/A live URL is required/)).toBeVisible();
    await form.getByLabel(/Live URL/).fill("app.example");
    await form.getByLabel(/Contract on Base/).fill("0x123");
    await form.getByRole("button", { name: "Add to the watch" }).click();
    await expect(form.getByText(/full web address/)).toBeVisible();
    await expect(form.getByText(/0x contract address on Base/)).toBeVisible();
    expect(calls).toBe(0);
  });

  test("a 429 says when to try again", async ({ page }) => {
    await page.route("**/api/v1/watch", (route) =>
      route.fulfill({ status: 429, headers: { "retry-after": "3600", "content-type": "application/json" }, body: '{"error":"rate_limited"}' }),
    );
    await page.goto("/add");
    const form = page.getByTestId("watch-form");
    await form.getByLabel(/Live URL/).fill("https://app.example.xyz");
    await form.getByRole("button", { name: "Add to the watch" }).click();
    await expect(form.getByRole("alert")).toContainText("Try again in 60 min");
  });

  test("queued and exists answers link to the project page; unlisted is explained", async ({ page }) => {
    let n = 0;
    await page.route("**/api/v1/watch", (route) =>
      route.fulfill({
        status: 202,
        headers: { "content-type": "application/json" },
        body: ++n === 1 ? '{"slug":"app-example-xyz","status":"queued"}' : '{"slug":"revoke-cash","status":"exists"}',
      }),
    );
    await page.goto("/add");
    await expect(page.getByText("Community-added projects are unlisted")).toBeVisible();
    const form = page.getByTestId("watch-form");
    await form.getByLabel(/Live URL/).fill("https://app.example.xyz");
    await form.getByLabel(/^Repo/).fill("owner/name");
    await form.getByRole("button", { name: "Add to the watch" }).click();
    const result = page.getByTestId("watch-result");
    await expect(result).toContainText("Queued");
    await expect(result).toContainText("joins the building only after review");
    await expect(result.getByRole("link", { name: "/p/app-example-xyz" })).toHaveAttribute("href", "/p/app-example-xyz");
    await form.getByRole("button", { name: "Add to the watch" }).click();
    await expect(result).toContainText("Already on the watch");
  });
});

test.describe("tranches and assets", () => {
  test("a Vibestarter project shows its tranche schedule", async ({ page }) => {
    await page.goto("/p/corvo-edge");
    const t = page.getByTestId("tranches");
    await expect(t).toContainText("Kickstart");
    await expect(t).toContainText(/Read from Vibestarter|did not answer/);
  });

  test("share image and icons are served", async ({ request }) => {
    const og = await request.get("/opengraph-image");
    expect(og.status()).toBe(200);
    expect(og.headers()["content-type"]).toContain("image/png");
    for (const path of ["/icon.png", "/icon.svg", "/apple-icon.png", "/favicon.ico"]) {
      expect((await request.get(path)).status(), path).toBe(200);
    }
    const reg = await request.get("/.well-known/agent-registration.json");
    expect(reg.status()).toBe(200);
    expect(new URL((await reg.json()).image).pathname).toBe("/icon.png");
  });

  test("the landing links the share image", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute("content", /opengraph-image/);
  });
});
