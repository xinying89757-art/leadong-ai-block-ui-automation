import assert from "node:assert/strict";
import test from "node:test";
import { aiPageDescriptor, loadConfig, validateCompositeRegression } from "../src/config.mjs";
import { createInitialAiState } from "../src/ai-state.mjs";
import { canRetryCompositeGeneration, compositeSelectionValid, prepareCompositeGenerationRetry } from "../src/ai-composite-runner.mjs";
import {
  assertCompositeState,
  compositePassed,
  compositePaths,
  compositeResumeAction,
  compositeScopedConfig,
  newCompositeRunId,
} from "../src/ai-composite-state.mjs";

test("复合区块专项默认使用静态图文、产品列表和产品分类", async () => {
  const config = await loadConfig("config/run.json");
  const mode = config.ai.compositeRegression;
  assert.equal(mode.type, "复合区块");
  assert.equal(mode.staticType, "静态图文");
  assert.deepEqual(mode.dynamicTypes, ["产品列表", "产品分类"]);
  assert.equal(mode.dynamicTypes.length, 2);
  assert.equal(mode.maxGenerationAttempts, 10);
  assert.equal(mode.generationTimeoutMs, 600000);
  assert.equal(mode.generationMode, "深度模式");
  assert.doesNotThrow(() => validateCompositeRegression(mode));
  assert.throws(() => validateCompositeRegression({ ...mode, dynamicTypes: ["产品列表", "产品列表"] }), /互不重复/);
  assert.throws(() => validateCompositeRegression({ ...mode, dynamicTypes: ["产品列表", "产品分类", "文章列表", "视频列表"] }), /1–3/);
});

test("复合区块只有平台明确失败才新建生成尝试，超时不重复扣点", () => {
  const record = {
    generation_status: "uncertain",
    generation_submit_confirmed: true,
    generation_attempt_number: 1,
    generation_prompt: "old attempt prompt",
    generation_record_id: "failed-record-1",
  };
  const timeout = Object.assign(new Error("等待超时"), { code: "GENERATION_UNCONFIRMED" });
  const explicitFailure = Object.assign(new Error("组合操作失败"), {
    code: "GENERATION_FAILED",
    explicitPlatformFailure: true,
    record_id: "failed-record-1",
  });
  assert.equal(canRetryCompositeGeneration(timeout, 1, 5), false);
  assert.equal(canRetryCompositeGeneration(explicitFailure, 1, 5), true);
  assert.equal(canRetryCompositeGeneration(explicitFailure, 5, 5), false);
  assert.equal(prepareCompositeGenerationRetry(record, explicitFailure, new Date("2026-10-20T03:00:00.000Z")), 2);
  assert.deepEqual(record.generation_attempts, [{
    attempt: 1,
    status: "failed",
    failure_reason: "组合操作失败",
    explicit_platform_failure: true,
    finished_at: "2026-10-20T03:00:00.000Z",
    generation_record_id: "failed-record-1",
  }]);
  assert.equal(record.generation_status, "pending");
  assert.equal(record.generation_submit_confirmed, false);
  assert.equal(record.generation_record_id, "");
  assert.equal(record.application_attempted, false);
});

test("复合区块选择状态要求静态默认、组合开关和恰好指定的动态项", () => {
  const valid = { static_layout: "静态图文", static_layout_selected_before_combo: true, combination_enabled: true,
    max_dynamic_types: 3, selected_dynamic_types: ["产品列表", "产品分类"] };
  assert.equal(compositeSelectionValid(valid, ["产品列表", "产品分类"]), true);
  assert.equal(compositeSelectionValid({ ...valid, selected_dynamic_types: ["产品列表"] }, ["产品列表", "产品分类"]), false);
  assert.equal(compositeSelectionValid({ ...valid, selected_dynamic_types: ["产品列表", "产品分类", "视频列表"] }, ["产品列表", "产品分类"]), false);
  assert.equal(compositeSelectionValid({ ...valid, max_dynamic_types: 0 }, ["产品列表", "产品分类"]), false);
});

test("复合区块页面与状态按 runId 隔离，恢复不会重复已提交的生成", async () => {
  const config = await loadConfig("config/run.json");
  const runId = "composite-unit-001";
  const paths = compositePaths(config, runId);
  const scoped = compositeScopedConfig(config, runId, paths.state);
  const state = createInitialAiState(scoped, aiPageDescriptor(scoped, 1));
  assert.match(paths.state, new RegExp(`/runs/${runId}/ai-composite/state\\.json$`));
  assert.match(state.page.name, new RegExp(runId));
  assert.equal(state.types.length, 1);
  assert.equal(state.types[0].type, "复合区块");
  assert.doesNotThrow(() => assertCompositeState(state, config, runId));
  assert.equal(compositeResumeAction(state, config), "generate");
  state.types[0].generation_status = "succeeded";
  assert.throws(() => compositeResumeAction(state, config), /不能自动重复生成/);
  state.types[0].generation_status = "uncertain";
  state.types[0].generation_submit_confirmed = true;
  assert.equal(compositeResumeAction(state, config), "resume-existing-record");
  state.types[0].application_attempted = true;
  assert.throws(() => compositeResumeAction(state, config), /应用状态不确定/);
  state.types[0].application_attempted = false;
  state.types[0].generation_status = "pending";
  assert.throws(() => compositeResumeAction(state, config), /重复生成/);
  state.types[0].generation_status = "failed";
  state.types[0].generation_attempt_number = 1;
  state.types[0].generation_attempts = [{ attempt: 1, status: "failed", explicit_platform_failure: true }];
  assert.equal(compositeResumeAction(state, config), "retry-explicit-failure");
  state.types[0].generation_attempt_number = config.ai.compositeRegression.maxGenerationAttempts;
  assert.throws(() => compositeResumeAction(state, config), /重复生成/);
  assert.throws(() => assertCompositeState(state, config, "other-run"), /运行 ID/);
  assert.equal(newCompositeRunId(new Date("2026-10-20T01:02:03.000Z")), "composite-20261020010203");
});

test("复合区块闭环必须逐项确认菜单、应用、编辑器、预览和公开发布", async () => {
  const config = await loadConfig("config/run.json");
  const runId = "composite-pass-001";
  const scoped = compositeScopedConfig(config, runId, "/tmp/composite-state.json");
  const state = createInitialAiState(scoped, aiPageDescriptor(scoped, 1));
  const record = state.types[0];
  record.generation_status = "succeeded";
  record.apply_status = "applied";
  record.generation_attempt_number = 1;
  record.generation_attempts = [{ attempt: 1, status: "succeeded", generation_mode: config.ai.compositeRegression.generationMode }];
  record.committed_block_id = "siteblocks-setting-wrap-composite";
  record.type_menu_evidence = { match_count: 1, status: "matched" };
  record.composite_selection = { static_layout: "静态图文", static_layout_selected_before_combo: true,
    combination_enabled: true, max_dynamic_types: 3, requested_dynamic_types: ["产品列表", "产品分类"],
    selected_dynamic_types: ["产品列表", "产品分类"] };
  record.composite_editor_evidence = { passed: true };
  state.page.types = ["复合区块"];
  state.page.saved = true;
  state.page.editor_verified = true;
  state.page.preview_verified = true;
  state.page.published_verified = true;
  assert.equal(compositePassed(state, config), true);
  record.composite_selection.selected_dynamic_types = ["产品列表"];
  assert.equal(compositePassed(state, config), false);
});
