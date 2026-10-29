import test from "node:test";
import assert from "node:assert/strict";
import { comboPromptFor, selectNewCompositeHistoryRecord } from "../src/ai-combo-prompt.mjs";

test("combo prompts are exact component names joined with plus", () => {
  assert.equal(comboPromptFor("product_pair"), "产品列表+产品分类");
  assert.equal(comboPromptFor("article_pair"), "文章列表+文章分类");
  assert.equal(comboPromptFor("three_type"), "产品列表+产品分类+文章列表");
  assert.throws(() => comboPromptFor("unknown"), /Unknown combo key/);
});

test("combo history matching requires a new count, fresh timestamp, polished text, mode and cost", () => {
  const submittedAt = "2026-10-26T02:00:00.000Z";
  const record = (overrides = {}) => ({
    prompt: "产品列表+产品分类",
    status: "completed", block_type: "组合区块：产品列表、产品分类", mode: "quick", points: 6,
    timestamp: "2026-10-26 10:00:01", epoch_ms: Date.parse("2026-10-26T02:00:01.000Z"),
    ...overrides,
  });
  const old = record({ timestamp: "2026-10-26 09:00:00", epoch_ms: Date.parse("2026-10-26T01:00:00.000Z") });
  const fresh = record();
  const options = { baselineCount: 12, currentCount: 13, submittedAt,
    polishedPrompt: "产品列表+产品分类", mode: "quick", expectedPoints: 6 };
  assert.equal(selectNewCompositeHistoryRecord([fresh, old], options), fresh);
  assert.equal(selectNewCompositeHistoryRecord([fresh], { ...options, currentCount: 12 }), null);
  assert.equal(selectNewCompositeHistoryRecord([fresh], { ...options, currentCount: 14 }), fresh);
  assert.equal(selectNewCompositeHistoryRecord([record({ mode: "deep" })], options), null);
  assert.equal(selectNewCompositeHistoryRecord([record({ points: 15 })], options), null);
  assert.equal(selectNewCompositeHistoryRecord([record({ prompt: "unrelated prompt" })], options), null);
  assert.equal(selectNewCompositeHistoryRecord([record({ status: "failed", points: 0 })], options).status, "failed");
});

test("video, gallery, download and FAQ combos use name-only prompts and route to their system pages", async () => {
  const { comboDefinition, comboSubblockPattern } = await import("../src/ai-combo-prompt.mjs");
  const { categorySystemPageFor } = await import("../src/ai-system-page-snapshot.mjs");
  const { readFile } = await import("node:fs/promises");
  const mapping = JSON.parse(await readFile(new URL("../config/default.json", import.meta.url), "utf8")).ai.categorySystemPages;
  const expected = {
    video_pair: ["视频列表+视频分类", "视频分类", "Video List"],
    gallery_pair: ["图册列表+图册分类", "图册分类", "Gallery"],
    download_pair: ["下载列表+下载分类", "下载分类", "Download"],
    faq_pair: ["FAQ 列表+FAQ 分类", "FAQ 分类", "FAQ"],
  };
  for (const [key, [prompt, category, systemPage]] of Object.entries(expected)) {
    assert.equal(comboPromptFor(key), prompt);
    assert.deepEqual(categorySystemPageFor(comboDefinition(key).types, mapping), { category, systemPage });
  }
  assert.match("video-item", comboSubblockPattern("视频列表"));
  assert.match("faq-question", comboSubblockPattern("FAQ 列表"));
  assert.match("download-item", comboSubblockPattern("下载列表"));
  assert.match("gallery-card", comboSubblockPattern("图册列表"));
  assert.match("video-category-nav", comboSubblockPattern("视频分类"));
});
