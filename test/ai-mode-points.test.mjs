import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig, validateModePointConfig } from "../src/config.mjs";
import { AiDialogPointsReader, parseAvailablePoints } from "../src/ai-points.mjs";
import { AiModePointsAutomation } from "../src/ai-mode-points-runner.mjs";
import {
  createModePointsState,
  finishPointsCheck,
  modePointsPage,
  modePointsPaths,
  resumeSafety,
  modeResumeAction,
  writeModeJson,
} from "../src/ai-mode-points-state.mjs";

test("三模式点数配置固定为 6、10、20 且页面按运行 ID 隔离", async () => {
  const config = await loadConfig("config/run.json");
  assert.deepEqual(config.ai.modePointRegression.modes.map(({ key, expectedCost }) => [key, expectedCost]), [
    ["quick", 6], ["advanced", 10], ["deep", 20],
  ]);
  assert.equal(config.ai.modePointRegression.promptPolishEnabled, false);
  const state = createModePointsState(config, "mode-points-test-1");
  assert.deepEqual(state.records.map((record) => record.type), ["静态图文", "静态图文", "静态图文"]);
  assert.equal(new Set(state.records.map((record) => record.mode)).size, 3);
  assert.ok(state.records.every((record) => record.original_prompt.includes(record.heading)));
  assert.ok(modePointsPage(config, "mode-points-test-1").name.endsWith("mode-points-test-1"));
  assert.throws(() => validateModePointConfig({ ...config.ai.modePointRegression, modes: [
    config.ai.modePointRegression.modes[0], config.ai.modePointRegression.modes[0], config.ai.modePointRegression.modes[2],
  ] }), /模式配置无效/);
});

test("生成失败仅在核对全额退款后跳过失败模式，未确认时只读恢复生成记录", async () => {
  const config = await loadConfig();
  const record = createModePointsState(config, "refund-check").records[1];
  Object.assign(record, { generation_status: "failed", points_status: "uncertain", points_before: 100,
    started_at: new Date().toISOString(), failure_reason: "进阶模式 AI 类型生成失败" });
  assert.equal(modeResumeAction(record), "recover-history");
  const runner = new AiModePointsAutomation({ page: { waitForTimeout: async () => {} } }, config, "refund-check");
  runner.persist = async () => {};
  const values = [90, 100];
  runner.points.read = async () => values.shift();
  await runner.confirmRefund({}, record);
  assert.equal(record.actual_cost, 0);
  assert.equal(record.points_status, "failed");
  assert.equal(record.refund_confirmed, true);
  assert.equal(modeResumeAction(record), "skip-failed");
  record.points_after = 90;
  assert.throws(() => modeResumeAction(record), /状态不确定/);
});

test("退款确认的进阶失败不会跳过深度模式，并验证已应用模式的预览和公开页", async () => {
  const config = await loadConfig();
  const events = [];
  const runner = new AiModePointsAutomation({ savePage: async () => events.push("save") }, config, "refund-continue");
  runner.state = createModePointsState(config, "refund-continue");
  runner.initialize = async () => {};
  runner.persist = async () => {};
  runner.base.closeAiResult = async () => events.push("close");
  runner.runMode = async record => {
    events.push(record.mode);
    if (record.mode === "advanced") {
      Object.assign(record, { generation_status: "failed", application_status: "failed", refund_confirmed: true,
        points_before: 100, points_after: 100, actual_cost: 0 });
      throw new Error("生成失败");
    }
    Object.assign(record, { generation_status: "succeeded", application_status: "applied", editor_verified: true });
  };
  runner.verifyPreview = async records => events.push(["preview", ...records.map(x => x.mode)]);
  runner.editor.publishSite = async () => events.push("publish");
  runner.verifyPublished = async records => events.push(["public", ...records.map(x => x.mode)]);
  await assert.rejects(runner.run(), /进阶模式生成失败/);
  assert.deepEqual(events, ["quick", "advanced", "close", "deep", "save", ["preview", "quick", "deep"], "publish", ["public", "quick", "deep"]]);
});

test("读取 MoliAI 点数并按余额差值标记通过或失败", async () => {
  assert.equal(parseAvailablePoints("2,742.00 / 3,000.00点"), 2742);
  assert.equal(parseAvailablePoints("可用 2,742 点/总计 3,000 点"), 2742);
  const state = createModePointsState(await loadConfig("config/run.json"), "mode-points-test-2");
  const quick = state.records[0];
  quick.points_before = 2742;
  assert.equal(finishPointsCheck(quick, 2736), "passed");
  const advanced = state.records[1];
  advanced.points_before = 2736;
  assert.equal(finishPointsCheck(advanced, 2725), "failed");
  assert.equal(advanced.actual_cost, 11);
  assert.match(advanced.points_failure_reason, /预期扣除 10 点，实际扣除 11 点/);
});

test("余额异步刷新会等待预期扣点", async () => {
  const reader = new AiDialogPointsReader(null);
  const values = [2742, 2742, 2736];
  reader.read = async () => values.shift() ?? 2736;
  assert.equal(await reader.waitForCharge(null, 2742, 6, { timeoutMs: 1000, intervalMs: 1 }), 2736);
});

test("从 AI 弹窗设置面板读取余额后关闭面板", async () => {
  let open = false;
  let clicks = 0;
  const panel = {
    isVisible: async () => open,
    waitFor: async ({ state }) => assert.equal(open, state === "visible"),
    locator: (selector) => {
      assert.equal(selector, ".moli-credit-detail");
      return { waitFor: async () => {}, innerText: async () => "可用 2,706 点/总计 3,000 点" };
    },
  };
  const gear = {
    waitFor: async () => {},
    click: async () => { open = !open; clicks += 1; },
  };
  const frame = { locator: (selector) => selector === "button.ai-settings-trigger" ? gear : panel };
  const reader = new AiDialogPointsReader({ timeouts: { actionMs: 100 } });
  assert.equal(await reader.read(frame), 2706);
  assert.equal(clicks, 2);
  assert.equal(open, false);
});

test("恢复会跳过已应用模式，并拒绝重复生成或重复扣点", async () => {
  const state = createModePointsState(await loadConfig("config/run.json"), "mode-points-test-3");
  state.records[0].generation_status = "succeeded";
  state.records[0].application_status = "applied";
  state.records[0].points_status = "passed";
  assert.doesNotThrow(() => resumeSafety(state));
  state.records[1].generation_status = "running";
  assert.throws(() => resumeSafety(state), /状态不确定/);
  state.records[1].generation_status = "succeeded";
  state.records[1].points_status = "checking";
  assert.throws(() => resumeSafety(state), /状态不确定/);
});

test("清理时任一区块定位不唯一就不执行删除", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-mode-points-"));
  try {
    const config = await loadConfig("config/run.json");
    config.paths.aiLifecycleDir = root;
    const runId = "mode-points-cleanup-test";
    const state = createModePointsState(config, runId);
    state.records[0].application_status = "applied";
    await writeModeJson(modePointsPaths(config, runId).state, state);
    const deleted = [];
    const editor = {
      page: { context: () => ({}) },
      customPageExists: async () => true,
      openCustomPage: async () => {},
      findAiBlockWrappers: async () => [],
      deleteAiBlock: async (item) => deleted.push(item),
      deleteCustomPage: async (item) => deleted.push(item),
    };
    const runner = new AiModePointsAutomation(editor, config, runId);
    await assert.rejects(runner.cleanup(), /匹配数量=0/);
    assert.deepEqual(deleted, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
