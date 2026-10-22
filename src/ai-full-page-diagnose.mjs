#!/usr/bin/env node
// Read-only UI diagnostic: inspect the full-page generation history without
// submitting another generation request.
import { loadConfig } from "./config.mjs";
import { LeadongEditor, launchEditorBrowser } from "./editor.mjs";

async function firstVisible(locator) {
  const count = await locator.count();
  for (let i = 0; i < count; i += 1) {
    if (await locator.nth(i).isVisible().catch(() => false)) return locator.nth(i);
  }
  return null;
}

const config = await loadConfig("config/run.json");
const { context, page } = await launchEditorBrowser(config, { headless: false, slowMo: 0 });
const network = [];
const onResponse = async (response) => {
  if (!response.url().includes("/copilot-ai-api/")) return;
  const requestUrl = new URL(response.url());
  const entry = { method: response.request().method(), path: requestUrl.pathname, query: requestUrl.search, status: response.status() };
  try {
    const body = await response.json();
    entry.code = body?.code;
    entry.dataType = Array.isArray(body?.data) ? "array" : typeof body?.data;
    entry.dataKeys = body?.data && typeof body.data === "object" ? Object.keys(body.data).slice(0, 12) : [];
    entry.dataLength = Array.isArray(body?.data) ? body.data.length : undefined;
    if (Array.isArray(body?.data?.list)) {
      entry.total = body.data.total;
      entry.items = body.data.list.map((item) => ({
        id: item.id,
        status: item.status,
        prompt: String(item.userPrompt ?? item.prompt ?? "").slice(0, 100),
        createdAt: item.createdAt ?? item.createTime ?? item.gmtCreate,
      }));
    } else if (body?.data?.id) {
      entry.record = {
        id: body.data.id,
        status: body.data.status,
        prompt: String(body.data.userPrompt ?? "").slice(0, 120),
        failureReason: body.data.failureReason ?? body.data.failReason ?? body.data.errorMessage ?? "",
        errorMsg: body.data.errorMsg ?? "",
        fields: Object.keys(body.data),
      };
    }
  } catch { /* Non-JSON responses are still useful. */ }
  network.push(entry);
};
if (process.argv.includes("--network")) context.on("response", onResponse);
try {
  const editor = new LeadongEditor(page, config);
  await editor.goto();
  await editor.waitForCanvasReady();
  await page.waitForTimeout(config.ai.fullPageRegression.editorStabilizeMs ?? 5000);
  await editor.openCustomPageList();
  const newPage = await firstVisible(page.getByText("新建页面", { exact: true }));
  if (!newPage) throw new Error("未找到新建页面入口");
  await newPage.click();
  const create = await firstVisible(page.locator("span.ai-page-create"));
  if (!create) throw new Error("未找到 AI 生成整页入口");
  await create.click();
  const frame = page.frames().find((candidate) => candidate.url().includes(config.selectors.aiEditorFrameUrlIncludes)) ?? await page.waitForEvent("framenavigated", {
    predicate: (candidate) => candidate.url().includes(config.selectors.aiEditorFrameUrlIncludes),
    timeout: config.timeouts.blockRenderMs,
  }).catch(() => page.frames().find((candidate) => candidate.url().includes(config.selectors.aiEditorFrameUrlIncludes)));
  if (!frame) throw new Error("整页 AI iframe 未加载");
  const history = frame.locator("button.ai-page-history-trigger").first();
  await history.waitFor({ state: "visible", timeout: config.timeouts.blockRenderMs });
  await history.click();
  const cards = frame.locator("article.ai-page-history-card");
  await cards.first().waitFor({ state: "visible", timeout: config.timeouts.actionMs }).catch(() => {});
  const result = [];
  for (let i = 0; i < await cards.count(); i += 1) {
    const card = cards.nth(i);
    result.push({
      index: i,
      text: (await card.innerText()).slice(0, 800),
      className: await card.getAttribute("class"),
      id: await card.getAttribute("data-id"),
    });
  }
  const output = { count: result.length, records: result };
  if (process.argv.includes("--refresh-check")) {
    const back = frame.locator("button.ai-page-history-back").first();
    output.backVisible = await back.isVisible().catch(() => false);
    if (output.backVisible) {
      await back.click();
      await frame.waitForTimeout(1000);
      output.afterBack = {
        promptVisible: await frame.locator("textarea.ai-prompt-input--card").first().isVisible().catch(() => false),
        historyTriggerVisible: await history.isVisible().catch(() => false),
        bodyText: (await frame.locator("body").innerText().catch(() => "")).slice(0, 500),
      };
      if (output.afterBack.promptVisible && output.afterBack.historyTriggerVisible) {
        await history.click();
        await frame.waitForTimeout(1000);
        output.afterReopenCount = await cards.count();
      }
    }
  }
  if (process.argv.includes("--fetch")) {
    output.fetch = await frame.evaluate(async () => {
      const base = "/phoenix2/composite/copilot-ai-api/page-gen-records";
      const summarize = async (url) => {
        const response = await fetch(url, { credentials: "include" });
        const body = await response.json().catch(() => ({}));
        return {
          httpStatus: response.status,
          code: body?.code,
          total: body?.data?.total,
          items: Array.isArray(body?.data?.list) ? body.data.list.map((item) => ({ id: item.id, status: item.status })) : undefined,
          record: body?.data?.id ? { id: body.data.id, status: body.data.status, prompt: String(body.data.userPrompt ?? "").slice(0, 100) } : undefined,
        };
      };
      return { list: await summarize(base), probeRecord: await summarize(`${base}/VoUpfAKUimKr`) };
    }).catch((error) => ({ error: error.message }));
  }
  if (process.argv.includes("--pagination-check")) {
    const responsePromise = context.waitForEvent("response", {
      predicate: (response) => response.request().method() === "GET" &&
        new URL(response.url()).pathname === "/phoenix2/composite/copilot-ai-api/page-gen-records",
      timeout: config.timeouts.actionMs,
    });
    await frame.locator("button.ai-page-history-back").first().click();
    await history.click();
    const listResponse = await responsePromise;
    const headers = await listResponse.request().allHeaders();
    for (const key of Object.keys(headers)) if (key.startsWith(":")) delete headers[key];
    delete headers.host;
    delete headers["content-length"];
    const url = new URL(listResponse.url());
    url.searchParams.set("page", "1");
    url.searchParams.set("size", "100");
    const allResponse = await context.request.get(url.toString(), { headers });
    const allBody = await allResponse.json();
    output.pagination = {
      httpStatus: allResponse.status(),
      code: allBody?.code,
      total: allBody?.data?.total,
      ids: Array.isArray(allBody?.data?.list) ? allBody.data.list.map((item) => item.id) : [],
    };
  }
  if (process.argv.includes("--network")) output.network = network.filter((entry, index) =>
    network.findIndex((candidate) => candidate.path === entry.path) === index);
  if (process.argv.includes("--summary")) {
    output.records = output.records.map((item) => ({ index: item.index, className: item.className, text: item.text.slice(0, 90) }));
    if (output.network) output.network = output.network.map((item) => ({
      path: item.path,
      total: item.total,
      record: item.record && {
        id: item.record.id,
        status: item.record.status,
        errorMsg: item.record.errorMsg,
      },
    }));
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
} finally {
  context.off("response", onResponse);
  await context.close();
}
