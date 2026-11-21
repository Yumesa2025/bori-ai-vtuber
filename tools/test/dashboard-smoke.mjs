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
  const errors = [];
  // 좁은 창(한 열 배치)에서도 표 머리가 행 클릭을 가리지 않는다(1280×720에서 sticky 머리가 두 번째 행을 덮던 문제).
  // 먼저 따로 닫는다. 창을 둘 띄워 두면 뒤 창의 타이머가 느려져 자동 읽기가 늦게 끝난다.
  const narrow = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  narrow.setDefaultTimeout(10_000);
  narrow.on("pageerror", error => errors.push(error.message));
  await narrow.goto(`${base}/companion/`);
  const narrowRow = narrow.getByRole("region", { name: "메타 TOP" }).locator("tbody tr").nth(1).getByRole("button");
  await narrowRow.click();
  await expect(narrowRow).toHaveAttribute("aria-pressed", "true");
  await narrow.close();

  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
  page.setDefaultTimeout(10_000);
  page.setDefaultNavigationTimeout(10_000);
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
  console.log("PASS dashboard smoke: 표, 상세 선택, 1280×720 행 선택, 다시 듣기 POST, 키 없음 (5/5)");
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
