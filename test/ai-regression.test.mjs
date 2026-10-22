import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";
import {
  REGRESSION_STAGES,
  assertRegressionState,
  createRegressionState,
  isSafetyFailure,
  regressionComplete,
} from "../src/ai-regression-state.mjs";

test("全量回归默认包含所有已跑通 AI 闭环", async () => {
  const config = await loadConfig("config/run.json");
  const state = createRegressionState(config, "regression-test");
  assert.deepEqual(REGRESSION_STAGES.map((stage) => stage.key), [
    "blocks-page-001",
    "blocks-pages-002-003",
    "details",
    "mode-points",
    "input-modes",
    "full-page",
    "history-reuse",
  ]);
  assert.doesNotThrow(() => assertRegressionState(state, config, "regression-test"));
  assert.equal(regressionComplete(state), false);
  for (const stage of state.stages) stage.status = "passed";
  assert.equal(regressionComplete(state), true);
});

test("安全性失败会阻断后续生成，普通业务失败可继续记录", () => {
  assert.equal(isSafetyFailure("登录失败：账号无效"), true);
  assert.equal(isSafetyFailure("站点语言不匹配"), true);
  assert.equal(isSafetyFailure("余额不足"), true);
  assert.equal(isSafetyFailure("应用状态不确定"), true);
  assert.equal(isSafetyFailure("公开页没有显示视频播放器"), false);
});
