import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig, validateProductListSettingsRegression } from "../src/config.mjs";
import {
  assertProductListSettingsState,
  createProductListSettingsState,
  productListSettingsDescriptor,
  productListSettingsResumeAction,
  productScopeResumeAction,
  markProductScopeEffect,
  seedProductListSettingsFromHistory,
} from "../src/ai-product-list-settings-state.mjs";
import { MidsceneLocatorFallback, applyMidsceneEvidence, applyMidsceneFailure } from "../src/midscene-fallback.mjs";
import { AiProductListSettingsAutomation } from "../src/ai-product-list-settings-runner.mjs";
import {
  choosePreviewContentFrame,
  chooseProductCanvasCandidate,
  chooseProductListPanelCandidate,
  frameAncestry,
  isPagebuilderCanvasUrl,
  isFrameWithin,
  sanitizeFrameUrl,
} from "../src/product-list-frame-resolver.mjs";

test("产品列表设置专项配置使用独立页面和文字快速模式", async () => {
  const config = await loadConfig("config/run.json");
  const mode = config.ai.productListSettingsRegression;
  assert.equal(mode.enabled, true);
  assert.equal(mode.type, "产品列表");
  assert.equal(mode.inputMode, "文字描述");
  assert.equal(mode.generationMode, "快速模式");
  assert.equal(mode.promptPolishEnabled, true);
  assert.equal(mode.blocksPerPage, 1);
  assert.equal(mode.expectedPageSize, 5);
  assert.equal(mode.productSortLabel, "按照产品名称升序");
  assert.equal(mode.displayFieldLabel, "星级评价");
  assert.equal(mode.midsceneFallback.enabled, true);
  assert.equal(mode.midsceneFallback.scope, "all-settings");
  assert.equal(mode.midsceneFallback.maxCallsPerSetting, 1);
  assert.match(productListSettingsDescriptor(config, "run-001").name, /AI产品列表设置回归-run-001/);
  assert.match(productListSettingsDescriptor(config, "run-001").path, /ai-product-list-settings-regression-run-001/);
});

test("产品列表设置状态包含六个侧边栏设置并按 runId 隔离", async () => {
  const config = await loadConfig("config/run.json");
  const state = createProductListSettingsState(config, "product-list-settings-test-001");
  assert.equal(state.type.settings.length, 6);
  assert.equal(state.version, 2);
  assert.equal(state.type.settings.every((item) => item.effect_status === "pending"), true);
  assert.equal(state.type.result_checks.loading_flat.status, "pending");
  assert.deepEqual(state.type.settings.map((item) => item.key), ["product_scope", "sort", "loading", "page_size", "display_content", "base_color"]);
  assert.doesNotThrow(() => assertProductListSettingsState(state, config, "product-list-settings-test-001"));
  assert.throws(() => assertProductListSettingsState(state, config, "other-run"), /运行 ID/);
});

test("产品列表设置恢复不会重复生成，状态不确定时停止", async () => {
  const config = await loadConfig("config/run.json");
  const state = createProductListSettingsState(config, "product-list-settings-test-002");
  assert.throws(() => productListSettingsResumeAction(state, true), /状态为空/);
  state.type.generation_status = "succeeded";
  assert.equal(productListSettingsResumeAction(state, true), "recover-generated-result");
  state.type.apply_status = "applied";
  state.type.settings_status = "succeeded";
  state.page.types.push("产品列表");
  assert.equal(productListSettingsResumeAction(state, true), "verify-page");
  state.type.settings_status = "running";
  assert.throws(() => productListSettingsResumeAction(state, true), /状态不确定/);
});

test("生成成功但侧边栏设置失败时从生成记录恢复，不重复生成", async () => {
  const config = await loadConfig("config/run.json");
  const state = createProductListSettingsState(config, "product-list-settings-history-001");
  state.type.generation_status = "succeeded";
  state.type.settings_status = "failed";
  state.type.apply_status = "pending";
  assert.equal(productListSettingsResumeAction(state, true), "recover-generated-result");
  assert.match(state.type.history_marker, /AI Product List Settings product-list-settings-history-001/);
  state.type.apply_status = "applied";
  state.type.recovery_required = true;
  assert.equal(productListSettingsResumeAction(state, true), "continue-settings");
});

