import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { businessFailure, readableCheck } from "../src/ai-regression-report-view.mjs";
import { buildRegressionHtml, normalizeRegressionReport, writeRegressionReport } from "../src/ai-regression-report.mjs";
import { executeFullPageAttempts } from "../src/ai-full-page-result.mjs";
import { createFullPageState, fullPagePaths, writeFullPageJson } from "../src/ai-full-page-state.mjs";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGN8AAAAASUVORK5CYII=", "base64");
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-readable-report-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { paths: { aiLifecycleDir: path.join(root, "lifecycle"), aiRegressionReportsDir: path.join(root, "reports") }, siteName: "test-site", siteLanguage: "英语", publicBaseUrl: "https://example.test/", ai: { fullPageRegression: { pageNamePrefix: "测试-", pagePathPrefix: "test-", maxGenerationRetries: 1, autoRetryFailed: true } } };
  const suiteRoot = path.join(config.paths.aiLifecycleDir, "runs", "suite-1", "suite");
  const suite = { run_id: "suite-1", status: "failed", site_name: "test-site", site_language: "英语", stages: [] };
  return { root, config, suiteRoot, suite };
}
async function json(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value));
}
function completePage(extra = {}) { return { name: "测试页面", publicUrl: "https://example.test/page", saved: true, editor_verified: true, preview_verified: true, published_verified: true, ...extra }; }
function completeGeneration(extra = {}) { return { generation_status: "succeeded", application_status: "applied", ...extra }; }

test("中文链路只标记实际失败，下游默认 false 是未执行", () => {
  const check = readableCheck({ label: "文章分类", details: { generation: "succeeded", applied: "applied", editor: false, saved: false, preview: false, published: false, failure: "AI 类型 文章分类 应用后未在编辑器中检测到 AI 区块" } });
  assert.equal(check.status, "failed");
  assert.deepEqual(check.steps.map((s) => s.status), ["passed", "passed", "failed", "pending", "pending", "pending", "pending"]);
  assert.equal(businessFailure(check.details.failure), "应用后未在编辑器中检测到文章分类区块。");
  const pending = readableCheck({ label: "未开始", details: { generation: "pending", applied: "pending", editor: false, preview: false, published: false } });
  assert.equal(pending.status, "pending");
  assert.ok(pending.steps.every((s) => s.status === "pending"));
});

test('后续页面重试报告读取该子运行的两张页面，不回退到旧页', async t => {
  const { config, suiteRoot, suite } = await fixture(t);
  suite.stages = [{ key: 'blocks-pages-002-003', status: 'passed', label: '后续页面', result: { childRunId: 'retry-pages' } }];
  for (const number of [2, 3]) {
    const state = { page: completePage({ name: `retry-page-${number}` }), types: [{ type: '静态图文', generation_status: 'succeeded', apply_status: 'applied', editor_verified: true, preview_verified: true, published_verified: true }] };
    await json(path.join(config.paths.aiLifecycleDir, 'runs/retry-pages/ai-remaining', `page-00${number}.json`), state);
    await json(path.join(suiteRoot, '../ai-remaining', `page-00${number}.json`), { page: completePage({ saved: false }), types: [{ type: '旧失败', generation_status: 'failed' }] });
  }
  const report = await normalizeRegressionReport(config, suite, suiteRoot);
  assert.equal(report.stages[0].checks.length, 4);
  assert.ok(report.stages[0].checks.every(check => check.status === 'passed'));
  assert.ok(report.stages[0].checks.some(check => check.details.page === 'retry-page-3'));
});

test("失败生成后的不确定扣点不重复标为失败或阻断", () => {
  const check = readableCheck({ label: "进阶", details: { generation: "failed", pointsStatus: "uncertain", application: "pending", failure: "AI 区块生成结果等待超时" } });
  assert.deepEqual(check.steps.slice(0, 3).map((s) => s.status), ["failed", "pending", "pending"]);
  assert.equal(businessFailure(check.details.failure), "生成结果等待超时。");
});

test("缺失的必经步骤或扣点数据不可误判通过", () => {
  const missingSave = readableCheck({ label: "整页", details: { generation: "succeeded", application: "applied", editor: true, preview: true, published: true } });
  assert.equal(missingSave.status, "blocked");
  assert.equal(missingSave.details.dataUnavailable, true);
  assert.equal(missingSave.steps.find((s) => s.label === "保存").status, "blocked");
  const missingPoints = readableCheck({ label: "点数", details: { generation: "succeeded", pointsStatus: "passed", expectedCost: 6, actualCost: null } });
  assert.equal(missingPoints.steps.find((s) => s.label === "扣点验证").status, "blocked");
});

