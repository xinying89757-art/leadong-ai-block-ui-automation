// Headed, offline report acceptance. Never logs in or calls the AI platform.
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { buildRegressionHtml, writeRegressionReport } from "../src/ai-regression-report.mjs";
import { readableCheck } from "../src/ai-regression-report-view.mjs";

const id = process.argv.slice(2).find((arg) => arg.startsWith("--run-id="))?.slice(9);
const fixtureOnly = process.argv.includes("--fixture-only");
if (id && !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error("运行 ID 不合法");
const report = path.resolve("reports/ai-regression", id ? `${id}/report.html` : "latest.html");
const latest = path.resolve("reports/ai-regression/latest.html");
const out = path.resolve("output/playwright");
const temp = await mkdtemp(path.join(os.tmpdir(), "ai-report-ui-"));
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: false });
const errors = [];
const remoteRequests = [];
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.route(/^https?:\/\//, (route) => { remoteRequests.push(route.request().url()); return route.abort(); });
const page = await context.newPage();
page.on("pageerror", (error) => errors.push(error.message));

async function screenshotInteractions(file) {
  await page.goto(pathToFileURL(file).href);
  await page.locator("details.stage").evaluateAll((stages) => stages.forEach((stage) => { stage.open = true; }));
  const buttons = page.locator(".screenshot-thumb");
  const count = await buttons.count();
  assert.ok(count > 0, "实际报告应有可用失败截图");
  const dialog = page.getByRole("dialog", { name: "失败截图放大查看" });
  for (let i = 0; i < count; i++) {
    const button = buttons.nth(i);
    await button.scrollIntoViewIfNeeded();
    await button.locator("img").evaluate((img) => img.decode());
    assert.ok(await button.locator("img").evaluate((img) => img.naturalWidth > 0));
    await button.click();
    assert.equal(await dialog.isVisible(), true);
    await dialog.locator("img").evaluate((img) => img.decode());
    assert.ok(await dialog.locator("img").evaluate((img) => img.naturalWidth > 0));
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    assert.equal(await dialog.isVisible(), false);
    await button.click();
    await page.keyboard.press("Escape");
    assert.equal(await dialog.isVisible(), false);
  }
  return count;
}

async function verifyCorruptDataUrl() {
  const invalid = readableCheck({ label: "损坏截图", details: { screenshot: "data:image/png;base64,AAAA" } });
  await page.setContent(buildRegressionHtml({ runId: "broken-image", status: "failed", stages: [{ label: "截图", status: "failed", checks: [invalid] }] }));
  // Other unavailable-result notes can already exist. Wait for image handling,
  // not merely the first generic unavailable note, to avoid a decode-time race.
  await page.locator(".screenshot-thumb").waitFor({ state: "detached" });
  assert.equal(await page.locator(".unavailable").filter({ hasText: /^截图不可用$/ }).count(), 1);
}

try {
  if (fixtureOnly) {
    // A generated in-memory fixture, not a workaround to read any local page.
    const pixels = await page.screenshot();
    const large = `data:image/png;base64,${Buffer.concat([pixels, Buffer.alloc(6 * 1024 * 1024)]).toString("base64")}`;
    const item = readableCheck({ label: "截图测试", details: { generation: "succeeded", application: "applied", editor: true, saved: true, preview: true, published: true, screenshot: large } });
    await page.setContent(buildRegressionHtml({ runId: "memory-fixture", status: "failed", stages: [{ label: "离线截图", status: "failed", checks: [item] }] }));
    const button = page.locator(".screenshot-thumb");
    await button.locator("img").evaluate((img) => img.decode());
    await button.click();
    const dialog = page.getByRole("dialog");
    await dialog.locator("img").evaluate((img) => img.decode());
    assert.equal(await dialog.isVisible(), true);
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    assert.equal(await dialog.isVisible(), false);
    await button.click();
    await page.keyboard.press("Escape");
    assert.equal(await dialog.isVisible(), false);
    await verifyCorruptDataUrl();
    assert.deepEqual(errors, []);
    assert.deepEqual(remoteRequests, []);
    console.log(JSON.stringify({ ok: true, headed: true, fixtureOnly: true, largeImageDecode: true, zoomAndClose: true, escapeClose: true, corruptImageFallback: true }));
  } else {
  const count = await screenshotInteractions(report);
  const fullPage = page.locator(".check").filter({ has: page.getByText("整页生成", { exact: true }) }).first();
  if (id === "regression-20260928092023") {
    const text = await fullPage.innerText();
    assert.match(text, /生成通过/); assert.match(text, /保存通过/); assert.match(text, /预览通过/);
    assert.match(text, /发布通过/); assert.match(text, /公开页验证失败/);
    assert.doesNotMatch(text, /生成失败/);
    await fullPage.scrollIntoViewIfNeeded();
    await fullPage.screenshot({ path: path.join(out, "ai-report-full-page-result.png") });
    await fullPage.locator(".screenshot-thumb").click();
    await page.screenshot({ path: path.join(out, "ai-report-screenshot-viewer.png") });
    await page.keyboard.press("Escape");
  }
  const body = await page.locator("body").innerText();
  assert.doesNotMatch(body, /状态来源|\/Users\/|Call log:|locator\.|\btrue\b|\bfalse\b|original_prompt|publicUrl|Authorization/);
  assert.equal((await page.locator('a[href^="data:"]').count()), 0);
  assert.equal(await page.locator(".summary .metric").count(), 5);
  await page.evaluate(() => { document.querySelectorAll("details.stage").forEach((stage) => { stage.open = false; }); window.scrollTo(0, 0); });
  await page.screenshot({ path: path.join(out, "ai-report-overview.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "移动布局不应横向溢出");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await screenshotInteractions(latest);
  const copied = path.join(temp, "copied-report.html");
  await copyFile(report, copied);
  await screenshotInteractions(copied);

  // Use an actual valid PNG plus trailing padding to cover the former 5MB cutoff.
  const large = path.join(temp, "large.png");
  await writeFile(large, Buffer.concat([await readFile(path.join(out, "ai-report-overview.png")), Buffer.alloc(6 * 1024 * 1024)]));
  const corrupted = path.join(temp, "corrupt.png");
  await writeFile(corrupted, "not a valid image");
  const source = path.join(temp, "runs/fixture/ai-history-reuse/state.json");
  await mkdir(path.dirname(source), { recursive: true });
  const section = (screenshot) => ({ page: { saved: true, editor_verified: true, preview_verified: true, published_verified: true, failure_screenshot: screenshot }, generation: { generation_status: "succeeded", application_status: "applied" }, history: { reopened: true, match_status: "succeeded", application_source: "history" }, block_count_before: 0, block_count_after: 1 });
  await writeFile(source, JSON.stringify({ full_page: section(large), block: section(corrupted) }));
  const fixture = await writeRegressionReport({ paths: { aiRegressionReportsDir: path.join(temp, "reports") } }, { run_id: "fixture", status: "passed", stages: [{ key: "history-reuse", status: "passed", result: { stateFile: source } }] }, { root: temp });
  assert.equal(await screenshotInteractions(fixture.file), 1);
  assert.equal(await page.locator(".unavailable").count(), 1);
  await writeFile(source, JSON.stringify({ full_page: section(path.join(temp, "missing.png")), block: section(corrupted) }));
  const missing = await writeRegressionReport({ paths: { aiRegressionReportsDir: path.join(temp, "reports") } }, { run_id: "fixture", status: "passed", stages: [{ key: "history-reuse", status: "passed", result: { stateFile: source } }] }, { root: temp });
  await page.goto(pathToFileURL(missing.file).href);
  await page.locator("details.stage").evaluateAll((stages) => stages.forEach((stage) => { stage.open = true; }));
  assert.equal(await page.locator(".unavailable").count(), 2);
  assert.equal(await page.locator(".screenshot-thumb").count(), 0);

  // Invalid image bytes that superficially look like a data URL must degrade
  // gracefully at browser decode time as well as at file validation time.
  await verifyCorruptDataUrl();
  assert.deepEqual(remoteRequests, []);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, headed: true, offline: true, report, embeddedScreenshots: count, zoomAndClose: true, escapeClose: true, latestAndCopiedReport: true, largeMissingCorruptImages: true, mobileLayout: true, screenshotDir: out }, null, 2));
  }
} finally {
  await browser.close();
  await rm(temp, { recursive: true, force: true });
}
