import { chmod, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { leadongEnv, resolveProjectPath } from "./config.mjs";
import { pollUntil } from "./wait-utils.mjs";

const DEFAULT_TIMEOUT_MS = 30_000;

function env(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

function optionalProxy(value) {
  return /^(none|direct|false)$/i.test(String(value ?? "").trim()) ? undefined : value;
}

function authSettings(config) {
  const configured = config.auth ?? {};
  return {
    configPath: leadongEnv("LEADONG_ADMIN_CONFIG", configured.configPath) ? resolveProjectPath(leadongEnv("LEADONG_ADMIN_CONFIG", configured.configPath)) : null,
    storageStatePath: env("UI_STORAGE_STATE", configured.storageStatePath) ? resolveProjectPath(env("UI_STORAGE_STATE", configured.storageStatePath)) : null,
    adminUrl: env("UI_ADMIN_URL", configured.adminUrl),
    loginUrl: env("UI_ADMIN_LOGIN_URL", configured.loginUrl),
    proxy: optionalProxy(env("UI_PROXY", configured.proxy)),
    maxAttempts: Number(configured.maxAttempts ?? 2),
  };
}

export async function readAdminCredentials(config) {
  const settings = authSettings(config);
  let fileConfig = {};
  if (settings.configPath) {
    try {
      fileConfig = JSON.parse(await readFile(settings.configPath, "utf8"));
    } catch (error) {
      if (!leadongEnv("LEADONG_ADMIN_ACCOUNT") || !leadongEnv("LEADONG_ADMIN_PASSWORD")) {
        throw new Error(`无法读取管理员账号配置 ${settings.configPath}：${error.message}`);
      }
    }
  }
  const account = leadongEnv("LEADONG_ADMIN_ACCOUNT", fileConfig.account);
  const password = leadongEnv("LEADONG_ADMIN_PASSWORD", fileConfig.password);
  if (!account || !password) {
    throw new Error(
      "缺少管理员账号配置，请设置 LEADONG_ADMIN_ACCOUNT/LEADONG_ADMIN_PASSWORD，或提供外部 admin-login.json",
    );
  }
  return { account, password };
}

export function authConfig(config) {
  return authSettings(config);
}

export async function isLoginPage(page) {
  if (/login|signin|passport/i.test(page.url())) return true;
  return page.locator("#loginName").first().isVisible().catch(() => false);
}

async function isVisible(locator) {
  return locator.isVisible().catch(() => false);
}

async function gotoAllowingRedirect(page, url) {
  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: DEFAULT_TIMEOUT_MS,
    });
  } catch (error) {
    if (!/ERR_ABORTED|aborted/i.test(error?.message ?? "")) throw error;
    await page.waitForTimeout(1200);
  }
}

export async function enterCloudPlatform(page) {
  const avatar = page.locator(".wrap-login-container, .wrap-login-dropdown").first();
  if (await isVisible(avatar)) await avatar.hover();
  const cloudLink = page.getByRole("link", { name: /返回.*领动云平台/ }).first();
  if (await isVisible(cloudLink)) {
    await cloudLink.click();
    await page.waitForLoadState("domcontentloaded", { timeout: DEFAULT_TIMEOUT_MS }).catch(() => {});
  }
}

export async function dismissBlockingModals(page) {
  try {
    const deadline = Date.now() + 5000;
    const modalSelector = '[role="dialog"], .el-dialog, .modal, .modal-dialog, [class*="modal"]';
    while (Date.now() < deadline) {
      const modals = page.locator(modalSelector);
      let dismissed = false;
      for (let index = 0, count = await modals.count().catch(() => 0); index < count; index += 1) {
        const modal = modals.nth(index);
        if (!(await modal.isVisible().catch(() => false)) || !(await modal.locator("video").count().catch(() => 0))) continue;
        const close = modal.locator('button[aria-label*="close" i], [aria-label*="关闭"], .el-dialog__close, .close, .modal-close, button.close').first();
        if (await close.isVisible().catch(() => false)) await close.click({ timeout: 1000 }).catch(() => {});
        else await page.keyboard.press("Escape").catch(() => {});
        await pollUntil(async () => !(await modal.isVisible().catch(() => false)), {
          timeoutMs: Math.min(1000, Math.max(1, deadline - Date.now())), intervalMs: 100,
        }).catch(() => {});
        dismissed = true;
        break;
      }
      if (!dismissed) return;
    }
  } catch {
    // This is a best-effort guard for transient landing-page video overlays.
  }
}

export async function saveStorageState(context, config) {
  const statePath = authSettings(config).storageStatePath;
  if (!statePath) return "";
  await mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
  await context.storageState({ path: statePath });
  await chmod(statePath, 0o600).catch(() => {});
  return statePath;
}

export async function automaticLogin(page, context, config) {
  const settings = authSettings(config);
  const credentials = await readAdminCredentials(config);
  const maxAttempts = Number.isInteger(settings.maxAttempts) && settings.maxAttempts > 0
    ? settings.maxAttempts
    : 2;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await gotoAllowingRedirect(page, settings.loginUrl);
      const username = page.getByPlaceholder("用户名/邮箱/手机号码").first();
      const password = page.getByPlaceholder("密码").first();
      await (await isVisible(username) ? username : page.locator("#loginName")).fill(credentials.account);
      const passwordField = await isVisible(password) ? password : page.locator("#password");
      await passwordField.fill(credentials.password);
      await passwordField.press("Enter").catch(() => {});
      await page.waitForLoadState("domcontentloaded", { timeout: DEFAULT_TIMEOUT_MS }).catch(() => {});
      await page.waitForTimeout(800);
      if (await isLoginPage(page)) {
        await page.locator("#loginSubmit").click();
        await page.waitForLoadState("domcontentloaded", { timeout: DEFAULT_TIMEOUT_MS }).catch(() => {});
      }
      await dismissBlockingModals(page);
      await enterCloudPlatform(page);
      await gotoAllowingRedirect(page, settings.adminUrl);
      await page.waitForTimeout(800);
      if (await isLoginPage(page)) {
        throw new Error("登录后仍停留在登录页");
      }
      await dismissBlockingModals(page);
      const statePath = await saveStorageState(context, config);
      return { attempt, statePath };
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) await page.waitForTimeout(1000);
    }
  }

  throw new Error(`管理员自动登录失败（已尝试${maxAttempts}次）：${lastError?.message ?? "未知错误"}`);
}

export async function ensureAuthenticated(page, context, config) {
  if (!(await isLoginPage(page))) {
    return { reused: true, statePath: await saveStorageState(context, config) };
  }
  return automaticLogin(page, context, config);
}
