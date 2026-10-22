import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig, validateInputModeRegression } from "../src/config.mjs";
import {
  createInputModeState,
  finishInputPointsCheck,
  inputModePage,
  inputModeResumeSafety,
} from "../src/ai-input-modes-state.mjs";

test("输入方式专项固定为文字、图片、网址三种静态图文输入", async () => {
  const config = await loadConfig("config/run.json");
  const mode = config.ai.inputModeRegression;
  assert.deepEqual(mode.inputModes.map(({ key, label }) => [key, label]), [
    ["text", "文字描述"], ["image", "上传图片"], ["url", "提供网址"],
  ]);
  assert.equal(mode.type, "静态图文");
  assert.equal(mode.generationMode, "快速模式");
  assert.equal(mode.expectedCost, 6);
  assert.equal(mode.promptPolishEnabled, false);
  assert.equal(mode.referenceUrl, "https://www.udearspace.com/");
});

test("输入方式专项状态按运行 ID 隔离并保存图片路径和网址", async () => {
  const config = await loadConfig("config/run.json");
  const state = createInputModeState(config, "input-modes-test-1");
  assert.equal(state.records.length, 3);
  assert.equal(new Set(state.records.map((record) => record.input_mode)).size, 3);
  assert.ok(state.records[1].image_path.endsWith("/fixtures/images/ai-block-test-image.png"));
  assert.equal(state.records[2].reference_url, "https://www.udearspace.com/");
  assert.ok(inputModePage(config, "input-modes-test-1").name.endsWith("input-modes-test-1"));
});

test("输入方式专项校验每次快速模式扣除 6 点", async () => {
  const config = await loadConfig("config/run.json");
  const state = createInputModeState(config, "input-modes-test-2");
  for (const record of state.records) {
    record.points_before = 2706;
    assert.equal(finishInputPointsCheck(record, 2700), "passed");
    assert.equal(record.actual_cost, 6);
  }
  state.records[0].points_before = 2700;
  assert.equal(finishInputPointsCheck(state.records[0], 2691), "failed");
  assert.match(state.records[0].points_failure_reason, /预期扣除 6 点，实际扣除 9 点/);
});

test("输入方式专项恢复不会重复生成已应用输入方式", async () => {
  const config = await loadConfig("config/run.json");
  const state = createInputModeState(config, "input-modes-test-3");
  state.records[0].input_status = "succeeded";
  state.records[0].generation_status = "succeeded";
  state.records[0].application_status = "applied";
  state.records[0].points_status = "passed";
  assert.doesNotThrow(() => inputModeResumeSafety(state));
  state.records[1].input_status = "succeeded";
  state.records[1].generation_status = "running";
  assert.throws(() => inputModeResumeSafety(state), /状态不确定/);
});

test("输入方式专项配置拒绝重复输入方式和非 HTTPS 网址", async () => {
  const config = await loadConfig("config/run.json");
  assert.throws(() => validateInputModeRegression({ ...config.ai.inputModeRegression, inputModes: [
    config.ai.inputModeRegression.inputModes[0], config.ai.inputModeRegression.inputModes[0], config.ai.inputModeRegression.inputModes[2],
  ] }), /不能重复/);
  assert.throws(() => validateInputModeRegression({ ...config.ai.inputModeRegression, referenceUrl: "http://example.com" }), /HTTPS/);
});

test("图片和网址输入配置满足实际 UI 控件约定", async () => {
  const config = await loadConfig("config/run.json");
  assert.equal(config.selectors.aiUploadFileSelector, "input[type='file'].hidden-input");
  assert.equal(config.selectors.aiUploadPreviewSelector, ".preview-thumb, .el-image__inner[alt='预览']");
  assert.equal(config.selectors.aiUrlSelector, "input.ai-url-input");
  assert.ok(config.ai.inputModeRegression.imagePath.endsWith("/fixtures/images/ai-block-test-image.png"));
});
