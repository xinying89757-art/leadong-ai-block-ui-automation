import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import test from "node:test";
import { loadConfig, loadLocalEnvironment, parseLocalEnvironment, projectRoot, resolveSetting } from "../src/config.mjs";
import { readAdminCredentials } from "../src/auth.mjs";

test("本地环境文件解析保留已有环境变量，去除引号并忽略注释和无效行", async () => {
  const env = { EXISTING: "shell" };
  parseLocalEnvironment("# comment\nEXISTING=file\nQUOTED=\"some value\"\nSINGLE='value'\nINVALID LINE\n=empty\n", env);
  assert.deepEqual(env, { EXISTING: "shell", QUOTED: "some value", SINGLE: "value" });
  const directory = await mkdtemp(path.join(os.tmpdir(), "leadong-env-test-"));
  try {
    await writeFile(path.join(directory, ".env.local"), "FROM_FILE='loaded'\n");
    const isolated = {};
    await loadLocalEnvironment(directory, isolated);
    assert.deepEqual(isolated, { FROM_FILE: "loaded" });
    await loadLocalEnvironment(path.join(directory, "missing"), isolated);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("setting resolution gives LEADONG precedence over AIBLOCK", () => {
  assert.equal(resolveSetting("LEADONG_HEADLESS", "fallback", { LEADONG_HEADLESS: "false", AIBLOCK_HEADLESS: "true" }), "false");
  assert.equal(resolveSetting("LEADONG_ADMIN_ACCOUNT", "fallback", { LEADONG_ADMIN_ACCOUNT: "current", AIBLOCK_ADMIN_ACCOUNT: "middle" }), "current");
});

test("setting resolution uses AIBLOCK before the credential-only BUG1004949 fallback", () => {
  assert.equal(resolveSetting("LEADONG_ADMIN_ACCOUNT", "fallback", {
    AIBLOCK_ADMIN_ACCOUNT: "middle", BUG1004949_ADMIN_ACCOUNT: "old",
  }), "middle");
  assert.equal(resolveSetting("LEADONG_ADMIN_ACCOUNT", "fallback", { BUG1004949_ADMIN_ACCOUNT: "old" }), "old");
  assert.equal(resolveSetting("LEADONG_TEST_IMAGE", "fallback", { BUG1004949_TEST_IMAGE: "ignored" }), "fallback");
});

test("setting resolution accepts legacy aliases for slow motion, image and test browser", () => {
  assert.equal(resolveSetting("LEADONG_SLOW_MO", "fallback", { AIBLOCK_SLOWMO: "45" }), "45");
  assert.equal(resolveSetting("LEADONG_TEST_IMAGE", "fallback", { AIBLOCK_TEST_IMAGE: "fixture.png" }), "fixture.png");
  assert.equal(resolveSetting("LEADONG_TEST_BROWSER_CHANNEL", "chromium", {
    LEADONG_TEST_BROWSER_CHANNEL: "chrome", AIBLOCK_TEST_BROWSER_CHANNEL: "chromium",
  }), "chrome");
  assert.equal(resolveSetting("LEADONG_TEST_BROWSER_CHANNEL", "chromium", { AIBLOCK_TEST_BROWSER_CHANNEL: "chromium" }), "chromium");
});

test("配置中的本地路径全部相对当前解压目录解析", async () => {
  const config = await loadConfig("config/run.json");
  assert.equal(config.siteName, "xujiying-ai区块");
  assert.equal(config.siteLanguage, "英语");
  assert.equal(config.ai.inputModeRegression.imagePath, path.join(projectRoot, "fixtures", "images", "test-image.png"));
  assert.equal(config.paths.aiRemainingStateDir, path.join(projectRoot, ".state", "ai-remaining"));
  assert.equal(config.paths.userDataDir, path.join(projectRoot, ".auth", "chrome-profile"));
  assert.equal(config.auth.storageStatePath, path.join(projectRoot, ".auth", "admin.storage.json"));
  assert.equal(config.ai.inputModeRegression.imagePath, path.join(projectRoot, "fixtures", "images", "test-image.png"));
  assert.equal(config.htmlUploadRegression.filePath, path.join(projectRoot, "fixtures", "html-upload", "pulse-dashboard.html"));
  assert.equal("rankingWorkbook" in config, false);
});

test("图片配置支持仓库相对路径、绝对路径和环境变量覆盖", async (t) => {
  const original = process.env.LEADONG_TEST_IMAGE;
  const legacy = process.env.AIBLOCK_TEST_IMAGE;
  t.after(() => {
    if (original === undefined) delete process.env.LEADONG_TEST_IMAGE;
    else process.env.LEADONG_TEST_IMAGE = original;
    if (legacy === undefined) delete process.env.AIBLOCK_TEST_IMAGE;
    else process.env.AIBLOCK_TEST_IMAGE = legacy;
  });
  delete process.env.LEADONG_TEST_IMAGE;
  delete process.env.AIBLOCK_TEST_IMAGE;
  const config = await loadConfig("config/run.json");
  assert.equal(config.ai.inputModeRegression.imagePath, path.join(projectRoot, "fixtures", "images", "test-image.png"));
  process.env.LEADONG_TEST_IMAGE = "/tmp/custom-ai-block-test.png";
  const overridden = await loadConfig("config/run.json");
  assert.equal(overridden.ai.inputModeRegression.imagePath, "/tmp/custom-ai-block-test.png");
});

test("管理员配置文件可选，缺少凭据时仅在读取凭据时提示", async (t) => {
  const names = [
    "LEADONG_ADMIN_CONFIG", "LEADONG_ADMIN_ACCOUNT", "LEADONG_ADMIN_PASSWORD",
    "AIBLOCK_ADMIN_CONFIG", "AIBLOCK_ADMIN_ACCOUNT", "AIBLOCK_ADMIN_PASSWORD",
    "BUG1004949_ADMIN_CONFIG", "BUG1004949_ADMIN_ACCOUNT", "BUG1004949_ADMIN_PASSWORD",
  ];
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
  process.env.BUG1004949_ADMIN_ACCOUNT = "legacy-account";
  process.env.BUG1004949_ADMIN_PASSWORD = "legacy-password";
  assert.deepEqual(await readAdminCredentials({ auth: { configPath: null } }), {
    account: "legacy-account", password: "legacy-password",
  });

  process.env.LEADONG_ADMIN_ACCOUNT = "new-account";
  process.env.LEADONG_ADMIN_PASSWORD = "new-password";
  assert.deepEqual(await readAdminCredentials({ auth: { configPath: null } }), {
    account: "new-account", password: "new-password",
  });

  const directory = await mkdtemp(path.join(os.tmpdir(), "leadong-auth-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fakeConfig = path.join(directory, "fake-credentials.json");
  await writeFile(fakeConfig, JSON.stringify({ account: "file-account", password: "file-password" }));
  delete process.env.BUG1004949_ADMIN_ACCOUNT;
  delete process.env.BUG1004949_ADMIN_PASSWORD;
  delete process.env.LEADONG_ADMIN_ACCOUNT;
  delete process.env.LEADONG_ADMIN_PASSWORD;
  assert.deepEqual(await readAdminCredentials({ auth: { configPath: fakeConfig } }), {
    account: "file-account", password: "file-password",
  });

  process.env.BUG1004949_ADMIN_CONFIG = fakeConfig;
  process.env.LEADONG_ADMIN_CONFIG = path.join(directory, "new-config.json");
  const newConfig = path.join(directory, "new-config.json");
  await writeFile(newConfig, JSON.stringify({ account: "preferred-file-account", password: "preferred-file-password" }));
  assert.deepEqual(await readAdminCredentials({ auth: { configPath: null } }), {
    account: "preferred-file-account", password: "preferred-file-password",
  });
  process.env.LEADONG_ADMIN_ACCOUNT = "env-account";
  process.env.LEADONG_ADMIN_PASSWORD = "env-password";
  process.env.LEADONG_ADMIN_CONFIG = path.join(directory, "missing-config.json");
  assert.deepEqual(await readAdminCredentials({ auth: { configPath: null } }), { account: "env-account", password: "env-password" });
});
