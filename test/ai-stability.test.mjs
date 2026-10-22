import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";
import { createInitialAiState, markTypeApplied } from "../src/ai-state.mjs";
import { AiPagedAutomation, canContinueTypeFailure } from "../src/ai-paged-runner.mjs";
import { pageContentSnapshot, waitForCompleteContent } from "../src/ai-content-ready.mjs";
import { AiFullPageAutomation } from "../src/ai-full-page-runner.mjs";
import { AiModePointsAutomation } from "../src/ai-mode-points-runner.mjs";
import { createModePointsState, modeResumeAction } from "../src/ai-mode-points-state.mjs";

test("整页等待所有区块而非首个区块；占位、加载中和错误目标均不能提前完成", async () => {
  const started = Date.now();
  let calls = 0;
  const snapshots = [
    { count: 1, readyCount: 1, loading: false },
    { count: 3, readyCount: 1, loading: false },
    { count: 3, readyCount: 3, loading: true },
    { count: 3, readyCount: 3, loading: false, targetMatched: false },
    { count: 3, readyCount: 3, loading: false, applicationMatched: false },
  ];
  const evidence = await waitForCompleteContent(async () => {
    calls += 1;
    return { fingerprint: "complete", ...(snapshots.shift() ?? { count: 3, readyCount: 3, loading: false }) };
  }, { expectedCount: 3, timeoutMs: 200, stableMs: 15, pollMs: 2 });
  assert.ok(calls >= 7);
  assert.ok(Date.now() - started >= 15);
  assert.equal(evidence.readyCount, 3);
  await assert.rejects(waitForCompleteContent(async () => ({ count: 3, readyCount: 2, loading: false }),
    { expectedCount: 3, timeoutMs: 10, pollMs: 1 }), { code: "APPLICATION_INCOMPLETE" });
});

test("整页添加等待超时不调用刷新、重新选页或保存", async () => {
  const config = await loadConfig("config/run.json");
  const calls = [];
  const editor = {
    page: {
      getByText: () => ({ first() { return this; }, count: async () => 0, isVisible: async () => false }),
      locator: () => ({ first() { return this; }, evaluate: async () => ({ name: "target", id: "", path: "" }) }),
    },
    waitForPageLoaded: async () => calls.push("wait-old"),
    customPageExists: async () => calls.push("menu"),
    openCustomPage: async () => calls.push("reload"),
    savePage: async () => calls.push("save"),
  };
  const runner = new AiFullPageAutomation(editor, config, "test");
  runner.state = { page: { name: "target", creation_receipt: { business_status: 'succeeded', id: 'target-id' } } };
  runner.currentPageName = async () => "target";
  runner.waitForPageApplicationComplete = async () => { calls.push("barrier"); throw new Error("未添加完成"); };
  await assert.rejects(runner.finishPageCreation(), /未添加完成/);
  assert.deepEqual(calls, ["barrier"]);
});

test("无正文容器的辅助 iframe 立即跳过，不等待默认定位超时", async () => {
  const absent = { locator: () => ({ first() { return this; }, count: async () => 0,
    evaluate: async () => assert.fail("缺少容器不得调用 evaluate 等待") }) };
  assert.equal((await pageContentSnapshot([absent], { editor: true })).count, 0);
});

test("AI 结果区的嵌套画布不能当作已经添加到 3.0 的正文", async () => {
  const frame = { url: () => "about:blank", parentFrame: () => ({ url: () => "https://example.test/blockEditorUI/index.html" }),
    locator: () => assert.fail("临时 AI 结果画布必须在读取前排除") };
  assert.equal((await pageContentSnapshot([frame], { editor: true })).count, 0);
});

test("同页普通区块展示失败仍执行产品筛选和导航，保留失败且不重复已应用类型", async () => {
  const config = await loadConfig("config/run.json");
  config.ai.types = ["文章分类", "产品筛选", "导航"];
  config.ai.blocksPerPage = 3;
  const saved = [], attempted = [];
  const runner = new AiPagedAutomation({ page: {}, savePage: async () => saved.push("save") }, config);
  runner.state = createInitialAiState(config, { name: "fixture", path: "/fixture" });
  runner.initialize = async () => runner.state;
  runner.persist = async () => {};
  runner.generateAndApply = async (record) => {
    attempted.push(record.type);
    record.generation_status = "succeeded";
    record.application_acknowledged = true;
    markTypeApplied(runner.state, record);
    if (record.type === "文章分类") throw new Error("AI 类型 文章分类 应用后未在编辑器中检测到 AI 区块");
    record.editor_verified = true;
  };
  runner.verifyPreview = async () => { runner.state.page.preview_verified = true; };
  const state = await runner.run();
  assert.deepEqual(attempted, ["文章分类", "产品筛选", "导航"]);
  assert.deepEqual(saved, ["save"]);
  assert.equal(state.page.editor_verified, false);
  assert.equal(state.types[0].recovery_required, false);
  assert.equal(state.types[0].business_failure, true);
  assert.match(state.types[0].failure_reason, /未在编辑器中检测/);
  await runner.run({ resume: true });
  assert.equal(attempted.length, 3);
});

