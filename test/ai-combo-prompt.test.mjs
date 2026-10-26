import test from "node:test";
import assert from "node:assert/strict";
import { comboPromptFor, selectNewCompositeHistoryRecord } from "../src/ai-combo-prompt.mjs";

test("combo prompts contain only the requested Chinese component names", () => {
  assert.equal(comboPromptFor("product_pair"), "产品列表和产品分类");
  assert.equal(comboPromptFor("article_pair"), "文章列表和文章分类");
  assert.equal(comboPromptFor("three_type"), "产品列表、产品分类和文章列表");
  assert.throws(() => comboPromptFor("unknown"), /Unknown combo key/);
});

test("combo history matching requires a new count, fresh timestamp, polished text, mode and cost", () => {
  const submittedAt = "2026-10-26T02:00:00.000Z";
  const record = (overrides = {}) => ({
    prompt: "产品列表和产品分类 经润色后的太阳能产品展示",
    status: "completed", block_type: "组合区块：产品列表、产品分类", mode: "quick", points: 6,
    timestamp: "2026-10-26 10:00:01", epoch_ms: Date.parse("2026-10-26T02:00:01.000Z"),
    ...overrides,
  });
  const old = record({ timestamp: "2026-10-26 09:00:00", epoch_ms: Date.parse("2026-10-26T01:00:00.000Z") });
  const fresh = record();
  const options = { baselineCount: 12, currentCount: 13, submittedAt,
    polishedPrompt: "经润色后的太阳能产品展示", mode: "quick", expectedPoints: 6 };
  assert.equal(selectNewCompositeHistoryRecord([fresh, old], options), fresh);
  assert.equal(selectNewCompositeHistoryRecord([fresh], { ...options, currentCount: 12 }), null);
  assert.equal(selectNewCompositeHistoryRecord([record({ mode: "deep" })], options), null);
  assert.equal(selectNewCompositeHistoryRecord([record({ points: 15 })], options), null);
  assert.equal(selectNewCompositeHistoryRecord([record({ prompt: "unrelated prompt" })], options), null);
  assert.equal(selectNewCompositeHistoryRecord([record({ status: "failed", points: 0 })], options).status, "failed");
});
