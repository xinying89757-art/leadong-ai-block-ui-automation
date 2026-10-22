import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig, validateProductFilterRegression } from "../src/config.mjs";
import {
  assertProductFilterState,
  createProductFilterState,
  productFilterDescriptor,
  productFilterResumeAction,
} from "../src/ai-product-filter-state.mjs";
import { productFilterSettingsDecision, configuredFilterEvidence, filterFieldListReady } from "../src/ai-product-filter-runner.mjs";

test('筛选占位提示、隐藏控件或重复组件不能作为有效筛选展示通过', () => {
  assert.equal(configuredFilterEvidence([{ text: 'Please select filter fields in the properties panel', visibleControls: 1 }]), false);
  assert.equal(configuredFilterEvidence([{ text: 'Category', visibleControls: 0 }]), false);
  assert.equal(configuredFilterEvidence([{ text: 'Category', visibleControls: 2 }]), true);
  assert.equal(configuredFilterEvidence([{ text: 'Category', visibleControls: 2 }, { text: 'Category', visibleControls: 2 }]), false);
});

test("产品筛选专项保留且产品筛选并入 003 页面", async () => {
  const config = await loadConfig("config/run.json");
  const mode = config.ai.productFilterRegression;
  assert.equal(mode.enabled, true);
  assert.equal(mode.type, "产品筛选");
  assert.equal(mode.pageName, "AI区块类型回归-004");
  assert.equal(mode.pagePath, "/ai-block-type-regression-004");
  assert.equal(mode.inputMode, "文字描述");
  assert.equal(mode.generationMode, "快速模式");
  assert.equal(mode.promptPolishEnabled, true);
  assert.equal(mode.blocksPerPage, 1);
  assert.deepEqual(config.ai.types, ["静态图文", "产品列表", "文章列表", "视频列表", "图册列表"]);
  assert.deepEqual(config.ai.followupPages.map((page) => page.types), [
    ["下载列表", "FAQ 列表", "产品分类", "文章分类", "视频分类"],
    ["图册分类", "下载分类", "FAQ 分类", "产品筛选", "导航"],
  ]);
});

test("产品筛选专项状态按 runId 和固定测试页隔离", async () => {
  const config = await loadConfig("config/run.json");
  const state = createProductFilterState(config, "product-filter-test-001");
  assert.equal(productFilterDescriptor(config).name, "AI区块类型回归-004");
  assert.equal(state.page.name, "AI区块类型回归-004-product-filter-test-001");
  assert.equal(state.page.path, "/ai-block-type-regression-004-product-filter-test-001");
  assert.doesNotThrow(() => assertProductFilterState(state, config, "product-filter-test-001"));
  assert.throws(() => assertProductFilterState(state, config, "other-run"), /运行 ID/);
  assert.equal(state.types.length, 1);
  assert.equal(state.types[0].type, "产品筛选");
});

test("产品筛选专项恢复不会重复生成已应用区块", async () => {
  const config = await loadConfig("config/run.json");
  const state = createProductFilterState(config, "product-filter-test-002");
  assert.throws(() => productFilterResumeAction(state, true), /状态为空/);
  state.types[0].generation_status = "succeeded";
  state.types[0].filter_settings.select_all_checked = true;
  state.types[0].filter_settings.apply_status = "succeeded";
  state.types[0].apply_status = "applied";
  state.page.types.push("产品筛选");
  assert.equal(productFilterResumeAction(state, true), "verify-page");
  state.types[0].recovery_required = true;
  // Old runs that marked applied without even recording an apply attempt must
  // inspect the canvas first; confirmed/uncertain clicks remain isolated.
  assert.equal(productFilterResumeAction(state, true), "verify-page");
  state.types[0].application_attempted = true;
  assert.throws(() => productFilterResumeAction(state, true), /状态不确定/);
});

test("已生成但应用前定位失败时恢复已有记录，不重新生成", async () => {
  const config = await loadConfig("config/run.json");
  const state = createProductFilterState(config, "product-filter-test-recover");
  const record = state.types[0];
  record.generation_status = "succeeded";
  record.recovery_required = true;
  record.filter_settings.apply_status = "failed";
  record.filter_settings.failure_reason = "产品筛选生成区块等待超时";
  assert.equal(productFilterResumeAction(state, true), "recover-generated-result");
});

test("全选状态已选中时不重复点击，未选中时需要点击", () => {
  assert.equal(productFilterSettingsDecision(true), "already-checked");
  assert.equal(productFilterSettingsDecision(false), "click");
});

test("筛选字段未加载、仍有加载计数或遮罩时不能操作或判定全选成功", () => {
  assert.equal(filterFieldListReady({ fieldCount: 0, loadingNumber: 1 }), false);
  assert.equal(filterFieldListReady({ fieldCount: 4, loadingNumber: 1 }), false);
  assert.equal(filterFieldListReady({ fieldCount: 4, loadingNumber: 0, loadingMaskVisible: true }), false);
  assert.equal(filterFieldListReady({ fieldCount: 4, loadingNumber: 0, loadingMaskVisible: false }), true);
});

test("产品筛选专项拒绝非固定页面或关闭润色配置", () => {
  const base = {
    enabled: true,
    type: "产品筛选",
    inputMode: "文字描述",
    generationMode: "快速模式",
    promptPolishEnabled: true,
    pageName: "AI区块类型回归-004",
    pagePath: "/ai-block-type-regression-004",
    prompt: "Create an English product filter block.",
    blocksPerPage: 1,
    fieldsLoadTimeoutMs: 30000,
    applyIntervalMs: 5000,
    publishInitialWaitMs: 15000,
    publishPollIntervalMs: 3000,
    publishTimeoutMs: 60000,
  };
  assert.doesNotThrow(() => validateProductFilterRegression(base));
  assert.throws(() => validateProductFilterRegression({ ...base, promptPolishEnabled: false }), /必须启用/);
  assert.throws(() => validateProductFilterRegression({ ...base, blocksPerPage: 2 }), /一个区块/);
  assert.throws(() => validateProductFilterRegression({ ...base, fieldsLoadTimeoutMs: 0 }), /fieldsLoadTimeoutMs/);
});