test("普通展示异常可继续，但未确认应用、登录失效不能继续", () => {
  const record = { apply_status: "applied", application_acknowledged: true };
  const failure = new Error("AI 类型 文章分类 应用后未在编辑器中检测到 AI 区块");
  assert.equal(canContinueTypeFailure(record, failure), true);
  assert.equal(canContinueTypeFailure({ ...record, application_acknowledged: false }, failure), false);
  assert.equal(canContinueTypeFailure(record, new Error("登录态失效")), false);
});

function historyFrame({ text, id = "record-1", success = false } = {}) {
  const button = { first() { return this; }, isVisible: async () => success, isEnabled: async () => success };
  const card = {
    isVisible: async () => true, innerText: async () => text,
    getAttribute: async (key) => key === "data-id" ? id : "",
    locator: () => ({ filter: () => button }),
  };
  const cards = { count: async () => 1, nth: () => card };
  const trigger = { first() { return this; }, waitFor: async () => {}, getAttribute: async () => "active" };
  return { locator: (selector) => selector === 'button' ? { filter: () => ({ first: () => ({ isVisible: async () => false }) }) } : selector.includes("trigger") ? trigger : cards, card, button };
}

test("三模式刷新必须关闭重开并匹配本轮记录，不使用无关历史成功记录", async () => {
  const config = await loadConfig("config/run.json");
  config.ai.modePointRegression.generationStatusRefreshIntervalMs = 1;
  config.ai.modePointRegression.generationTimeoutMs = 500;
  const record = createModePointsState(config, "refresh-test").records[1];
  const stale = historyFrame({ text: record.original_prompt });
  const updated = historyFrame({ text: record.original_prompt, success: true });
  const events = [];
  const runner = new AiModePointsAutomation({ page: { waitForTimeout: async () => {} } }, config, "refresh-test");
  runner.persist = async () => {};
  runner.closeGenerationDialog = async () => events.push("close");
  runner.base.openAiDialog = async () => { events.push("open"); return updated; };
  assert.equal(await runner.inspectModeHistory(historyFrame({ text: "unrelated successful record", success: true }), record), null);
  const result = await runner.waitForModeGeneration(record, stale);
  assert.deepEqual(events, ["close", "open"]);
  assert.equal(result.control, updated.button);
  assert.equal(record.generation_record_id, "record-1");
  assert.equal(record.status_refresh_count, 1);
});

test("三模式超时保存 uncertain；恢复只走记录，生成或余额读取不会再触发", async () => {
  const config = await loadConfig("config/run.json");
  config.ai.modePointRegression.generationTimeoutMs = 10;
  config.ai.modePointRegression.generationStatusRefreshIntervalMs = 1;
  const record = createModePointsState(config, "timeout-test").records[1];
  record.started_at = new Date().toISOString();
  record.points_before = 100;
  record.generation_status = "running";
  record.points_status = "checking";
  const frame = historyFrame({ text: record.original_prompt });
  const runner = new AiModePointsAutomation({ page: { waitForTimeout: async (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } }, config, "timeout-test");
  runner.persist = async () => {};
  runner.editorMarkerCount = async () => 0;
  runner.base.openAiDialog = async () => frame;
  runner.closeGenerationDialog = async () => {};
  runner.points.read = async () => assert.fail("恢复不重新读取生成前余额");
  runner.base.selectInputMode = async () => assert.fail("恢复不能重新填写并提交生成");
  await assert.rejects(runner.runMode(record, { recover: true }), { code: "GENERATION_TIMEOUT" });
  assert.equal(record.generation_status, "uncertain");
  assert.equal(record.points_before, 100);
  assert.equal(modeResumeAction(record), "recover-history");
  record.application_status = "applying";
  assert.throws(() => modeResumeAction(record), /状态不确定/);
});

test("三模式配置使用 5 分钟与 30 秒刷新，旧超时可恢复但没有提交证据时拒绝", async () => {
  const config = await loadConfig("config/run.json");
  assert.equal(config.ai.modePointRegression.generationTimeoutMs, 300000);
  assert.equal(config.ai.modePointRegression.generationStatusRefreshIntervalMs, 30000);
  const record = createModePointsState(config, "legacy").records[1];
  Object.assign(record, { generation_status: "failed", points_status: "uncertain", started_at: "2026-09-28T09:00:00Z", points_before: 100, failure_reason: "AI 区块生成结果等待超时" });
  assert.equal(modeResumeAction(record), "recover-history");
  record.points_before = null;
  assert.throws(() => modeResumeAction(record), /状态不确定/);
});
