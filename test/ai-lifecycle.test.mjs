import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { backupLifecycle, cleanupLifecycle, prepareLifecycle, restoreLifecycle } from "../src/ai-lifecycle.mjs";

test("生命周期备份、恢复和清理只操作脚本状态目录", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-lifecycle-"));
  const config = {
    siteName: "site",
    siteLanguage: "英语",
    publicBaseUrl: "http://example.test",
    paths: {
      aiLifecycleDir: path.join(root, "lifecycle"),
      aiStateFile: path.join(root, "ai.json"),
      aiRemainingStateDir: path.join(root, "remaining"),
      aiDetailStateDir: path.join(root, "detail"),
    },
  };
  await writeFile(config.paths.aiStateFile, '{"before":true}\n');
  const prepared = await prepareLifecycle(config, "run-test");
  assert.equal(prepared.runId, "run-test");
  await backupLifecycle(config, "run-test");
  await writeFile(config.paths.aiStateFile, '{"after":true}\n');
  await restoreLifecycle(config, "run-test");
  assert.match(await readFile(config.paths.aiStateFile, "utf8"), /before/);
  await writeFile(config.paths.aiStateFile, '{"test":true}\n');
  const cleaned = await cleanupLifecycle(config, "run-test");
  assert.equal(cleaned.status, "cleaned");
  assert.match(await readFile(config.paths.aiStateFile, "utf8"), /before/);
});
