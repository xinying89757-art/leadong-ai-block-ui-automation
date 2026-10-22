import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";
import { createInitialAiState } from "../src/ai-state.mjs";
import { mergeAiBlockCounts, specialHandlerKind } from "../src/ai-paged-runner.mjs";

test("第三页为五种类型并只给筛选和导航分派专用处理器", async () => {
  const config = await loadConfig("config/run.json");
  const page = config.ai.followupPages.find((item) => item.number === 3);
  const scoped = { ...config, ai: { ...config.ai, types: page.types, blocksPerPage: 5 } };
  const state = createInitialAiState(scoped, { number: 3, name: "page", path: "/page" });
  assert.equal(state.types.length, 5);
  assert.deepEqual(state.types.map((record) => specialHandlerKind(record.type)), [
    "standard", "standard", "standard", "product-filter", "navigation",
  ]);
  assert.equal(state.types[3].filter_settings.select_all_checked, false);
  assert.equal(state.types[4].navigation_settings.selected_count, 0);
});

test("同页专项状态可以恢复且不会污染普通类型", async () => {
  const config = await loadConfig("config/run.json");
  const page = config.ai.followupPages.find((item) => item.number === 3);
  const scoped = { ...config, ai: { ...config.ai, types: page.types, blocksPerPage: 5 } };
  const state = createInitialAiState(scoped, { number: 3, name: "page", path: "/page" });
  state.types[3].filter_settings.select_all_checked = true;
  state.types[3].filter_settings.apply_status = "succeeded";
  state.types[4].navigation_settings.selected_pages = [{ name: "A" }, { name: "B" }];
  state.types[4].navigation_settings.selected_count = 2;
  state.types[4].navigation_settings.add_status = "succeeded";
  state.types[4].navigation_settings.save_status = "succeeded";
  assert.equal(state.types[0].filter_settings, undefined);
  assert.equal(state.types[0].navigation_settings, undefined);
  assert.equal(state.types[3].filter_settings.select_all_checked, true);
  assert.equal(state.types[4].navigation_settings.selected_pages.length, 2);
});

test("编辑器区块计数同时兼容直接 AI 节点和外层区块包装器", () => {
  assert.equal(mergeAiBlockCounts(1, 1, 2), 2);
  assert.equal(mergeAiBlockCounts(2, 1, 1), 2);
});
