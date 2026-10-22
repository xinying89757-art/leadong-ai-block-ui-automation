#!/usr/bin/env node
// Isolate prompt acceptance from page creation. This command generates once
// but never applies, saves, or publishes a page.
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { loadConfig } from "./config.mjs";
import { LeadongEditor, launchEditorBrowser } from "./editor.mjs";
import { AiFullPageAutomation } from "./ai-full-page-runner.mjs";

if (!process.argv.includes("--apply")) throw new Error("提示词对照生成需显式传 --apply");
const config = await loadConfig("config/run.json");
const runId = `probe-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
const prompt = process.argv.find((value) => value.startsWith("--prompt="))?.slice(9) || "首页";
const noHistoryBefore = process.argv.includes("--no-history-before");
const file = path.join(config.paths.aiLifecycleDir, "full-page-probes", `${runId}.json`);
const result = { runId, prompt, startedAt: new Date().toISOString(), request: null, record: null, error: "" };
const { context, page } = await launchEditorBrowser(config, { headless: false, isolatedProfile: false, slowMo: 0 });
const baselineHistoryItems = [];
const onListResponse = async (response) => {
  if (response.request().method() !== "GET" ||
      new URL(response.url()).pathname !== "/phoenix2/composite/copilot-ai-api/page-gen-records") return;
  try {
    const body = await response.json();
    if (!baselineHistoryItems.length && Array.isArray(body?.data?.list)) {
      for (const item of body.data.list) baselineHistoryItems.push(item);
    }
  } catch { /* UI evidence remains available. */ }
};
context.on("response", onListResponse);
try {
  const editor = new LeadongEditor(page, config);
  await editor.goto();
  const runner = new AiFullPageAutomation(editor, config, runId);
  runner.state = { generation: {}, page: {} };
  runner.persist = async () => {};
  const frame = await runner.openGenerator();
  const baseline = await runner.historyBaseline(frame);
  const before = new Set();
  const cards = frame.locator("article.ai-page-history-card");
  if (!noHistoryBefore) {
    await frame.locator("button.ai-page-history-trigger").first().click();
    await cards.first().waitFor({ state: "visible", timeout: config.timeouts.actionMs });
    for (let i = 0; i < await cards.count(); i += 1) before.add(await cards.nth(i).innerText());
    await frame.locator("button.ai-page-history-back").first().click();
    await frame.locator("textarea.ai-prompt-input--card").first().waitFor({ state: "visible", timeout: config.timeouts.actionMs });
  }
  result.historyCountBefore = baseline;
  result.historySnapshotBefore = before.size;
  result.historyItemsBefore = baselineHistoryItems;
  await runner.selectInputs(frame, prompt);
  const responses = [];
  const onResponse = async (response) => {
    if (response.request().method() !== "POST" || !new URL(response.url()).pathname.endsWith("/generate-page")) return;
    const raw = response.request().postData() ?? "";
    const entry = {
      status: response.status(),
      promptSubmitted: raw.includes(prompt),
      fromServiceWorker: response.fromServiceWorker(),
      cacheHeader: response.headers()["x-cache"] ?? "",
    };
    try {
      const body = response.request().postDataJSON();
      entry.requestKeys = body && typeof body === "object" ? Object.keys(body) : [];
      for (const key of ["pageRecordId", "recordId", "requestId", "tierKey", "mode", "inputMode", "userPrompt", "prompt"]) {
        if (body?.[key] !== undefined) entry[key] = String(body[key]).slice(0, 160);
      }
    } catch { /* Raw prompt comparison remains available. */ }
    try {
      const body = await response.json();
      entry.code = body?.code;
      entry.message = body?.message ?? body?.msg ?? "";
      entry.dataKeys = body?.data && typeof body.data === "object" ? Object.keys(body.data) : [];
      entry.pageRecordId = body?.data?.pageRecordId ?? null;
      entry.generationStatus = body?.data?.status ?? null;
    } catch { /* The status is still evidence. */ }
    responses.push(entry);
  };
  context.on("response", onResponse);
  try {
    await frame.locator("button.ai-generate-btn").first().click({ noWaitAfter: true });
    const deadline = Date.now() + 180000;
    let lastRefresh = Date.now();
    while (Date.now() < deadline) {
      result.request = responses[0] ?? null;
      // pageRecordId identifies the generated page returned by the submit
      // endpoint. It is not the id of a history card, so it is retained as
      // evidence only and is never compared with history item ids.
      for (let i = 0; i < await cards.count(); i += 1) {
        const text = await cards.nth(i).innerText().catch(() => "");
        const stamp = text.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/)?.[0];
        const createdAt = stamp ? Date.parse(`${stamp.replace(" ", "T")}+08:00`) : NaN;
        if (!before.has(text) && text.startsWith(prompt) && createdAt >= Date.parse(result.startedAt) - 5000) {
          result.record = { text: text.slice(0, 1000), className: await cards.nth(i).getAttribute("class") };
          break;
        }
      }
      if (result.record) break;
      if (Date.now() - lastRefresh >= 15000) {
        try { await runner.refreshHistory(frame); result.lastRefreshSucceeded = true; }
        catch (error) { result.lastRefreshSucceeded = false; result.lastRefreshError = error.message; }
        lastRefresh = Date.now();
      }
      await page.waitForTimeout(2000);
    }
  } finally { context.off("response", onResponse); }
  result.finishedAt = new Date().toISOString();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  result.error = error.message;
  result.finishedAt = new Date().toISOString();
  process.stderr.write(`整页提示词对照失败：${error.message}\n`);
  process.exitCode = 1;
} finally {
  context.off("response", onListResponse);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await context.close().catch(() => {});
}
