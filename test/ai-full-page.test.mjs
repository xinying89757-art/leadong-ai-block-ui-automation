import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig, validateFullPageRegression } from "../src/config.mjs";
import {
  assertFullPageState,
  createFullPageState,
  fullPageDescriptor,
  fullPageResumeAction,
  shouldAutoRetryFailed,
} from "../src/ai-full-page-state.mjs";
import { englishContentEvidence, evidenceFromText, hardContentEvidence, promptMatchesPayload, waitFor } from "../src/ai-full-page-runner.mjs";

test("整页回归固定为文字描述和快速模式，页面按运行 ID 隔离", async () => {
  const config = await loadConfig("config/run.json");
  const mode = config.ai.fullPageRegression;
  assert.equal(mode.inputMode, "文字描述");
  assert.equal(mode.generationMode, "快速模式");
  assert.equal(mode.promptPolishEnabled, false);
  assert.ok(mode.generationTimeoutMs >= 20 * 60 * 1000);
  assert.equal(mode.generationStatusRefreshIntervalMs, 30_000);
  assert.equal(mode.maxGenerationRefreshes, 40);
  assert.equal(mode.autoRetryFailed, true);
  assert.equal(mode.maxGenerationRetries, 1);
  const state = createFullPageState(config, "full-page-test-1");
  assert.ok(state.page.name.endsWith("full-page-test-1"));
  assert.ok(state.page.path.endsWith("full-page-test-1"));
  assert.ok(state.generation.original_prompt.includes(state.page.heading));
  assert.equal(state.generation.status_refresh_interval_ms, 30_000);
  assert.equal(state.generation.max_status_refreshes, 40);
  assert.doesNotThrow(() => assertFullPageState(state, config, "full-page-test-1"));
  assert.notEqual(fullPageDescriptor(config, "full-page-test-1").path, fullPageDescriptor(config, "full-page-test-2").path);
});

test("明确生成失败会记录后自动只重试一次，未确认不会盲重试", async () => {
  const config = await loadConfig("config/run.json");
  const state = createFullPageState(config, "full-page-test-retry");
  state.generation.generation_status = "failed";
  state.generation.failure_reason = "整页生成失败：服务端返回失败";
  assert.equal(shouldAutoRetryFailed(state, config, 0), true);
  assert.equal(shouldAutoRetryFailed(state, config, 1), false);
  state.generation.generation_status = "uncertain";
  assert.equal(shouldAutoRetryFailed(state, config, 0), false);
});

test("整页公开页轮询超时给出明确提示", async () => {
  await assert.rejects(waitFor(() => false, 1, "整页公开页内容", 1), /整页公开页内容等待超时/);
});

test("整页恢复不会对已发起或失败的生成再次扣点", async () => {
  const config = await loadConfig("config/run.json");
  const state = createFullPageState(config, "full-page-test-2");
  assert.equal(fullPageResumeAction(state, false), "generate");
  state.generation.generation_status = "running";
  assert.equal(fullPageResumeAction(state, false), "recover-history");
  state.generation.generation_status = "failed";
  assert.equal(fullPageResumeAction(state, false), "recover-history");
  state.generation.generation_status = "uncertain";
  assert.equal(fullPageResumeAction(state, false), "recover-history");
  state.generation.generation_status = "succeeded";
  state.generation.application_status = "applying";
  assert.equal(fullPageResumeAction(state, true), "verify-page");
  state.generation.application_status = "applied";
  assert.throws(() => fullPageResumeAction(state, false), /拒绝重新生成/);
});

test("同名页或配置变更阻断恢复", async () => {
  const config = await loadConfig("config/run.json");
  const state = createFullPageState(config, "full-page-test-3");
  assert.throws(() => fullPageResumeAction(state, true), /拒绝覆盖或重复生成/);
  state.page.path = "/unexpected";
  assert.throws(() => assertFullPageState(state, config, "full-page-test-3"), /不匹配/);
  assert.throws(() => validateFullPageRegression({ ...config.ai.fullPageRegression, promptPolishEnabled: true }), /关闭提示词润色/);
});

test("整页可选内容证据仍可独立评估标题和版块", () => {
  const heading = "AI Full Page Regression full-page-test-4";
  const sections = ["Products", "Why Choose Us", "Customer Stories", "Contact Us"];
  assert.equal(evidenceFromText(`${heading}\nProducts\nWhy Choose Us\nCustomer Stories`, heading, sections).passed, true);
  assert.equal(evidenceFromText(`${heading}\nProducts\nContact Us`, heading, sections).passed, false);
  assert.equal(evidenceFromText("Products\nWhy Choose Us\nCustomer Stories", heading, sections).passed, false);
  assert.equal(evidenceFromText(heading, heading, sections).structurePassed, true);
  assert.equal(evidenceFromText("Products\nWhy Choose Us\nCustomer Stories", heading, sections).structurePassed, true);
  assert.equal(evidenceFromText(`${heading}\n${"Solar energy products and customer benefits. ".repeat(8)}`, heading, sections, false).passed, true);
  assert.equal(evidenceFromText(heading, heading, sections, false).passed, false);
});

test("整页硬断言只要求页面有实际渲染内容", () => {
  assert.equal(hardContentEvidence("任意模型生成的标题和正文内容以及一个联系按钮区域").passed, true);
  assert.equal(hardContentEvidence("Products\nWhy Choose Us").passed, true);
  assert.equal(hardContentEvidence("  \n  ").passed, false);
  assert.equal(hardContentEvidence("添加在这里").passed, false);
});

test("带英文引号的整页提示词按 JSON 字段核对", () => {
  const prompt = 'Build a page with heading "Regression"';
  assert.equal(promptMatchesPayload(JSON.stringify({ prompt }), prompt), true);
  assert.equal(promptMatchesPayload(JSON.stringify({ prompt: "different" }), prompt), false);
});

test("英语整页公开内容混入中文会被记录为不通过", () => {
  assert.equal(englishContentEvidence("Products and Contact Us").passed, true);
  const mixed = englishContentEvidence("Contact Us 联系我们");
  assert.equal(mixed.passed, false);
  assert.ok(mixed.chineseCharacterCount > 0);
});
