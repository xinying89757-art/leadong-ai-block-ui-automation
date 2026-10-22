import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig, validateHistoryReuseRegression } from "../src/config.mjs";
import { renderedBlockEvidence } from "../src/ai-history-reuse-runner.mjs";
import {
  assertBlockCountDelta,
  assertHistoryApplicationSource,
  createHistoryReuseState,
  historyReuseDescriptors,
  historyReuseResumeAction,
  markHistoryApplied,
  markHistoryMatched,
} from "../src/ai-history-reuse-state.mjs";

test("生成记录复用专项固定为整页与静态图文的文字快速模式", async () => {
  const config = await loadConfig("config/run.json");
  const mode = config.ai.historyReuseRegression;
  assert.equal(mode.inputMode, "文字描述");
  assert.equal(mode.generationMode, "快速模式");
  assert.equal(mode.promptPolishEnabled, false);
  assert.equal(mode.blockType, "静态图文");
  assert.equal(mode.generationStatusRefreshIntervalMs, 30000);
  assert.equal(mode.generationTimeoutMs, 1200000);
});

test("两张生成记录复用页面按运行 ID 唯一隔离", async () => {
  const config = await loadConfig("config/run.json");
  const first = historyReuseDescriptors(config, "history-reuse-one");
  const second = historyReuseDescriptors(config, "history-reuse-two");
  assert.notEqual(first.fullPage.name, second.fullPage.name);
  assert.notEqual(first.block.path, second.block.path);
  assert.match(first.fullPage.marker, /history-reuse-one/);
  assert.match(first.block.marker, /history-reuse-one/);
  const state = createHistoryReuseState(config, "history-reuse-one");
  assert.match(state.full_page.generation.original_prompt, /AI History Full Page/);
  assert.match(state.block.generation.prompt, /AI History Static Block/);
});

test("恢复优先使用已生成记录且不会再次生成", async () => {
  const config = await loadConfig("config/run.json");
  const state = createHistoryReuseState(config, "history-reuse-resume");
  assert.equal(historyReuseResumeAction(state.full_page, false), "generate");
  state.full_page.generation.generation_status = "succeeded";
  assert.equal(historyReuseResumeAction(state.full_page, false), "recover-history");
  assert.equal(historyReuseResumeAction(state.block, true, { pageCreatedBeforeGeneration: true }), "generate");
  state.block.generation.generation_status = "running";
  assert.equal(historyReuseResumeAction(state.block, true, { pageCreatedBeforeGeneration: true }), "recover-history");
});

test("只有重新打开并匹配的记录才能标记为历史应用", async () => {
  const config = await loadConfig("config/run.json");
  const state = createHistoryReuseState(config, "history-reuse-source");
  assert.throws(() => markHistoryApplied(state.block), /尚未重新打开/);
  markHistoryMatched(state.block, "record-1");
  markHistoryApplied(state.block);
  assert.equal(state.block.history.application_source, "history");
  assert.equal(state.block.generation.application_status, "applied");
  assert.equal(assertHistoryApplicationSource(state.block), true);
  state.block.history.application_source = "direct";
  assert.throws(() => assertHistoryApplicationSource(state.block), /不是来自重新打开/);
});

test("区块记录应用必须且只能新增一个 AI 区块", () => {
  assert.equal(assertBlockCountDelta(0, 1), true);
  assert.equal(assertBlockCountDelta(2, 3), true);
  assert.throws(() => assertBlockCountDelta(0, 0), /预期增加 1/);
  assert.throws(() => assertBlockCountDelta(0, 2), /预期增加 1/);
});

test("区块展示可通过编辑器文本或图片证据验证", () => {
  const editorEvidence = {
    text_signature: "AI History Static Block unique marker",
    image_sources: ["https://cdn.example.com/images/solar-panel.png"],
  };
  assert.equal(renderedBlockEvidence({ text: "Header AI History Static Block unique marker CTA", images: [] }, editorEvidence).passed, true);
  assert.equal(renderedBlockEvidence({ text: "", images: ["https://site.test/assets/solar-panel.png"] }, editorEvidence).passed, true);
  assert.equal(renderedBlockEvidence({ text: "unrelated", images: [] }, editorEvidence).passed, false);
});

test("生成记录复用配置拒绝启用润色或更换区块类型", async () => {
  const config = await loadConfig("config/run.json");
  assert.throws(
    () => validateHistoryReuseRegression({ ...config.ai.historyReuseRegression, promptPolishEnabled: true }),
    /必须关闭提示词润色/,
  );
  assert.throws(
    () => validateHistoryReuseRegression({ ...config.ai.historyReuseRegression, blockType: "导航" }),
    /必须为静态图文/,
  );
});