test("已应用区块的设置失败允许恢复设置验证且不重插区块", async () => {
  const config = await loadConfig("config/run.json");
  const state = createProductListSettingsState(config, "product-list-settings-settings-resume-001");
  state.type.generation_status = "succeeded";
  state.type.apply_status = "applied";
  state.type.settings_status = "failed";
  state.type.recovery_required = true;
  state.page.types.push("产品列表");
  assert.equal(productListSettingsResumeAction(state, true), "continue-settings");
  state.type.settings_status = "running";
  assert.throws(() => productListSettingsResumeAction(state, true), /状态不确定/);
});

test("分类效果未通过时从既有未发布页面重新应用设置，不重新生成", async () => {
  const config = await loadConfig("config/run.json");
  const state = createProductListSettingsState(config, "product-scope-resume-001");
  state.page.saved = true;
  state.page.types.push("产品列表");
  state.type.generation_status = "succeeded";
  state.type.apply_status = "applied";
  state.type.catalog.selected_category = { name: "测试分类", products: [{ id: "p1", name: "测试产品" }] };
  state.type.catalog.products = [{ id: "p1" }, { id: "p2" }];
  state.type.result_checks.product_scope.status = "pending";
  assert.equal(productScopeResumeAction(state, { categoryName: "测试分类", expectedCount: 1 }), "continue");
  state.type.result_checks.preview = { status: "failed", evidence: { reason: "分类结果包含非所选分类产品：p2" } };
  assert.equal(productScopeResumeAction(state, { categoryName: "测试分类", expectedCount: 1 }), "reapply-scope-and-revalidate");
  assert.throws(() => productScopeResumeAction(state, { categoryName: "其他分类", expectedCount: 1 }), /未确认目标分类/);
  assert.throws(() => productScopeResumeAction(state, { categoryName: "测试分类", expectedCount: 2 }), /数量不符/);
  state.page.published_verified = true;
  assert.throws(() => productScopeResumeAction(state, { categoryName: "测试分类", expectedCount: 1 }), /拒绝自动重写/);
  state.type.result_checks.product_scope.status = "passed";
  assert.equal(productScopeResumeAction(state, { categoryName: "测试分类", expectedCount: 1 }), "continue");
});

test("分类控件成功不能代替结果通过，实际 ID 精确匹配后同步设置状态", async () => {
  const config = await loadConfig("config/run.json");
  const state = createProductListSettingsState(config, "product-scope-effect-001");
  const setting = state.type.settings.find((item) => item.key === "product_scope");
  assert.throws(() => markProductScopeEffect(state.type, { checked: true }), /精确匹配证据/);
  assert.equal(setting.effect_status, "pending");
  const evidence = { passed: true, exact_match: true, actual_count: 1, visible_ids: ["p1"] };
  markProductScopeEffect(state.type, evidence);
  assert.equal(setting.status, "succeeded");
  assert.equal(setting.effect_status, "passed");
  assert.deepEqual(setting.effect_after.verified_result.visible_ids, ["p1"]);
});