test("报告不输出来源路径、原始参数、提示词、布尔值和日志", () => {
  const item = readableCheck({ label: "静态图文 <安全>", details: { generation: "succeeded", application: "applied", editor: true, saved: true, preview: true, published: true, expectedCost: 6, actualCost: 6, publicUrl: "https://example.test/page?Authorization=secret-token&x=1", original_prompt: "DO-NOT-DISPLAY-PROMPT", secret: "DO-NOT-DISPLAY", failure: "", screenshot: "" } });
  const html = buildRegressionHtml({ runId: "suite-1", status: "passed", siteName: "site", siteLanguage: "英语", duration: "1秒", passed: 1, stages: [{ label: "测试阶段", status: "passed", source_file: "/private/state.json", checks: [item] }] });
  assert.match(html, /生成通过/);
  assert.match(html, /预期扣除 6 点，实际扣除 6 点/);
  assert.match(html, /查看测试页面/);
  assert.match(html, /静态图文 &lt;安全&gt;/);
  assert.doesNotMatch(html, /状态来源|private\/state|original_prompt|DO-NOT-DISPLAY|secret-token|>true<|>false<|publicUrl|generation_status/);
  assert.equal((html.match(/class="check"/g) || []).length, 1);
  assert.match(html, /业务测试点：1 个/);
  assert.equal(businessFailure("打开“自定义页面”列表失败：locator.click: Timeout 15000ms exceeded. Call log"), "打开自定义页面列表超时。");
});

test('重试后通过与首次业务问题显示为中文，不泄露首次原始日志', () => {
  const html = buildRegressionHtml({ runId: 'retry', status: 'passed', stages: [{ label: '页面', status: 'passed',
    end_retry_count: 1, attempts: 2, initial_failure_reason: 'AI 类型 图册列表 应用后未在编辑器中检测到 AI 区块 /private/hidden.js stack', checks: [] }] });
  assert.match(html, /重试后通过/);
  assert.match(html, /最终重试：1 次/);
  assert.match(html, /首次问题：应用后未在编辑器中检测到图册列表区块/);
  assert.doesNotMatch(html, /private|hidden\.js|stack/);
});

test("旧整页报告按明确 retry ID 及关联读取最终结果，不使用最新指针", async (t) => {
  const { config, suiteRoot, suite } = await fixture(t);
  suite.stages = [{ key: "full-page", label: "整页", status: "failed", duration_ms: 42000, failure_reason: "自动重试 1/1，新运行 retry-1\nAI 整页回归失败：整页公开页内容等待超时" }];
  await json(path.join(suiteRoot, "../ai-full-page/state.json"), { page: completePage({ saved: false }), generation: completeGeneration({ generation_status: "failed" }) });
  const final = { run_id: "retry-1", site_name: "test-site", page: completePage({ published_verified: false, failure_reason: "整页公开页内容等待超时", failure_screenshot: "final.png" }), generation: completeGeneration(), retry: { attempt: 1, previous_run_id: "suite-1" } };
  await json(fullPagePaths(config, "retry-1").state, final);
  await json(fullPagePaths(config, "other-run").active, { runId: "unrelated" });
  const before = JSON.stringify(suite);
  const report = await normalizeRegressionReport(config, suite, suiteRoot);
  const result = report.stages[0].checks[0];
  assert.equal(report.durationMs, 42000);
  assert.equal(result.details.screenshot, "final.png");
  assert.equal(result.steps.find((s) => s.label === "生成").status, "passed");
  assert.equal(result.steps.find((s) => s.label === "保存").status, "passed");
  assert.equal(result.steps.find((s) => s.label === "预览").status, "passed");
  assert.equal(result.steps.find((s) => s.label === "公开页验证").status, "failed");
  assert.equal(JSON.stringify(suite), before);
  final.retry.previous_run_id = "another-suite";
  await json(fullPagePaths(config, "retry-1").state, final);
  assert.equal((await normalizeRegressionReport(config, suite, suiteRoot)).stages[0].checks[0].details.reason, "结果未确认");
});

test("有歧义的重试分支拒绝猜测结果", async (t) => {
  const { config, suiteRoot, suite } = await fixture(t);
  suite.stages = [{ key: "full-page", status: "failed", failure_reason: "新运行 retry-1\n新运行 retry-2" }];
  await json(fullPagePaths(config, "retry-2").state, { run_id: "retry-2", page: completePage(), generation: completeGeneration(), retry: { previous_run_id: "suite-1" } });
  assert.equal((await normalizeRegressionReport(config, suite, suiteRoot)).stages[0].checks[0].status, "blocked");
});

