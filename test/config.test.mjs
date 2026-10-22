import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { loadConfig, pageDescriptor, projectRoot } from "../src/config.mjs";

test("配置中的本地路径全部相对当前解压目录解析", async () => {
  const config = await loadConfig("config/run.json");
  assert.equal(config.siteName, "xujiying-ai区块");
  assert.equal(config.siteLanguage, "英语");
  assert.equal(config.rankingWorkbook, path.join(projectRoot, "inputs", "区块排名.xlsx"));
  assert.equal(config.paths.stateFile, path.join(projectRoot, ".state", "ranking-heading-run-state.json"));
  assert.equal(config.paths.aiRemainingStateDir, path.join(projectRoot, ".state", "ai-remaining"));
  assert.deepEqual(pageDescriptor(config, 1), {
    number: 1,
    name: "区块排名H测试-001",
    path: "/block-ranking-heading-test-001",
    publicUrl: "http://en-site36422735.ldmfyh.com/block-ranking-heading-test-001",
  });
});
