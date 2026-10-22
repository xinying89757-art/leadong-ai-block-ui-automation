import assert from "node:assert/strict";
import test from "node:test";
import { aiPageDescriptor, loadConfig, validateAiConfig, validateImageGalleryRegression } from "../src/config.mjs";

test("AI 配置固定为五种不重复类型并排除产品详情", async () => {
  const config = await loadConfig("config/run.json");
  assert.equal(config.ai.blocksPerPage, 5);
  assert.equal(config.ai.promptPolishEnabled, true);
  assert.equal(config.ai.aiPolishSelector, "button.ai-polish-button");
  assert.ok(config.ai.aiPolishTimeoutMs >= 0);
  assert.deepEqual(config.ai.types, ["静态图文", "产品列表", "文章列表", "视频列表", "图册列表"]);
  assert.deepEqual(config.ai.excludedTypes, ["产品详情", "图册详情", "文章详情", "视频详情"]);
  assert.equal(new Set(config.ai.types).size, 5);
  for (const type of config.ai.types) assert.match(config.ai.prompts[type], /English/i);
  assert.equal(aiPageDescriptor(config, 1).path, "/ai-block-type-regression-001");
});

test("AI 后续分页与首页共同组成 15 种非详情类型且每页 5 个", async () => {
  const config = await loadConfig("config/run.json");
  assert.deepEqual(config.ai.followupPages, [
    { number: 2, types: ["下载列表", "FAQ 列表", "产品分类", "文章分类", "视频分类"] },
    { number: 3, types: ["图册分类", "下载分类", "FAQ 分类", "产品筛选", "导航"] },
  ]);
  const followupTypes = config.ai.followupPages.flatMap((page) => page.types);
  assert.equal(followupTypes.length, 10);
  assert.equal(new Set([...config.ai.types, ...followupTypes]).size, 15);
  assert.ok(followupTypes.includes("产品筛选"));
  assert.ok(followupTypes.includes("导航"));
  assert.ok(config.ai.followupPages.every((page) => page.types.length === 5));
  assert.ok(followupTypes.every((type) => !type.includes("详情")));
  for (const type of followupTypes) assert.match(config.ai.prompts[type], /English/i);
});

test("AI 详情覆盖三类系统页，产品详情明确记录为未覆盖", async () => {
  const config = await loadConfig("config/run.json");
  assert.deepEqual(config.ai.detailPages.map((detail) => detail.type), ["文章详情", "图册详情", "视频详情"]);
  assert.ok(!config.ai.detailPages.some((detail) => detail.type === "产品详情"));
  assert.equal(config.paths.aiDetailStateDir.endsWith(".state/ai-detail"), true);
  for (const detail of config.ai.detailPages) {
    assert.ok(detail.systemPage);
    assert.match(config.ai.prompts[detail.type], /English|英文|英语/i);
    assert.ok(detail.marker);
  }
});

test("图片集专项使用新 AI 类型配置，不改变现有图册列表或全量分页类型", async () => {
  const config = await loadConfig("config/run.json");
  const mode = config.ai.imageGalleryRegression;
  assert.equal(mode.enabled, true);
  assert.equal(mode.type, "图片集");
  assert.equal(mode.inputMode, "文字描述");
  assert.equal(mode.generationMode, "快速模式");
  assert.equal(mode.generationTimeoutMs, 180000);
  assert.match(mode.prompt, /English/i);
  assert.ok(config.ai.types.includes("图册列表"));
  assert.ok(!config.ai.types.includes("图片集"));
  assert.ok(!config.ai.followupPages.flatMap(page => page.types).includes("图片集"));
  assert.doesNotThrow(() => validateImageGalleryRegression(mode));
  assert.throws(() => validateImageGalleryRegression({ ...mode, type: "图册列表" }), /不能映射到图册列表/);
  assert.throws(() => validateImageGalleryRegression({ ...mode, generationTimeoutMs: 180001 }), /180000/);
});

test("重复 AI 类型或 types 数量变化会被拒绝", () => {
  assert.throws(() => validateAiConfig({
    enabled: true,
    blocksPerPage: 2,
    types: ["静态图文", "静态图文"],
    excludedTypes: [],
    inputMode: "文字描述",
    generationMode: "快速模式",
    prompts: { "静态图文": "English" },
    applyIntervalMs: 1,
    publishInitialWaitMs: 1,
    publishPollIntervalMs: 1,
    publishTimeoutMs: 1,
  }), /不能重复/);
});
