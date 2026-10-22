import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig, validateImageGalleryRegression } from "../src/config.mjs";
import { createInitialAiState } from "../src/ai-state.mjs";
import {
  assertImageGalleryState,
  imageGalleryPassed,
  imageGalleryPaths,
  imageGalleryResumeAction,
  imageGalleryScopedConfig,
  newImageGalleryRunId,
} from "../src/ai-image-gallery-state.mjs";
import { exactTypeMenuMatches } from "../src/ai-type-menu.mjs";

test("图片集类型只与菜单中的精确文本匹配，不会误选图册列表或图片集分类", () => {
  const options = ["图册列表", "图片集分类", " 图片集 "];
  assert.deepEqual(exactTypeMenuMatches(options, "图片集"), [2]);
  assert.deepEqual(exactTypeMenuMatches(options, "图片集列表"), []);
  assert.deepEqual(exactTypeMenuMatches(["图片集", "图片集"], "图片集"), [0, 1]);
});

test("图片集配置独立于常规 AI 分页，且普通生成超时不超过三分钟", async () => {
  const config = await loadConfig("config/run.json");
  const mode = config.ai.imageGalleryRegression;
  assert.equal(mode.type, "图片集");
  assert.equal(mode.inputMode, "文字描述");
  assert.equal(mode.generationMode, "快速模式");
  assert.equal(mode.generationTimeoutMs, 180000);
  assert.ok(config.ai.types.includes("图册列表"));
  assert.ok(!config.ai.types.includes("图片集"));
  assert.deepEqual(config.ai.followupPages[1].types, ["图册分类", "下载分类", "FAQ 分类", "产品筛选", "导航"]);
  assert.doesNotThrow(() => validateImageGalleryRegression(mode));
  assert.throws(() => validateImageGalleryRegression({ ...mode, type: "图册列表" }), /不能映射到图册列表/);
  assert.throws(() => validateImageGalleryRegression({ ...mode, generationTimeoutMs: 180001 }), /180000/);
});

test("图片集页面、状态文件和恢复配置按 runId 唯一隔离", async () => {
  const config = await loadConfig("config/run.json");
  const runId = "image-gallery-unit-001";
  const paths = imageGalleryPaths(config, runId);
  const scoped = imageGalleryScopedConfig(config, runId, paths.state);
  const page = (await import("../src/config.mjs")).aiPageDescriptor(scoped, 1);
  const state = createInitialAiState(scoped, page);
  assert.match(paths.state, new RegExp(`/runs/${runId}/ai-image-gallery/state\\.json$`));
  assert.match(state.page.name, new RegExp(runId));
  assert.match(state.page.path, new RegExp(runId));
  assert.equal(state.types.length, 1);
  assert.equal(state.types[0].type, "图片集");
  assert.equal(newImageGalleryRunId(new Date("2026-10-20T01:02:03.000Z")), "image-gallery-20261020010203");
  assert.doesNotThrow(() => assertImageGalleryState(state, config, runId));
  assert.throws(() => assertImageGalleryState(state, config, "another-run"), /运行 ID/);
});

test("完整状态恢复为完成；只有唯一已应用区块才跳过生成", async () => {
  const config = await loadConfig("config/run.json");
  const runId = "image-gallery-resume-001";
  const scoped = imageGalleryScopedConfig(config, runId, "/tmp/image-gallery-state.json");
  const { aiPageDescriptor } = await import("../src/config.mjs");
  const state = createInitialAiState(scoped, aiPageDescriptor(scoped, 1));
  const record = state.types[0];
  assert.equal(imageGalleryResumeAction(state), "generate");
  record.generation_status = "succeeded";
  assert.throws(() => imageGalleryResumeAction(state), /生成已提交但应用状态未确认/);
  record.generation_status = "pending";
  record.application_attempted = true;
  assert.throws(() => imageGalleryResumeAction(state), /应用状态不确定/);
  record.application_attempted = false;
  record.generation_status = "succeeded";
  record.apply_status = "applied";
  record.committed_block_id = "siteblocks-setting-wrap-test";
  record.type_menu_evidence = { match_count: 1 };
  record.image_gallery_editor_evidence = { passed: true };
  state.page.types = ["图片集"];
  state.page.saved = true;
  state.page.editor_verified = true;
  state.page.preview_verified = true;
  state.page.published_verified = true;
  assert.equal(imageGalleryResumeAction(state), "complete");
  assert.equal(imageGalleryPassed(state), true);
});
