import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig, validateArticleListSettingsRegression } from "../src/config.mjs";
import {
  articleListSettingsDescriptor,
  articleListResumeAction,
  assertArticleListSettingsState,
  createArticleListSettingsState,
} from "../src/ai-article-list-settings-state.mjs";
import {
  assertArticleCategoryResult,
  assertArticleCatalogSort,
  assertArticleFieldVisibility,
  assertArticlePageSize,
  assertArticlePagination,
  assertArticleRenderedColorChanged,
  assertArticleSort,
  normalizeArticleCards,
} from "../src/ai-article-list-observations.mjs";
import { AiArticleListSettingsAutomation } from "../src/ai-article-list-settings-runner.mjs";

test("文章列表专项配置及页面按 runId 隔离", async () => {
  assert.equal(typeof AiArticleListSettingsAutomation, "function");
  const config = await loadConfig("config/run.json");
  const mode = config.ai.articleListSettingsRegression;
  assert.equal(mode.enabled, true);
  assert.equal(mode.type, "文章列表");
  assert.equal(mode.expectedPageSize, 5);
  assert.equal(mode.blocksPerPage, 1);
  assert.equal(mode.targetColorHex, "#2458D3");
  assert.match(articleListSettingsDescriptor(config, "case-001").name, /AI文章列表设置回归-case-001/);
  const state = createArticleListSettingsState(config, "case-001");
  assert.equal(state.mode, "ai-article-list-settings");
  assert.equal(state.type.settings.length, 6);
  assert.deepEqual(state.type.settings.map((item) => item.key), ["article_scope", "sort", "loading", "page_size", "display_content", "base_color"]);
  assert.doesNotThrow(() => assertArticleListSettingsState(state, config, "case-001"));
  assert.throws(() => assertArticleListSettingsState(state, config, "other"), /运行 ID/);
});

test("文章列表配置拒绝不确定分页和范围类型", () => {
  assert.throws(() => validateArticleListSettingsRegression({
    enabled: true, type: "产品列表", inputMode: "文字描述", generationMode: "快速模式", pageNamePrefix: "test-",
    pagePathPrefix: "test-", prompt: "prompt", articleSortLabel: "date desc", promptPolishEnabled: true,
    expectedPageSize: 5, blocksPerPage: 1, articleScopeMode: "全部文章", applyIntervalMs: 5000,
    publishInitialWaitMs: 1000, publishPollIntervalMs: 1000, publishTimeoutMs: 10000,
  }), /类型必须/);
});

test("文章 ID、分类、发布日期排序及分页进行结果级断言", () => {
  const cards = normalizeArticleCards([
    { id: 1, title: "Second", date: "2026-08-10", categoryIds: ["solar"] },
    { id: 2, title: "First", date: "2026-09-10", categoryIds: ["solar"] },
  ]);
  assert.deepEqual(assertArticleCategoryResult(cards, ["1", "2"], ["1", "2", "3"]).ids, ["1", "2"]);
  assert.doesNotThrow(() => assertArticleSort([...cards].reverse(), { field: "date", direction: "desc" }));
  const catalog = [
    { title: "First", published_at: "2026-09-10 10:00:00" },
    { title: "Second", published_at: "2026-08-10 10:00:00" },
  ];
  assert.doesNotThrow(() => assertArticleCatalogSort([cards[1], cards[0]], catalog));
  assert.throws(() => assertArticleCatalogSort(cards, catalog), /未按后台发布时间降序/);
  assert.throws(() => assertArticleSort(cards, { field: "date", direction: "desc" }), /未按/);
  assert.throws(() => assertArticlePageSize(cards, 5), /应展示 5/);
  assert.doesNotThrow(() => assertArticlePagination({ firstPage: [{ id: "1" }, { id: "2" }], secondPage: [{ id: "3" }], pagerVisible: true, totalArticles: 3 }));
  assert.throws(() => assertArticlePagination({ firstPage: [{ id: "1" }], secondPage: [], pagerVisible: false, totalArticles: 1 }), /数据不足|页码/);
});

test("文章字段显隐、颜色结果与恢复防重复断言", async () => {
  assert.deepEqual(assertArticleFieldVisibility(true, false, "发布日期"), { field: "发布日期", before_visible: true, after_visible: false, changed: true });
  assert.throws(() => assertArticleFieldVisibility(false, false, "发布日期"), /未从可见变为隐藏/);
  assert.doesNotThrow(() => assertArticleRenderedColorChanged(["rgb(0, 0, 0)"], ["rgb(36, 88, 211)"]));
  const config = await loadConfig("config/run.json");
  const state = createArticleListSettingsState(config, "resume-001");
  assert.equal(articleListResumeAction(state, true), "continue");
  state.type.generation_status = "succeeded";
  state.type.apply_status = "applied";
  state.type.settings_status = "pending";
  state.page.types.push("文章列表");
  assert.equal(articleListResumeAction(state, true), "continue-settings");
  state.type.application_attempted = true;
  state.type.apply_status = "pending";
  assert.throws(() => articleListResumeAction(state, true), /状态不确定/);
  state.type.application_attempted = false;
  state.type.apply_status = "applied";
  state.type.settings_status = "running";
  assert.equal(articleListResumeAction(state, true), "continue-settings");
  assert.equal(state.type.settings_status, "failed");
  state.type.settings_status = "running";
  state.type.settings[0].status = "running";
  assert.throws(() => articleListResumeAction(state, true), /状态不确定/);
});