test("完整设置先应用保存并验证分类，再恢复全部产品；恢复不会重测已通过分类", async () => {
  const config = await loadConfig("config/run.json");
  const state = createProductListSettingsState(config, "product-full-phase-001");
  const record = state.type;
  record.catalog = { captured_at: "now", products: [{ id: "p1" }, { id: "p2" }], selected_category: { name: "测试分类", products: [{ id: "p1" }] } };
  const events = [];
  const runner = Object.create(AiProductListSettingsAutomation.prototype);
  Object.assign(runner, {
    state, config, paths: {},
    mode: { ...config.ai.productListSettingsRegression, skipProductScope: false, productScopeOnly: false, productScopeCategoryName: "测试分类", productScopeExpectedCount: 1 },
    editor: { dismissPageMenu: async () => {}, savePage: async () => events.push("save-category") },
    persist: async () => {},
    openProductListSidebarStrict: async () => {},
    settingsPanel: async () => ({}),
    ensureSettingsPanel: async () => ({}),
    setProductScope: async (_panel, scope) => { events.push(scope); return { after: scope }; },
    commitSettingsEditor: async () => events.push("apply"),
    verifyCommittedSettings: async () => { assert.equal(runner.mode.productScopeOnly, true); events.push("category-applied-result"); },
    verifyProductListPreviewWithRetry: async () => {
      assert.equal(runner.mode.productScopeOnly, true);
      events.push("preview-category");
      record.result_checks.product_scope = { status: "passed", evidence: { after_saved_preview: { passed: true, exact_match: true, actual_count: 1 } } };
    },
    chooseDifferentDropdown: async (_panel, key) => { events.push(key); return { after: key }; },
    settingsRow: async () => ({}), readRow: async () => "分页",
    changeSlider: async () => ({ after: "5" }),
    toggleDisplayContent: async () => ({ after: "off" }),
    chooseColor: async () => ({ after: "blue" }),
  });
  await runner.configureSettings(record);
  assert.deepEqual(events.slice(0, 6), ["指定分类", "apply", "category-applied-result", "save-category", "preview-category", "全部产品"]);
  assert.equal(record.category_phase.status, "passed");
  assert.equal(record.result_checks.product_scope.status, "passed");
  assert.equal(record.result_checks.preview.status, "pending");
  assert.equal(state.page.saved, false);
  assert.equal(runner.mode.productScopeOnly, false);
  events.length = 0;
  await runner.configureSettings(record);
  assert.equal(events.includes("指定分类"), false);
  assert.equal(events.includes("preview-category"), false);
  assert.equal(events.includes("全部产品"), true);
});

test("产品列表设置专项拒绝改变类型、模式或关闭润色", () => {
  const base = {
    enabled: true,
    type: "产品列表",
    inputMode: "文字描述",
    generationMode: "快速模式",
    promptPolishEnabled: true,
    pageNamePrefix: "AI产品列表设置回归-",
    pagePathPrefix: "ai-product-list-settings-regression-",
    prompt: "Create an English product list block.",
    blocksPerPage: 1,
    expectedPageSize: 5,
    productSortLabel: "按照产品名称升序",
    displayFieldLabel: "星级评价",
    targetColorHex: "#2458D3",
    applyIntervalMs: 5000,
    publishInitialWaitMs: 15000,
    publishPollIntervalMs: 3000,
    publishTimeoutMs: 60000,
  };
  assert.doesNotThrow(() => validateProductListSettingsRegression(base));
  assert.throws(() => validateProductListSettingsRegression({ ...base, type: "产品筛选" }), /类型/);
  assert.throws(() => validateProductListSettingsRegression({ ...base, promptPolishEnabled: false }), /启用/);
  assert.throws(() => validateProductListSettingsRegression({ ...base, blocksPerPage: 2 }), /一个区块/);
  assert.throws(() => validateProductListSettingsRegression({ ...base, expectedPageSize: 8 }), /必须为 5/);
});

test("产品列表设置状态记录 Playwright/Midscene 定位来源并兼容旧状态", async () => {
  const config = await loadConfig("config/run.json");
  const state = createProductListSettingsState(config, "product-list-settings-midscene-001");
  const setting = state.type.settings[0];
  assert.equal(setting.locator_source, "playwright");
  assert.equal(setting.fallback_used, false);
  applyMidsceneEvidence(setting, { source: "midscene", duration_ms: 321, rect: { left: 1, top: 2, width: 3, height: 4 } });
  assert.equal(setting.locator_source, "midscene");
  assert.equal(setting.fallback_used, true);
  assert.equal(setting.midscene_duration_ms, 321);
  assert.deepEqual(setting.midscene_rect, { left: 1, top: 2, width: 3, height: 4 });
  applyMidsceneFailure(setting, new Error("视觉定位超时"));
  assert.match(setting.midscene_failure_reason, /超时/);
  assert.doesNotThrow(() => assertProductListSettingsState(state, config, "product-list-settings-midscene-001"));
});

