import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { availablePort, projectRoot, waitForHttp } from "./harness.mjs";
import { join } from "node:path";

// dev:mock과 같은 Vite 진입점. 셸 없이 띄워 Windows에서도 자식을 확실히 정리한다.
const port = await availablePort();
const child = spawn(process.execPath, [join(projectRoot, "node_modules/vite/bin/vite.js"), "--mode", "mock", "--port", String(port)], {
  cwd: join(projectRoot, "apps/companion"), env: { ...process.env, BORI_MOCK_SCENARIO: "ready" }, stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", data => { output += data; });
child.stderr.on("data", data => { output += data; });
const base = `http://127.0.0.1:${port}`;
let browser;
try {
  await waitForHttp(`${base}/__mock/scenario`);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
  page.setDefaultTimeout(10_000);
  page.setDefaultNavigationTimeout(10_000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${base}/companion/`);
  const table = page.getByRole("region", { name: "메타 TOP" });
  await expect(table.getByRole("table")).toBeVisible();
  const row = table.locator("tbody tr").nth(1).getByRole("button");
  const label = await row.innerText();
  await row.click();
  await expect(row).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#detail-title")).toHaveText(`${label.split(" ")[0]} 상세`);
  const replayResponse = page.waitForResponse(response => response.url().endsWith("/api/narration/replay") && response.request().method() === "POST");
  await page.getByRole("button", { name: "다시 듣기", exact: true }).click();
  expect((await replayResponse).ok()).toBeTruthy();
  const changed = await page.request.post(`${base}/__mock/scenario`, { data: { name: "no-key" } });
  expect(changed.ok()).toBeTruthy();
  await page.reload();
  await expect(page.getByRole("alert").filter({ hasText: "키" })).toBeVisible();
  await expect(page.locator(".refresh button")).toBeDisabled();
  expect(errors).toEqual([]);
  console.log("PASS dashboard smoke: 표, 상세 선택, 다시 듣기 POST, 키 없음 (4/4)");
} catch (error) {
  console.error(output);
  throw error;
} finally {
  await browser?.close();
  if (child.exitCode === null) {
    const exited = new Promise(resolve => child.once("exit", resolve));
    child.kill();
    await exited;
  }
}