test("大截图内嵌，生成记录复用截图映射，缺失或损坏图片不产生失效链接", async (t) => {
  const { root, config, suiteRoot, suite } = await fixture(t);
  const large = path.join(root, "large.png");
  await writeFile(large, Buffer.concat([png, Buffer.alloc(6 * 1024 * 1024)]));
  const bad = path.join(root, "corrupt.png");
  await writeFile(bad, "this is not an image");
  const child = path.join(suiteRoot, "../ai-history-reuse/state.json");
  const history = { reopened: true, match_status: "succeeded", application_source: "history" };
  const state = { full_page: { page: completePage({ failure_screenshot: large }), generation: completeGeneration(), history }, block: { page: completePage({ failure_screenshot: bad }), generation: completeGeneration(), history, block_count_before: 0, block_count_after: 1 } };
  await json(child, state);
  suite.stages = [{ key: "history-reuse", label: "复用", status: "passed" }];
  let result = await writeRegressionReport(config, suite, { root: suiteRoot });
  let html = await readFile(result.file, "utf8");
  assert.equal(result.report.stages[0].checks[0].status, "passed");
  assert.equal(result.report.stages[0].checks[1].status, "passed");
  assert.match(html, /<img src="data:image\/png;base64,/);
  assert.match(html, /截图不可用/);
  assert.doesNotMatch(html, /href="data:|large\.png|corrupt\.png|超过 5MB/);
  assert.ok(html.length > 6 * 1024 * 1024);
  assert.equal(await readFile(result.latest, "utf8"), html);
  state.full_page.page.failure_screenshot = path.join(root, "missing.png");
  await json(child, state);
  result = await writeRegressionReport(config, suite, { root: suiteRoot });
  html = await readFile(result.file, "utf8");
  assert.doesNotMatch(html, /<img src=|missing\.png/);
  assert.equal((html.match(/class="unavailable"/g) || []).length, 2);
});

test("损坏或缺失的状态仍生成报告但不误判通过", async (t) => {
  const { config, suiteRoot, suite } = await fixture(t);
  const child = path.join(suiteRoot, "../ai-full-page/state.json");
  await mkdir(path.dirname(child), { recursive: true });
  await writeFile(child, "{ invalid json");
  suite.stages = [{ key: "full-page", label: "整页", status: "passed" }];
  const result = await writeRegressionReport(config, suite, { root: suiteRoot });
  assert.equal(result.report.blocked, 1);
  assert.match(await readFile(result.file, "utf8"), /数据不可用/);
});

test("整页执行最终失败依然返回最后重试 stateFile，禁重试也返回本轮文件", async (t) => {
  const { config } = await fixture(t);
  let calls = 0;
  const warnings = [];
  const result = await executeFullPageAttempts({ config, command: "run", options: {}, runId: "suite-1", nextRunId: () => "retry", warn: (message) => warnings.push(message), execute: async (runId, paths) => {
    calls++;
    const state = createFullPageState(config, runId);
    if (calls === 1) state.generation.generation_status = "failed";
    else { state.generation = completeGeneration(); state.page = completePage({ published_verified: false }); }
    await writeFullPageJson(paths.state, state);
    throw new Error(calls === 1 ? "生成失败" : "公开页内容等待超时");
  } });
  assert.equal(result.ok, false);
  assert.equal(result.runId, "retry-retry1");
  assert.equal(result.stateFile, fullPagePaths(config, "retry-retry1").state);
  assert.equal(result.generation.generation_status, "succeeded");
  assert.equal(result.page.saved, true);
  assert.equal(warnings.length, 1);
  assert.equal(calls, 2);
  const noRetry = await executeFullPageAttempts({ config, command: "run", options: { "no-auto-retry": true }, runId: "suite-1", execute: async () => { throw new Error("失败"); } });
  assert.equal(noRetry.stateFile, fullPagePaths(config, "suite-1").state);
});

test("五种状态颜色及统计独立，步骤不参与计数", async (t) => {
  const { config, suiteRoot, suite } = await fixture(t);
  const child = path.join(suiteRoot, "../ai-mode-points/state.json");
  const record = (mode, value) => ({ mode, mode_label: mode, generation_status: value, application_status: "pending" });
  await json(child, { page: completePage(), records: [record("未执行", "pending"), record("运行中", "running"), record("失败", "failed"), record("阻断", "uncertain")] });
  suite.status = "running";
  suite.stages = [{ key: "mode-points", label: "点数", status: "running" }];
  const report = await normalizeRegressionReport(config, suite, suiteRoot);
  assert.deepEqual(report.counts, { pending: 1, running: 1, failed: 1, blocked: 1, passed: 1 });
  const html = buildRegressionHtml(report);
  for (const status of ["passed", "failed", "blocked", "running", "pending"]) assert.match(html, new RegExp(`status-${status}`));
  assert.match(html, /业务测试点：5 个/);
});