test("Midscene 兜底每个设置项最多调用一次且缺少密钥时安全失败", async () => {
  const fallback = new MidsceneLocatorFallback({}, { enabled: true, maxCallsPerSetting: 1, midsceneTimeoutMs: 10 });
  const previous = process.env.MIDSCENE_MODEL_API_KEY;
  delete process.env.MIDSCENE_MODEL_API_KEY;
  await assert.rejects(() => fallback.locate("product_scope", "产品数据下拉框"), /MIDSCENE_MODEL_API_KEY/);
  await assert.rejects(() => fallback.locate("product_scope", "产品数据下拉框"), /调用上限/);
  if (previous !== undefined) process.env.MIDSCENE_MODEL_API_KEY = previous;
});

test("Midscene 返回截图像素坐标时按 dpr 换算为 Playwright CSS 坐标", async () => {
  const previous = process.env.MIDSCENE_MODEL_API_KEY;
  process.env.MIDSCENE_MODEL_API_KEY = "test-only-not-a-real-key";
  let calls = 0;
  const fallback = new MidsceneLocatorFallback({}, {
    enabled: true,
    maxCallsPerSetting: 1,
    agentFactory: async () => ({
      aiLocate: async () => {
        calls += 1;
        return { center: [200, 100], dpr: 2, rect: { left: 180, top: 80, width: 40, height: 40 } };
      },
    }),
  });
  try {
    const result = await fallback.locate("product_scope", "产品数据下拉框");
    assert.deepEqual(result.center, [100, 50]);
    assert.deepEqual(result.rect, { left: 90, top: 40, width: 20, height: 20 });
    assert.equal(result.dpr, 2);
    assert.equal(calls, 1);
  } finally {
    if (previous === undefined) delete process.env.MIDSCENE_MODEL_API_KEY;
    else process.env.MIDSCENE_MODEL_API_KEY = previous;
  }
});

test("iframe 层级解析可识别嵌套画布并脱敏 URL 参数", () => {
  const root = { name: () => "root", url: () => "https://website.leadong.com/phoenix2/composite/blockEditorUI/index.html" };
  const nested = { name: () => "canvas", url: () => "about:blank", parentFrame: () => root };
  assert.equal(isFrameWithin(nested, root), true);
  assert.deepEqual(frameAncestry(nested), [
    { name: "root", url: "https://website.leadong.com/phoenix2/composite/blockEditorUI/index.html" },
    { name: "canvas", url: "about:blank" },
  ]);
  assert.equal(sanitizeFrameUrl("https://example.test/editor?Authorization=secret&_=123#token"), "https://example.test/editor?Authorization=[redacted]&_=[redacted]");
});

test("产品列表画布解析区分页面构建器与全屏编辑器嵌套候选", () => {
  const pagebuilder = { url: () => "https://website.leadong.com/phoenix/pagebuilder/page-1?_=secret" };
  const queryRoutedPagebuilder = { url: () => "https://website.leadong.com/phoenix/pagebuilder?_=[redacted]" };
  const layoutShell = { url: () => "https://website.leadong.com/phoenix/pagebuilder/layout" };
  const nestedCanvas = { url: () => "about:blank" };
  const hiddenPreview = { frame: pagebuilder, visible: false, hasProductCards: true };
  const editorCanvas = { frame: nestedCanvas, visible: true, hasProductCards: true };
  assert.equal(chooseProductCanvasCandidate([hiddenPreview, { frame: pagebuilder, visible: true, hasProductCards: true }]).frame, pagebuilder);
  assert.equal(isPagebuilderCanvasUrl(queryRoutedPagebuilder.url()), true);
  assert.equal(chooseProductCanvasCandidate([{ frame: queryRoutedPagebuilder, visible: true, hasProductCards: true }]).frame, queryRoutedPagebuilder);
  assert.throws(() => chooseProductCanvasCandidate([{ frame: layoutShell, visible: true, hasProductCards: true }]), /唯一匹配失败/);
  assert.equal(chooseProductCanvasCandidate([hiddenPreview, editorCanvas], { fullScreen: true }), editorCanvas);
  assert.throws(() => chooseProductCanvasCandidate([]), /唯一匹配失败/);
  assert.throws(() => chooseProductCanvasCandidate([
    { frame: pagebuilder, visible: true, hasProductCards: true },
    { frame: { url: () => "https://website.leadong.com/phoenix/pagebuilder/page-2" }, visible: true, hasProductCards: true },
  ]), /2 个/);
});

