import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";
import {
  assertNoDuplicateAppliedType,
  assertAiStateCompatible,
  createInitialAiState,
  markTypeApplied,
  markTypeFailed,
  markTypeGenerated,
  markTypePolishFailed,
  markTypePolishStarted,
  markTypePolished,
  markTypeStarted,
  pendingAiRecords,
} from "../src/ai-state.mjs";
import { publishTimeoutMessage } from "../src/ai-runner.mjs";

test("AI 状态恢复不会重复添加已完成类型", async () => {
  const config = await loadConfig("config/run.json");
  const state = createInitialAiState(config, { number: 1, name: "p", path: "/p", publicUrl: "http://example.test/p" });
  const record = state.types[0];
  markTypeStarted(record);
  markTypeGenerated(record);
  markTypeApplied(state, record);
  assert.deepEqual(state.page.types, ["静态图文"]);
  assert.equal(pendingAiRecords(state).length, 4);
  assert.throws(() => assertNoDuplicateAppliedType(state, "静态图文"), /拒绝重复插入/);
});

test("状态恢复可幂等确认同一稳定 ID 的已提交区块，但无提交证据时拒绝重复", async () => {
  const config = await loadConfig("config/run.json");
  const state = createInitialAiState(config, { number: 1, name: "p", path: "/p", publicUrl: "http://example.test/p" });
  const record = state.types[0];
  state.page.types.push(record.type);
  record.apply_status = "pending";
  assert.throws(() => markTypeApplied(state, record), /拒绝重复插入/);
  record.application_commit_confirmed = true;
  record.committed_block_id = "stable-block-id";
  assert.doesNotThrow(() => markTypeApplied(state, record));
  assert.deepEqual(state.page.types, [record.type]);
  assert.equal(record.apply_status, "applied");
});

test("AI 生成失败不会被标记为成功", async () => {
  const config = await loadConfig("config/run.json");
  const state = createInitialAiState(config, { number: 1, name: "p", path: "/p", publicUrl: "http://example.test/p" });
  const record = state.types[0];
  markTypeStarted(record);
  markTypeFailed(record, new Error("生成接口超时"));
  assert.equal(record.generation_status, "failed");
  assert.equal(record.apply_status, "failed");
  assert.equal(record.failure_reason, "生成接口超时");
  assert.equal(state.page.types.length, 0);
});

test("提示词润色成功会保存原始和润色后的提示词", async () => {
  const config = await loadConfig("config/run.json");
  const state = createInitialAiState(config, { number: 1, name: "p", path: "/p", publicUrl: "http://example.test/p" });
  const record = state.types[0];
  const original = record.original_prompt;
  markTypeStarted(record);
  markTypePolishStarted(record);
  markTypePolished(record, `${original} Add a responsive layout and accessible contrast.`);
  assert.equal(record.original_prompt, original);
  assert.match(record.polished_prompt, /accessible contrast/);
  assert.equal(record.prompt, record.polished_prompt);
  assert.equal(record.polish_status, "succeeded");
  assert.ok(record.polished_at);
});

test("提示词润色失败不会被标记为成功", async () => {
  const config = await loadConfig("config/run.json");
  const state = createInitialAiState(config, { number: 1, name: "p", path: "/p", publicUrl: "http://example.test/p" });
  const record = state.types[0];
  markTypeStarted(record);
  markTypePolishStarted(record);
  markTypePolishFailed(record, new Error("润色接口超时"));
  assert.equal(record.polish_status, "failed");
  assert.equal(record.polish_failure_reason, "润色接口超时");
  assert.equal(record.generation_status, "running");
  assert.equal(record.apply_status, "pending");
});

test("旧状态缺少润色字段时按 pending 兼容恢复", async () => {
  const config = await loadConfig("config/run.json");
  const state = createInitialAiState(config, { number: 1, name: "p", path: "/p", publicUrl: "http://example.test/p" });
  delete state.types[0].original_prompt;
  delete state.types[0].polished_prompt;
  delete state.types[0].polish_status;
  delete state.types[0].polished_at;
  delete state.types[0].polish_failure_reason;
  assertAiStateCompatible(state, config);
  assert.equal(state.types[0].original_prompt, config.ai.prompts["静态图文"]);
  assert.equal(state.types[0].polish_status, "pending");
});

test("生成完成但应用中断会标记为需要人工恢复", async () => {
  const config = await loadConfig("config/run.json");
  const state = createInitialAiState(config, { number: 1, name: "p", path: "/p", publicUrl: "http://example.test/p" });
  const record = state.types[0];
  markTypeStarted(record);
  markTypeGenerated(record);
  markTypeFailed(record, new Error("应用保存响应丢失"));
  assert.equal(record.recovery_required, true);
  assert.equal(state.page.types.length, 0);
});

test("发布轮询超时包含明确的页面和数量", () => {
  assert.equal(
    publishTimeoutMessage("http://example.test/p", 2, 5),
    "发布轮询超时：http://example.test/p 中检测到 2/5 个 AI 区块",
  );
});
