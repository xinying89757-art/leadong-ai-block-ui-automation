import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import test from "node:test";
import { loadConfig, projectRoot } from "../src/config.mjs";
import { readAdminCredentials } from "../src/auth.mjs";

test("配置中的本地路径全部相对当前解压目录解析", async () => {
  const config = await loadConfig("config/run.json");
  assert.equal(config.siteName, "xujiying-ai区块");
  assert.equal(config.siteLanguage, "英语");
  assert.equal(config.ai.inputModeRegression.imagePath, path.join(projectRoot, "fixtures", "images", "ai-block-test-image.png"));
  assert.equal(config.paths.aiRemainingStateDir, path.join(projectRoot, ".state", "ai-remaining"));
  assert.equal("rankingWorkbook" in config, false);
});

test("图片配置支持仓库相对路径、绝对路径和环境变量覆盖", async (t) => {
  const original = process.env.AIBLOCK_TEST_IMAGE;
  t.after(() => {
    if (original === undefined) delete process.env.AIBLOCK_TEST_IMAGE;
    else process.env.AIBLOCK_TEST_IMAGE = original;
  });
  delete process.env.AIBLOCK_TEST_IMAGE;
  const config = await loadConfig("config/run.json");
  assert.equal(config.ai.inputModeRegression.imagePath, path.join(projectRoot, "fixtures", "images", "ai-block-test-image.png"));
  process.env.AIBLOCK_TEST_IMAGE = "/tmp/custom-ai-block-test.png";
  const overridden = await loadConfig("config/run.json");
  assert.equal(overridden.ai.inputModeRegression.imagePath, "/tmp/custom-ai-block-test.png");
});

test("管理员配置文件可选，缺少凭据时仅在读取凭据时提示", async (t) => {
  const names = ["BUG1004949_ADMIN_CONFIG", "BUG1004949_ADMIN_ACCOUNT", "BUG1004949_ADMIN_PASSWORD"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  });
  for (const name of names) delete process.env[name];
  assert.equal((await loadConfig("config/run.json")).auth.configPath, null);
  await assert.rejects(readAdminCredentials({ auth: { configPath: null } }), /缺少管理员账号配置/);
  process.env.BUG1004949_ADMIN_ACCOUNT = "fake-account";
  process.env.BUG1004949_ADMIN_PASSWORD = "fake-password";
  assert.deepEqual(await readAdminCredentials({ auth: { configPath: null } }), {
    account: "fake-account", password: "fake-password",
  });

  const directory = await mkdtemp(path.join(os.tmpdir(), "aiblock-auth-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fakeConfig = path.join(directory, "fake-credentials.json");
  await writeFile(fakeConfig, JSON.stringify({ account: "file-account", password: "file-password" }));
  delete process.env.BUG1004949_ADMIN_ACCOUNT;
  delete process.env.BUG1004949_ADMIN_PASSWORD;
  assert.deepEqual(await readAdminCredentials({ auth: { configPath: fakeConfig } }), {
    account: "file-account", password: "file-password",
  });
});
