import assert from "node:assert/strict";
import test from "node:test";
import {
  addedDetailCandidates,
  assertDetailOwnershipCompatible,
  createDetailOwnership,
  identityKey,
  selectOwnedDetailCandidate,
} from "../src/ai-detail-ownership.mjs";

const config = { siteName: "site", siteLanguage: "英语" };
const detail = { type: "文章详情", systemPage: "News Detail", moduleId: "article" };

test("详情所有权优先使用稳定区块 ID 并且只匹配唯一旧区块", () => {
  const owner = createDetailOwnership(config, detail, "run-1", { id: "block-1", text: "marker" });
  const candidates = [
    { identity: { id: "block-1", text: "marker" } },
    { identity: { id: "block-2", text: "other" } },
  ];
  assert.equal(identityKey(owner.identity), "id:block-1");
  assert.equal(selectOwnedDetailCandidate(candidates, owner).length, 1);
  assert.doesNotThrow(() => assertDetailOwnershipCompatible(owner, config, detail));
});

test("详情区块应用前后必须且只能识别一个新增稳定区块", () => {
  const before = [{ identity: { id: "existing" } }];
  const after = [...before, { identity: { id: "new-detail" } }];
  assert.deepEqual(addedDetailCandidates(before, after).map((item) => item.identity.id), ["new-detail"]);
  assert.equal(addedDetailCandidates(before, [...after, { identity: { id: "new-detail-2" } }]).length, 2);
});

test("详情所有权站点或系统页不一致时拒绝清理", () => {
  const owner = createDetailOwnership(config, detail, "run-1", { pageId: "px2-1" });
  assert.throws(
    () => assertDetailOwnershipCompatible(owner, { ...config, siteName: "other" }, detail),
    /不匹配/,
  );
  assert.throws(
    () => assertDetailOwnershipCompatible(owner, config, { ...detail, systemPage: "Other Detail" }),
    /不匹配/,
  );
});