test("预览内容 frame 按本站页面路径唯一匹配并拒绝重复 frame", () => {
  const shell = { url: () => "http://website.leadong.com/phoenix/pagebuilder/preview" };
  const content = { url: () => "http://en-site36422735.preview.leadong.com/ai-product-list-settings-regression-test" };
  const unrelated = { url: () => "https://other.preview.leadong.com/another-page" };
  assert.equal(choosePreviewContentFrame([shell, unrelated, content], "/ai-product-list-settings-regression-test"), content);
  assert.equal(choosePreviewContentFrame([shell, unrelated], "/ai-product-list-settings-regression-test"), null);
  assert.throws(() => choosePreviewContentFrame([content, { ...content }], "/ai-product-list-settings-regression-test"), /2 个/);
});

test("侧栏解析排除隐藏副本并拒绝重复可见产品列表侧栏", () => {
  const hidden = { visible: false, hasProductListTitle: true, hasRequiredSettings: true };
  const visible = { visible: true, hasProductListTitle: true, hasRequiredSettings: true };
  assert.equal(chooseProductListPanelCandidate([hidden, visible]), visible);
  assert.throws(() => chooseProductListPanelCandidate([visible, { ...visible }]), /2 个/);
  assert.throws(() => chooseProductListPanelCandidate([{ visible: true, hasProductListTitle: false, hasRequiredSettings: true }]), /0 个/);
});

test("frame 导航后重新解析使用新 frame 对象，不保留过期对象", () => {
  const oldFrame = { url: () => "https://website.leadong.com/phoenix/pagebuilder/old" };
  const nextFrame = { url: () => "https://website.leadong.com/phoenix/pagebuilder/new" };
  const resolve = (frames) => chooseProductCanvasCandidate(frames.map((frame) => ({ frame, visible: true, hasProductCards: true })));
  assert.equal(resolve([oldFrame]).frame, oldFrame);
  assert.equal(resolve([nextFrame]).frame, nextFrame);
  assert.notEqual(resolve([nextFrame]).frame, oldFrame);
});

test("独立产品列表运行可复用指定成功历史记录而不重新生成", async () => {
  const config = await loadConfig("config/run.json");
  const state = createProductListSettingsState(config, "product-list-frame-run-001");
  const history = createProductListSettingsState(config, "product-list-history-source-001");
  Object.assign(history.type, {
    generation_status: "succeeded",
    history_marker: "AI Product List Settings source marker",
    prompt: "The already generated prompt",
    original_prompt: "The original prompt",
    polished_prompt: "The polished prompt",
  });
  seedProductListSettingsFromHistory(state, history, history.run_id);
  assert.equal(state.type.generation_status, "succeeded");
  assert.equal(state.type.apply_status, "pending");
  assert.equal(state.type.history_marker, history.type.history_marker);
  assert.equal(state.type.history_source_run_id, history.run_id);
  assert.equal(state.type.application_source, "history");
  assert.equal(productListSettingsResumeAction(state, true), "recover-generated-result");
  assert.throws(() => seedProductListSettingsFromHistory(state, { type: { generation_status: "pending" } }, "pending-source"), /没有可复用/);
});
