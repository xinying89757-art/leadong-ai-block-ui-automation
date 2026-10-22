import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig, validateNavigationRegression } from "../src/config.mjs";
import {
  assertNavigationState,
  createNavigationState,
  navigationDescriptor,
  navigationResumeAction,
} from "../src/ai-navigation-state.mjs";
import { selectNavigationPages } from "../src/ai-navigation-runner.mjs";

test("导航专项配置固定为005、文字描述、快速模式和两个页面", async () => {
  const config = await loadConfig("config/run.json");
  const mode = config.ai.navigationRegression;
  assert.equal(mode.enabled, true);
  assert.equal(mode.type, "导航");
  assert.equal(mode.pageName, "AI区块类型回归-005");
  assert.equal(mode.pagePath, "/ai-block-type-regression-005");
  assert.equal(mode.promptPolishEnabled, true);
  assert.equal(mode.selectPageCount, 2);
  assert.deepEqual(config.ai.types, ["静态图文", "产品列表", "文章列表", "视频列表", "图册列表"]);
});

test("导航页面选择排除当前测试页且不重复", () => {
  const pages = selectNavigationPages([
    { name: "AI区块类型回归-005", path: "/ai-block-type-regression-005" },
    { name: "Page A", path: "/a" },
    { name: "Page A", path: "/a" },
    { name: "Page B", path: "/b" },
  ], "AI区块类型回归-005", 2);
  assert.deepEqual(pages.map((page) => page.name), ["Page A", "Page B"]);
  assert.throws(() => selectNavigationPages([{ name: "Page A" }], "AI区块类型回归-005", 2), /不足/);
});

test("导航状态按运行 ID 和固定测试页隔离", async () => {
  const config = await loadConfig("config/run.json");
  const state = createNavigationState(config, "navigation-test-001");
  assert.equal(navigationDescriptor(config).name, "AI区块类型回归-005");
  assert.doesNotThrow(() => assertNavigationState(state, config, "navigation-test-001"));
  assert.throws(() => assertNavigationState(state, config, "other-run"), /运行 ID/);
  assert.throws(() => navigationResumeAction(state, true), /状态为空/);
  state.types[0].generation_status = "succeeded";
  state.types[0].navigation_settings.selected_pages = [{ name: "A", path: "/a" }, { name: "B", path: "/b" }];
  state.types[0].navigation_settings.selected_count = 2;
  state.types[0].navigation_settings.add_status = "succeeded";
  state.types[0].navigation_settings.save_status = "succeeded";
  state.types[0].apply_status = "applied";
  assert.equal(navigationResumeAction(state, true), "verify-page");
  state.types[0].recovery_required = true;
  assert.equal(navigationResumeAction(state, true), "verify-page", "未保存的编辑器页面应由实时画布决定是否恢复");
  state.page.saved = true;
  assert.throws(() => navigationResumeAction(state, true), /状态不确定/);
  state.types[0].editor_verified = true;
  assert.equal(navigationResumeAction(state, true), "verify-page", "已保存且已验证的区块可继续公开链接校验");
});

test("导航配置拒绝非固定页、非文字快速模式或非两个页面", () => {
  const base = {
    enabled: true,
    type: "导航",
    inputMode: "文字描述",
    generationMode: "快速模式",
    promptPolishEnabled: true,
    pageName: "AI区块类型回归-005",
    pagePath: "/ai-block-type-regression-005",
    prompt: "Create an English navigation block.",
    blocksPerPage: 1,
    selectPageCount: 2,
    applyIntervalMs: 5000,
    publishInitialWaitMs: 15000,
    publishPollIntervalMs: 3000,
    publishTimeoutMs: 60000,
  };
  assert.doesNotThrow(() => validateNavigationRegression(base));
  assert.throws(() => validateNavigationRegression({ ...base, selectPageCount: 3 }), /两个页面/);
  assert.throws(() => validateNavigationRegression({ ...base, pageName: "other" }), /导航/);
  assert.throws(() => validateNavigationRegression({ ...base, promptPolishEnabled: false }), /启用/);
});
