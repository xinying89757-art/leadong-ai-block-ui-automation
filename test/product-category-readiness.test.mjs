import assert from "node:assert/strict";
import test from "node:test";
import { waitForCategoryTreeReady } from "../src/product-category-readiness.mjs";

const ready = { mode: "指定分类", loading: false, nodeCount: 2, signature: "a,b", targets: [{ key: "b", disabled: false }] };
function clock() {
  let ms = 0;
  return { now: () => ms, delay: async (increment) => { ms += increment; } };
}

test("指定分类出现后仍等待加载完成和列表稳定", async () => {
  const time = clock();
  const result = await waitForCategoryTreeReady(async () => {
    if (time.now() < 5400) return { ...ready, loading: true };
    if (time.now() < 6000) return { ...ready, signature: `refresh-${time.now()}` };
    return ready;
  }, { ...time, timeoutMs: 10000 });
  assert.equal(result.targets[0].key, "b");
  assert.equal(result.wait_ms, 7000);
});

test("列表已缓存也保留切换模式后的五秒初始化窗口", async () => {
  const result = await waitForCategoryTreeReady(async () => ready, clock());
  assert.equal(result.wait_ms, 5000);
});

test("分类缺失、重复、禁用或仍加载时拒绝继续勾选", async () => {
  for (const snapshot of [
    { ...ready, targets: [] },
    { ...ready, targets: [ready.targets[0], ready.targets[0]] },
    { ...ready, targets: [{ key: "b", disabled: true }] },
    { ...ready, loading: true },
    { ...ready, mode: "全部产品" },
  ]) {
    await assert.rejects(waitForCategoryTreeReady(async () => snapshot, { ...clock(), timeoutMs: 6000 }), /列表未就绪/);
  }
});
