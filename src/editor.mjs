import { mkdir } from "node:fs/promises";
import path from "node:path";
import { assertPageCapacityAvailable } from './ai-platform-errors.mjs';
import { chromium } from "playwright";
import { pageCreationRequest, pageCreationResult, pagePath, comparePageIdentity } from './page-identity.mjs';
import { authConfig, automaticLogin, ensureAuthenticated, isLoginPage } from "./auth.mjs";

function regex(source) {
  return new RegExp(source, "i");
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isLanguageOptionSelected({ className = "", ariaSelected = "" } = {}) {
  return String(className).split(/\s+/).includes("on") || String(ariaSelected).toLowerCase() === "true";
}

function escapeCssAttributeValue(value) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("'", "\\'");
}

async function discoverPublicBaseUrl(card) {
  const urls = await card
    .locator("a[href], [data-url], [data-href]")
    .evaluateAll((nodes) => nodes.map((node) =>
      node.getAttribute("href") || node.getAttribute("data-url") || node.getAttribute("data-href") || "",
    ))
    .catch(() => []);
  for (const value of urls) {
    try {
      const url = new URL(value, "http://localhost");
      if (!/^https?:$/i.test(url.protocol)) continue;
      if (/website\.leadong\.com|jianzhan\.leadong\.com|\/phoenix\//i.test(`${url.hostname}${url.pathname}`)) continue;
      return url.origin;
    } catch {
      // Ignore non-URL links such as javascript: handlers.
    }
  }
  return "";
}

async function firstVisible(locators) {
  for (const locator of locators) {
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible().catch(() => false)) {
        return candidate;
      }
    }
  }
  return null;
}

async function waitFirstVisible(locators, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await firstVisible(locators);
    if (found) {
      return found;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

async function isInViewport(locator, { fully = false } = {}) {
  return locator
    .evaluate(
      (element, options) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const horizontallyVisible = options.fully
          ? rect.left >= -1 && rect.right <= window.innerWidth + 1
          : rect.right > 0 && rect.left < window.innerWidth;
        const verticallyVisible = options.fully
          ? rect.top >= -1 && rect.bottom <= window.innerHeight + 1
          : rect.bottom > 0 && rect.top < window.innerHeight;
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0 &&
          horizontallyVisible &&
          verticallyVisible
        );
      },
      { fully },
    )
    .catch(() => false);
}

function textLocators(scope, patterns) {
  return patterns.map((pattern) => scope.getByText(regex(pattern)));
}

function labelLocators(scope, labels) {
  return labels.map((label) => scope.getByLabel(regex(label)));
}

function placeholderLocators(scope, placeholders) {
  return placeholders.map((placeholder) =>
    scope.getByPlaceholder(placeholder, { exact: true }),
  );
}

function followingInputLocators(scope, labels) {
  return labels.map((label) =>
    scope
      .getByText(new RegExp(`^\\s*${escapeRegex(label)}\\s*$`, "i"))
      .locator("xpath=following::input[not(@type='hidden')][1]"),
  );
}

export function enteredEditorPage(pages, { knownPages, currentPage, navigatedPages = new Set() }) {
  const editors = pages.filter(candidate => !candidate.isClosed() && candidate.url().includes('/phoenix/pagebuilder'));
  return editors.find(candidate => !knownPages.has(candidate)) ||
    editors.find(candidate => candidate === currentPage) ||
    editors.find(candidate => navigatedPages.has(candidate)) || null;
}

export async function launchEditorBrowser(config, options = {}) {
  await mkdir(config.paths.userDataDir, { recursive: true });
  const isolatedProfile = options.isolatedProfile === true;
  const profileDir = isolatedProfile
    ? path.join(
      config.paths.aiLifecycleDir ?? path.join(projectRoot, ".state", "ai-lifecycle"),
      "profiles",
      String(config.ai?.runId ?? `interactive-${process.pid}`).replace(/[^a-zA-Z0-9_-]+/g, "-"),
    )
    : config.paths.userDataDir;
  await mkdir(profileDir, { recursive: true });
  const browserOptions = {
    channel: config.browser.channel,
    headless: options.headless ?? config.browser.headless,
    locale: config.browser.locale,
    slowMo: options.slowMo ?? config.browser.slowMo,
    viewport: null,
    args: ["--start-maximized"],
  };
  const proxy = authConfig(config).proxy ?? config.browser.proxy;
  if (proxy) browserOptions.proxy = { server: proxy };
  const context = await chromium.launchPersistentContext(
    profileDir,
    browserOptions,
  );
  const pages = context.pages();
  const page = pages.find((candidate) =>
    candidate.url().includes("/phoenix/pagebuilder"),
  ) ?? pages.at(-1) ?? (await context.newPage());
  page.setDefaultTimeout(config.timeouts.actionMs);
  page.setDefaultNavigationTimeout(config.timeouts.blockRenderMs);

  if (options.traceName) {
    await context.tracing.start({
      screenshots: true,
      snapshots: true,
      sources: true,
      title: options.traceName,
    });
  }
  return { context, page };
}

export async function stopTrace(context, tracePath) {
  if (!tracePath) {
    return;
  }
  await mkdir(path.dirname(tracePath), { recursive: true });
  await context.tracing.stop({ path: tracePath });
}

export class LeadongEditor {
  constructor(page, config) {
    this.page = page;
    this.config = config;
  }

  contexts() {
    return [this.page, ...this.page.frames().filter((frame) => frame !== this.page.mainFrame())];
  }

  canvasContexts() {
    // The live 3.0 iframe is the only committed canvas. Do not choose an old
    // or AI result frame because it happens to contain more blocks.
    const active = this.page.frames().filter(frame => frame.name() === 'backstage-innerpage');
    if (active.length === 1) return active;
    const expected = this.config.selectors.editorFrameUrlIncludes;
    const matching = this.page
      .frames()
      .filter(
        (frame) =>
          frame !== this.page.mainFrame() && frame.url().includes(expected),
      );
    if (matching.length > 0) {
      return matching;
    }
    const childFrames = this.page
      .frames()
      .filter((frame) => {
        if (frame === this.page.mainFrame()) return false;
        for (let ancestor = frame; ancestor; ancestor = ancestor.parentFrame()) {
          if (ancestor.url().includes('/blockEditorUI/')) return false;
        }
        return /\/phoenix\/pagebuilder(?:[/?]|$)/.test(frame.url());
      });
    return childFrames.length > 0 ? childFrames : [this.page];
  }

  async goto() {
    await this.page.goto(this.config.editorUrl, {
      waitUntil: "domcontentloaded",
    });
    await this.page.waitForTimeout(1200);
    if (await isLoginPage(this.page)) {
      await ensureAuthenticated(this.page, this.page.context(), this.config);
      await this.page.goto(this.config.editorUrl, {
        waitUntil: "domcontentloaded",
      });
      await this.page.waitForTimeout(1200);
    }
    if (!this.page.url().includes("/phoenix/pagebuilder") && !this.page.url().includes(this.config.siteListUrlIncludes)) {
      await automaticLogin(this.page, this.page.context(), this.config);
      await this.page.goto(authConfig(this.config).adminUrl, { waitUntil: "domcontentloaded" });
    }
    if (this.page.url().includes(this.config.siteListUrlIncludes)) {
      const cards = this.page.locator(this.config.selectors.siteCardSelector);
      const deadline = Date.now() + Math.min(this.config.timeouts.actionMs, 10000);
      while (Date.now() < deadline && !(await cards.count().catch(() => 0))) {
        await this.page.waitForTimeout(250);
      }
      if (!(await cards.count().catch(() => 0))) {
        await automaticLogin(this.page, this.page.context(), this.config);
        await this.page.goto(authConfig(this.config).adminUrl, { waitUntil: "domcontentloaded" });
      }
    }
    if (await isLoginPage(this.page)) {
      throw new Error("登录状态失效，自动登录未能恢复，请检查外部账号配置或运行 npm run auth");
    }
    if (this.page.url().includes(this.config.siteListUrlIncludes)) {
      await this.enterTargetSite();
    }
    if (!this.page.url().includes("/phoenix/pagebuilder")) {
      throw new Error(
        `未进入领动编辑器，当前地址为 ${this.page.url()}。请检查 siteName、语言和站点权限`,
      );
    }
    await this.waitForCanvasReady();
    await this.page.waitForTimeout(this.config.ai?.fullPageRegression?.editorStabilizeMs ?? 5000);
  }

  async enterTargetSite() {
    const cards = this.page.locator(this.config.selectors.siteCardSelector);
    let card = null;
    const cardDeadline = Date.now() + this.config.timeouts.blockRenderMs;
    const sitePattern = new RegExp(`^\\s*${escapeRegex(this.config.siteName)}\\s*$`);
    while (Date.now() < cardDeadline) {
      const cardCount = await cards.count().catch(() => 0);
      for (let index = 0; index < cardCount; index += 1) {
        const candidate = cards.nth(index);
        if (!(await candidate.isVisible().catch(() => false))) continue;
        if (await candidate.getByText(sitePattern).first().isVisible().catch(() => false)) {
          card = candidate;
          break;
        }
      }
      if (card) break;
      await this.page.waitForTimeout(250);
    }
    if (!card || !(await card.isVisible().catch(() => false))) {
      throw new Error(`站点列表中未找到 ${this.config.siteName}`);
    }

    const language = card
      .locator(this.config.selectors.siteLanguageSelector)
      .filter({ hasText: new RegExp(`^\\s*${escapeRegex(this.config.siteLanguage)}\\s*$`) })
      .first();
    if (await language.isVisible().catch(() => false)) {
      const selected = await language.evaluate(element => {
        const className = typeof element.className === "string" ? element.className : element.getAttribute("class") || "";
        return className.split(/\s+/).includes("on") || element.getAttribute("aria-selected") === "true";
      }).catch(() => false);
      if (!selected) await language.click();
    }

    const discoveredPublicBaseUrl = await discoverPublicBaseUrl(card);
    if (discoveredPublicBaseUrl) {
      this.config.publicBaseUrl = discoveredPublicBaseUrl;
    }

    const edit = card.locator(this.config.selectors.editSiteSelector).first();
    if (!(await edit.isVisible().catch(() => false))) {
      throw new Error(`${this.config.siteName} 站点卡片中未找到“编辑网站”`);
    }

    const context = this.page.context();
    const knownPages = new Set(context.pages());
    const navigatedPages = new Set();
    const listeners = [...knownPages].map(candidate => {
      const listener = frame => { if (frame === candidate.mainFrame()) navigatedPages.add(candidate); };
      candidate.on('framenavigated', listener);
      return [candidate, listener];
    });
    await edit.click();
    const deadline = Date.now() + this.config.timeouts.blockRenderMs;
    let editorPage = null;
    try { while (Date.now() < deadline) {
      // Clicking “编辑网站” may open transient promotional/support pages in
      // addition to the editor. Never bind to the first arbitrary popup;
      // select only a live page that has actually reached pagebuilder.
      editorPage = enteredEditorPage(context.pages(), { knownPages, currentPage: this.page, navigatedPages });
      if (editorPage) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    } } finally { for (const [candidate, listener] of listeners) candidate.off('framenavigated', listener); }
    if (!editorPage) throw new Error('点击编辑网站后未进入本次编辑器，拒绝复用其他旧编辑器标签页');
    if (editorPage) {
      this.page = editorPage;
      this.page.setDefaultTimeout(this.config.timeouts.actionMs);
      this.page.setDefaultNavigationTimeout(
        this.config.timeouts.blockRenderMs,
      );
      await this.page.waitForLoadState("domcontentloaded").catch(() => {});
    }
    await this.page.waitForTimeout(1000);
  }

  async openPageMenu() {
    await this.dismissBlockingDialogs();
    const menuRoot = this.page.locator("#backstage_select_pages").first();
    if (await menuRoot.evaluate((element) =>
      element.classList.contains("on") ||
      [...element.querySelectorAll(".backstage-topToolbar-menusubUl")].some((candidate) => {
        const style = getComputedStyle(candidate);
        const rect = candidate.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      }),
    ).catch(() => false)) return;
    const candidates = [];
    for (const scope of this.contexts()) {
      candidates.push(
        ...textLocators(scope, this.config.selectors.pageMenuTexts),
      );
    }
    const menu = await firstVisible(candidates);
    if (!menu) {
      throw new Error("未找到“页面:”下拉菜单，请运行 probe 校准 pageMenuTexts");
    }
    const trigger = await firstVisible([
      menu.locator("xpath=..").locator("a"),
      menu.locator("xpath=following::a[1]"),
    ]);
    await (trigger ?? menu).click();
  }

  async openCustomPageList() {
    if (this.insertionPending) throw new Error('整页仍在插入，禁止切换页面');
    let lastError;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await this.openPageMenu();
        const menu = this.page.locator("#backstage_select_pages").first();
        const customTab = await waitFirstVisible(
          [menu.getByText("自定义页面", { exact: true })],
          this.config.timeouts.actionMs,
        );
        if (!customTab) throw new Error("未找到“自定义页面”标签");
        await customTab.click({ timeout: this.config.timeouts.actionMs });
        const search = await firstVisible([menu.locator('input:visible')]);
        if (search && await search.inputValue()) {
          await search.fill(''); await search.press('Enter').catch(() => {});
          await this.page.waitForTimeout(300);
        }
        return menu;
      } catch (error) {
        lastError = error;
        if (attempt === 2) break;
        if (!await this.canReloadSafely()) throw lastError;
        await this.page.reload({ waitUntil: "domcontentloaded" });
        await this.page.waitForTimeout(1200);
      }
    }
    throw new Error(`打开“自定义页面”列表失败（已重试一次）：${lastError?.message ?? "未知错误"}`);
  }

  async dismissBlockingDialogs() {
    const successDialog = this.page.locator("#backstage-dialog-backupTip");
    const close = await firstVisible([
      successDialog.getByText(/^关闭$/).first(),
      successDialog.locator(".backstage-dialog-close, .backstage-dialog-close-new").first(),
      this.page.locator("#onlineDialog .backstage-dialog-close").first(),
      this.page.locator(".layui-layer:visible .layui-layer-close").first(),
    ]);
    if (close) {
      await close.click({ force: true }).catch(() => {});
      await this.page.waitForTimeout(300);
    }
  }

  async openCustomPage(name) {
    if (this.insertionPending) throw new Error('整页仍在插入，禁止切换页面');
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await this.openCustomPageList();
        const visiblePageLink = async (scope = this.page) => {
          const links = scope.locator(`a.name[title="${escapeCssAttributeValue(name)}"]`);
          const count = await links.count().catch(() => 0);
          for (let index = 0; index < count; index += 1) {
            const link = links.nth(index);
            if (await link.isVisible().catch(() => false) && (await link.getAttribute("title").catch(() => name)) === name) return link;
          }
          return null;
        };
        let target = await visiblePageLink();
        if (!target) {
          const pageMenu = this.page.locator("#backstage_select_pages").first();
          const search = await firstVisible([
            pageMenu.locator("input:visible"),
            pageMenu.getByPlaceholder(/搜索/u),
          ]);
          if (search) {
            await search.fill(name);
            await search.press("Enter").catch(() => {});
            await this.page.waitForTimeout(900);
            target = await visiblePageLink(pageMenu);
          }
        }
        if (!target) throw new Error(`自定义页面列表中未找到 ${name}`);
        if (await this.page.locator(`a.name[title="${escapeCssAttributeValue(name)}"]:visible`).count() !== 1) throw new Error('页面名称匹配不唯一，拒绝切换');
        const identity = await this.pageLinkIdentity(target);
        this.expectedPageIdentity = identity;
        await target.click({ force: true });
        await this.page.keyboard.press("Escape");
        await this.waitForPageLoaded(name, identity);
        await this.dismissPageMenu();
        return identity;
      } catch (error) {
        lastError = error;
        await this.dismissBlockingDialogs().catch(() => {});
        if (attempt === 3) break;
        // A page-create or AI handoff can leave the top selector on the
        // previous page even after its loading mask disappears. Re-enter the
        // 3.0 shell before trying the selection again instead of treating a
        // stale toolbar label as a permanent failure.
        if (attempt === 1) continue; // Reselect once before considering a reload.
        if (!await this.canReloadSafely()) break;
        await this.page.reload({ waitUntil: "domcontentloaded", timeout: this.config.timeouts.blockRenderMs }).catch(() => {});
        await this.page.waitForTimeout(1200);
      }
    }
    throw new Error(`自定义页面 ${name} 切换失败（已重试两次）：${lastError?.message ?? "未知错误"}`);
  }

  async openSystemPage(name) {
    let lastError;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await this.openPageMenu();
        const menu = this.page.locator("#backstage_select_pages").first();
        const tab = menu.getByText("系统页面", { exact: true }).first();
        await tab.waitFor({ state: "visible", timeout: this.config.timeouts.actionMs });
        await tab.click();
        const option = menu.locator("a.name").filter({ hasText: new RegExp(`^\\s*${escapeRegex(name)}\\s*$`) }).first();
        await option.waitFor({ state: "visible", timeout: this.config.timeouts.actionMs });
        if ((await option.getAttribute("title")) !== name) {
          throw new Error(`系统页选择不明确：预期 ${name}`);
        }
        const identity = await this.pageLinkIdentity(option);
        this.expectedPageIdentity = identity;
        await option.click();
        await this.waitForPageLoaded(name, identity);
        await this.dismissPageMenu();
        const current = await menu.locator("a.backstage-topToolbar-menuIcon").first().innerText();
        if (!current.includes(name)) throw new Error(`系统页切换后顶部页面名不匹配：${current}`);
        return;
      } catch (error) {
        lastError = error;
        const requestError = this.page.getByText("请求出错", { exact: true }).first();
        if (await requestError.isVisible().catch(() => false)) {
          await this.page.getByText("确定", { exact: true }).last().click({ force: true }).catch(() => {});
        }
        if (attempt === 2) break;
        await this.page.reload({ waitUntil: "domcontentloaded", timeout: Math.min(this.config.timeouts.blockRenderMs, 15000) }).catch(() => {});
        await this.page.waitForTimeout(1200);
      }
    }
    throw new Error(`系统页 ${name} 切换失败（已重试一次）：${lastError?.message ?? "未知错误"}`);
  }

  async dismissPageMenu() {
    const menu = this.page.locator("#backstage_select_pages").first();
    if (!(await menu.count().catch(() => 0))) {
      return;
    }
    const isOpen = await menu
      .evaluate(
        (element) =>
          element.classList.contains("on") ||
          [...element.querySelectorAll(".backstage-topToolbar-menusubUl")].some(
            (candidate) => {
              const style = getComputedStyle(candidate);
              const rect = candidate.getBoundingClientRect();
              return (
                style.display !== "none" &&
                style.visibility !== "hidden" &&
                rect.width > 0 &&
                rect.height > 0
              );
            },
          ),
      )
      .catch(() => false);
    if (!isOpen) {
      return;
    }
    const viewport = await this.page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    const x = Math.max(650, viewport.width - 100);
    const y = Math.min(100, Math.max(60, viewport.height - 100));
    await this.page.mouse.click(x, y);
    await this.page.mouse.move(
      Math.max(650, viewport.width - 50),
      Math.max(100, viewport.height - 50),
    );
    const deadline = Date.now() + this.config.timeouts.actionMs;
    while (Date.now() < deadline) {
      const stillOpen = await menu
        .evaluate((element) => element.classList.contains("on"))
        .catch(() => false);
      if (!stillOpen) {
        return;
      }
      await this.page.waitForTimeout(100);
    }
    throw new Error("页面切换后“页面”下拉层未关闭");
  }

  async createCustomPage(descriptor, { onCreated = async () => {} } = {}) {
    await this.openCustomPageList();
    const newPage = await firstVisible(
      textLocators(this.page, this.config.selectors.newPageTexts),
    );
    if (!newPage) {
      throw new Error("未找到“新建页面”按钮");
    }
    await newPage.click();

    const editor3Label = await waitFirstVisible(
      textLocators(this.page, this.config.selectors.editor3CardTexts),
      this.config.timeouts.actionMs,
    );
    if (!editor3Label) {
      throw new Error("新建页面时未找到“网页编辑器3.0”选项");
    }
    const editor3Card = editor3Label.locator(
      "xpath=ancestor::*[(self::div or self::li) and .//*[normalize-space()='创建页面']][1]",
    );
    const editor3Create = await firstVisible(
      [
        ...textLocators(editor3Card, this.config.selectors.editorCreateTexts),
        editor3Label.locator("xpath=ancestor-or-self::button[contains(@class,'editor-page-create')]").first(),
        this.page.locator("button.editor-page-create").filter({ hasText: /网页编辑器3\.0/ }).first(),
      ],
    );
    if (!editor3Create) {
      throw new Error("网页编辑器3.0卡片中未找到“创建页面”按钮");
    }
    await editor3Create.click();

    let blankPage = null;
    const blankDeadline = Date.now() + this.config.timeouts.actionMs;
    while (Date.now() < blankDeadline) {
      await assertPageCapacityAvailable(this.page);
      blankPage = await firstVisible(textLocators(this.page, this.config.selectors.blankPageTexts));
      if (blankPage) break;
      await this.page.waitForTimeout(200);
    }
    if (!blankPage) {
      throw new Error("3.0 页面模板中未找到“添加空白页”");
    }
    await blankPage.click();
    const chooseTemplate = await firstVisible(
      textLocators(this.page, this.config.selectors.templateConfirmTexts),
    );
    if (!chooseTemplate) {
      throw new Error("选中空白页后未找到“选取”按钮");
    }
    await chooseTemplate.click();

    const pageSettings = await waitFirstVisible(
      textLocators(this.page, this.config.selectors.pageSettingsTexts),
      this.config.timeouts.actionMs,
    );
    if (!pageSettings) {
      throw new Error("选取空白页后未出现“页面设置”弹窗");
    }
    const dialog = await this.pageSettingsDialog();
    await this.fillPageSettings(dialog, descriptor);
    const receipt = await this.submitPageSettings(dialog, descriptor);
    descriptor.creation_receipt = receipt;
    descriptor.creation_status = 'created';
    descriptor.target_identity = { name: descriptor.name, path: descriptor.path, id: receipt.id };
    await onCreated(receipt); // Durable before waiting for the UI handoff.
    try {
      await this.waitForPageLoaded(descriptor.name, descriptor.target_identity);
    } catch (error) {
      descriptor.switch_attempts = (descriptor.switch_attempts || 0) + 1;
      descriptor.failure_step = 'page-switch';
      await onCreated(receipt);
      const identity = await this.openCustomPage(descriptor.name);
      if (receipt.id && identity.id !== receipt.id || pagePath(identity.path) !== pagePath(descriptor.path)) throw error;
      descriptor.target_identity = identity;
    }
    descriptor.failure_step = '';
    await onCreated(receipt);
    return receipt;
  }

  async pageSettingsDialog() {
    if (await this.page.locator('#backstage-dialog-managePages:visible').count() > 1) throw new Error('页面设置弹窗匹配不唯一');
    const dialog = await firstVisible([this.page.locator('#backstage-dialog-managePages:visible'),
      this.page.locator('.backstage-dialog:visible').filter({ has: this.page.getByText('页面设置', { exact: true }) })]);
    if (!dialog || await dialog.locator('#pageTitle, input[name="page.pageTitle"]').count() !== 1 ||
      await dialog.locator('#pageUrl, input[name="page.pageUrl"]').count() !== 1) throw new Error('页面设置弹窗定位不明确，禁止使用整页输入框');
    return dialog;
  }

  async fillPageSettings(dialog, descriptor) {
    await dialog.locator('#pageTitle, input[name="page.pageTitle"]').fill(descriptor.name);
    await dialog.locator('#pageUrl, input[name="page.pageUrl"]').fill(descriptor.path);
  }

  async submitPageSettings(dialog, descriptor) {
    const name = await dialog.locator('#pageTitle, input[name="page.pageTitle"]').inputValue();
    const pathValue = await dialog.locator('#pageUrl, input[name="page.pageUrl"]').inputValue();
    if (descriptor && (name !== descriptor.name || pagePath(pathValue) !== pagePath(descriptor.path))) throw new Error('页面创建失败：提交前名称或路径回读不一致');
    const confirm = await firstVisible([dialog.locator('.page_function_setting_submit:visible'),
      dialog.getByRole('button', { name: '确定', exact: true })]);
    if (!confirm) throw new Error('页面设置弹窗中未找到确定按钮');
    const responsePromise = this.page.waitForResponse(response => response.request().method() === 'POST' &&
      response.url().includes(this.config.selectors.pageCreateResponseUrlIncludes), { timeout: this.config.timeouts.actionMs }).catch(() => null);
    await confirm.click();
    const response = await responsePromise;
    if (!response) throw new Error('页面创建结果待确认：未收到创建回执，禁止再次提交');
    const submitted = pageCreationRequest(response.request().postData() || '');
    if (submitted.name !== name || pagePath(submitted.path) !== pagePath(pathValue)) throw new Error('页面创建失败：实际创建请求名称或路径不匹配');
    const result = pageCreationResult(await response.text(), response.ok(), name);
    const receipt = { ...result, name, path: pathValue, http_status: response.status(), received_at: new Date().toISOString(), request_confirmed: true };
    this.expectedPageIdentity = { name, path: pathValue, id: result.id };
    return receipt;
  }

  async pageLinkIdentity(link) {
    return link.evaluate(element => ({ name: element.getAttribute('title') || '',
      id: (element.getAttribute('data-href') || '').match(/\/pagebuilder\/([A-Za-z0-9_-]+)(?:[/?]|$)/)?.[1] || '',
      path: (() => { try { return new URL(element.getAttribute('pageurl'), location.href).pathname; } catch { return ''; } })() }));
  }

  async currentPageIdentity() {
    const name = (await this.page.locator('#backstage_select_pages a.backstage-topToolbar-menuIcon').first().innerText().catch(() => '')).trim();
    const ids = new Set();
    for (const frame of this.canvasContexts()) {
      const values = await frame.locator('body script').evaluateAll(nodes => nodes.flatMap(node =>
        [...(node.textContent || '').matchAll(/\bpageId\s*[:=]\s*["']([A-Za-z0-9_-]+)["']/g)].map(match => match[1]))).catch(() => []);
      values.forEach(id => ids.add(id));
    }
    return { name, id: ids.size === 1 ? [...ids][0] : '', path: '' };
  }

  async canReloadSafely() {
    if (this.insertionPending || this.unsavedChanges) return false;
    return await this.page.locator('.loadingMask2:visible, #backstage-dialog-managePages:visible, iframe[src*="blockEditorUI"]:visible').count().catch(() => 1) === 0;
  }

  async waitForPageLoaded(expectedName, expected = { name: expectedName }) {
    const deadline = Date.now() + this.config.timeouts.blockRenderMs;
    let lastOverlayVisible = false;
    let lastCurrentName = "";
    let stableSince = 0, stableId = '';
    while (Date.now() < deadline) {
      const overlayVisible = await this.page
        .locator(".loadingMask2")
        .isVisible()
        .catch(() => false);
      // The page selector contains an inline script with the page-switching
      // implementation. Reading the whole selector's text therefore makes a
      // stale page name appear to match (the script text includes the old
      // page name). Read only the visible top-toolbar page label first.
      const currentName = await this.page
        .locator("#backstage_select_pages a.backstage-topToolbar-menuIcon")
        .first()
        .innerText()
        .catch(async () => this.page
          .locator("#backstage_select_pages")
          .evaluate((element) => {
            const clone = element.cloneNode(true);
            clone
              .querySelectorAll(".backstage-topToolbar-menusub, script")
              .forEach((menu) => menu.remove());
            return clone.textContent ?? "";
          })
          .catch(() => ""));
      lastOverlayVisible = overlayVisible;
      lastCurrentName = currentName.trim();
      const identity = await this.currentPageIdentity();
      if (!overlayVisible && comparePageIdentity(expected, identity).matched) {
        if (stableId !== identity.id) { stableSince = Date.now(); stableId = identity.id; }
        if (Date.now() - stableSince >= (this.config.ai?.pageSwitchStableMs ?? 3000)) {
          this.expectedPageIdentity = { ...expected, id: identity.id };
          return this.waitForCanvasReady();
        }
      } else {
        stableSince = 0; stableId = '';
      }
      await this.page.waitForTimeout(200);
    }
    throw new Error(
      `页面 ${expectedName} 切换超时：遮罩=${lastOverlayVisible ? "显示" : "已消失"}，顶部页面名=${JSON.stringify(lastCurrentName)}`,
    );
  }

  async waitForCanvasReady() {
    const deadline = Date.now() + this.config.timeouts.blockRenderMs;
    while (Date.now() < deadline) {
      for (const frame of this.canvasContexts()) {
        const contentAdd = frame
          .locator(
            "#backstage-bodyArea a.backstage-creatmodules-addbtn",
          )
          .first();
        if (await contentAdd.isVisible().catch(() => false)) {
          return contentAdd;
        }
      }
      await this.page.waitForTimeout(200);
    }
    throw new Error("页面画布加载超时：内容区加号未出现");
  }

  async customPageExists(name) {
    await this.openCustomPageList();
    const exists = Boolean(
      await firstVisible([this.page.getByText(name, { exact: true })]),
    );
    await this.page.keyboard.press("Escape");
    await this.dismissPageMenu();
    return exists;
  }

  async deleteCustomPage(name, { apply = false } = {}) {
    await this.openCustomPageList();
    const pageLink = this.page.locator(`a.name[title="${escapeCssAttributeValue(name)}"]`).first();
    await pageLink.waitFor({ state: "visible", timeout: this.config.timeouts.actionMs });
    const row = pageLink.locator("xpath=ancestor::li[contains(@class,'backstage-topToolbar-list')][1]");
    const home = row.locator(".icon-home");
    if (await home.count()) throw new Error(`拒绝删除首页 ${name}`);
    const deleteButton = row.locator(".page_function_delete").first();
    if (!(await deleteButton.count())) throw new Error(`页面 ${name} 未找到删除按钮`);
    const result = { name, pagePath: await pageLink.getAttribute("pageurl"), applied: false };
    if (!apply) {
      await this.page.keyboard.press("Escape");
      await this.dismissPageMenu();
      return result;
    }
    // 页面列表中的删除图标默认只在行悬停时显示。
    await row.hover({ force: true }).catch(() => {});
    await deleteButton.click({ force: true });
    const confirm = await firstVisible([
      this.page.getByText(/^确定$/, { exact: true }),
      this.page.getByText(/^删除$/, { exact: true }),
      this.page.locator(".layui-layer-btn0:visible").last(),
    ]);
    if (!confirm) throw new Error(`删除页面 ${name} 后未找到确认按钮`);
    await confirm.click({ force: true });
    await waitFirstVisible([pageLink], 1000).catch(() => {});
    const remaining = await pageLink.count();
    if (remaining > 0 && await pageLink.isVisible().catch(() => false)) {
      throw new Error(`页面 ${name} 删除后仍出现在页面列表`);
    }
    result.applied = true;
    await this.page.keyboard.press("Escape").catch(() => {});
    await this.dismissPageMenu();
    return result;
  }

  aiBlockWrappers(frame) {
    return frame.locator(".block-container[class*='block-settingId-ai-copilot'], div.siteblocks-setting-wrap, .ai-generated-block").filter({
      has: frame.locator(".ai-generated-block, section[class*='block-settingId-ai-copilot'], .block-settingId-ai-copilot"),
    });
  }

  async findAiBlockWrappers({ marker = "" } = {}) {
    const found = [];
    const seenIds = new Set();
    const frames = [this.page, ...this.page.frames()];
    for (const frame of frames) {
      const wrappers = this.aiBlockWrappers(frame);
      const count = await wrappers.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const wrapper = wrappers.nth(index);
        if (marker && !(await wrapper.innerText().catch(() => "")).includes(marker)) continue;
        const id = await wrapper.getAttribute("id").catch(() => null);
        if (id && seenIds.has(id)) continue;
        if (id) seenIds.add(id);
        found.push({ frame, wrapper });
      }
    }
    return found;
  }

  async describeAiBlockWrappers({ marker = "" } = {}) {
    const matches = await this.findAiBlockWrappers({ marker });
    const described = [];
    for (const match of matches) {
      const className = await match.wrapper.getAttribute("class").catch(() => "") || "";
      described.push({
        ...match,
        identity: {
          id: await match.wrapper.getAttribute("id").catch(() => "") || "",
          pageId: await match.wrapper.getAttribute("data-px2-page-id").catch(() => "") || "",
          settingId: className.match(/block-settingId-([^\s]+)/)?.[1] || "",
          className,
          text: (await match.wrapper.innerText().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 500),
        },
      });
    }
    return described;
  }

  async deleteAiBlock({ marker = "", identity = null, apply = false } = {}) {
    let matches = identity
      ? (await this.describeAiBlockWrappers({ marker })).filter((item) => {
        if (identity.id) return item.identity.id === identity.id;
        if (identity.pageId) return item.identity.pageId === identity.pageId;
        return identity.settingId && identity.text &&
          item.identity.settingId === identity.settingId && item.identity.text === identity.text;
      })
      : await this.findAiBlockWrappers({ marker });
    if (matches.length === 0) throw new Error(`未找到待删除的 AI 区块${marker ? `：${marker}` : ""}`);
    if (matches.length > 1) throw new Error(`匹配到 ${matches.length} 个 AI 区块，拒绝不确定删除`);
    const { frame, wrapper } = matches[0];
    const id = await wrapper.getAttribute("id");
    const result = { id, marker, applied: false };
    if (!apply) return result;
    await wrapper.hover({ force: true });
    const remove = wrapper.locator(".ai-block-delete-btn.backstage-container-delete").first();
    await remove.waitFor({ state: "visible", timeout: this.config.timeouts.actionMs });
    await remove.click({ force: true });
    // Some system-detail builds remove the block immediately and never show
    // a confirmation dialog. Wait briefly for that observable result before
    // looking for a confirm control.
    const goneAfterClick = Date.now() + Math.min(1500, this.config.timeouts.actionMs);
    while (Date.now() < goneAfterClick && await wrapper.count().catch(() => 0)) {
      await this.page.waitForTimeout(100);
    }
    if (!(await wrapper.count().catch(() => 0))) {
      result.applied = true;
      return result;
    }
    const confirmCandidates = [];
    for (const scope of this.contexts()) {
      confirmCandidates.push(
        scope.getByText(/^确定$/, { exact: true }),
        scope.getByText(/^删除$/, { exact: true }),
        scope.getByRole("button", { name: /^(确定|删除|确认)$/ }).last(),
        scope.locator(".layui-layer-btn0:visible").last(),
        scope.locator(".el-message-box__btns button:visible, .el-dialog__footer button:visible").filter({ hasText: /确定|删除|确认/ }).last(),
      );
    }
    const confirm = await firstVisible(confirmCandidates);
    if (!confirm) throw new Error("删除 AI 区块后未找到确认按钮，且区块未立即消失");
    await confirm.click({ force: true });
    const gone = Date.now() + this.config.timeouts.actionMs;
    while (Date.now() < gone) {
      if (!(await wrapper.count().catch(() => 0))) {
        result.applied = true;
        return result;
      }
      await this.page.waitForTimeout(250);
    }
    throw new Error(`AI 区块 ${id || marker || "未命名"} 删除后仍存在`);
  }

  async findBlockSearchInput() {
    const candidates = [];
    for (const scope of this.contexts()) {
      candidates.push(
        ...placeholderLocators(
          scope,
          this.config.selectors.blockSearchPlaceholders,
        ),
      );
    }
    return firstVisible(candidates);
  }

  async resetTaggedBlockSearch() {
    const closeCandidates = [];
    for (const scope of this.contexts()) {
      closeCandidates.push(
        scope.locator(
          ".addmodules_searchWrap_tagItem .block-iconbaseline-close",
        ),
      );
    }
    const close = await firstVisible(closeCandidates);
    if (!close) {
      return null;
    }
    await close.evaluate((element) => element.click());
    return waitFirstVisible(
      this.contexts().flatMap((scope) =>
        placeholderLocators(
          scope,
          this.config.selectors.blockSearchPlaceholders,
        ),
      ),
      this.config.timeouts.actionMs,
    );
  }

  async blockPanelFullyExpanded(panel) {
    return panel
      .evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return (
          element.classList.contains("on") &&
          rect.width >= 400 &&
          rect.left >= -1 &&
          rect.right <= window.innerWidth + 1
        );
      })
      .catch(() => false);
  }

  async closeBlockPanelIfOpen() {
    const panel = this.page
      .locator(".backstage-addmodules-chooseWrapper-new")
      .first();
    if ((await panel.count().catch(() => 0)) === 0) {
      return;
    }
    const needsClosing = await panel
      .evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return element.classList.contains("on") || rect.right > 0;
      })
      .catch(() => false);
    if (!needsClosing) {
      return;
    }
    const close = panel
      .locator("i.block-iconbaseline-close")
      .first();
    if ((await close.count().catch(() => 0)) === 0) {
      throw new Error("区块侧边栏已展开但未找到关闭按钮");
    }
    await close.evaluate((element) =>
      (element.closest("a,button") ?? element).click(),
    );
    const deadline = Date.now() + this.config.timeouts.actionMs;
    while (Date.now() < deadline) {
      const closed = await panel
        .evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return !element.classList.contains("on") && rect.right <= 1;
        })
        .catch(() => true);
      if (closed) {
        return;
      }
      await this.page.waitForTimeout(100);
    }
    throw new Error("区块侧边栏关闭超时");
  }

  async openContentBlockPanel() {
    const panel = this.page
      .locator(".backstage-addmodules-chooseWrapper-new")
      .first();
    if (!(await this.blockPanelFullyExpanded(panel))) {
      const candidates = [];
      for (const scope of this.contexts()) {
        candidates.push(
          ...textLocators(scope, this.config.selectors.contentAddTexts ?? []),
        );
        for (const selector of this.config.selectors.contentAddSelectors) {
          const locator = scope.locator(selector);
          if (selector === "a.backstage-creatmodules-addbtn") {
            candidates.push(
              locator.filter({ hasText: /^添加区块到内容区$/ }),
            );
          } else {
            candidates.push(locator);
          }
        }
      }
      const addControl = await firstVisible(candidates);
      if (!addControl) {
        throw new Error(
          "未找到“添加区块到内容区”的加号，请运行 probe 校准 contentAddSelectors",
        );
      }
      // The editor draws a parent-page overlay above the iframe plus button.
      // Hover exposes the intended control; a native click bypasses only the
      // parent overlay while preserving the editor's own click handler.
      await addControl.hover({ force: true }).catch(() => {});
      await this.page.waitForTimeout(200);
      await addControl.evaluate((element) => element.click());
    }

    const deadline = Date.now() + this.config.timeouts.actionMs;
    while (Date.now() < deadline) {
      if (await this.blockPanelFullyExpanded(panel)) {
        break;
      }
      await this.page.waitForTimeout(100);
    }
    if (!(await this.blockPanelFullyExpanded(panel))) {
      throw new Error("点击内容区加号后，区块侧边栏未完全展开到屏幕内");
    }

    await this.resetTaggedBlockSearch();
    const search = await firstVisible(
      placeholderLocators(
        panel,
        this.config.selectors.blockSearchPlaceholders,
      ),
    );
    if (
      !search ||
      !(await isInViewport(search, { fully: true })) ||
      !(await search.isEditable().catch(() => false))
    ) {
      throw new Error("区块侧边栏已展开，但搜索框不可见或不可编辑");
    }
    return search;
  }

  async locateExactBlockResult(blockId) {
    const directCards = [];
    const escapedId = escapeCssAttributeValue(blockId);
    for (const scope of this.contexts()) {
      const locator = scope.locator(
        `.btn.add[appid="${escapedId}"], [data-action="add"][data-block-id="${escapedId}"]`,
      );
      const count = await locator.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const candidate = locator.nth(index);
        const visibleCard = await candidate
          .evaluate((element) => {
            const card = element.closest("li") ?? element.parentElement;
            if (!card) {
              return false;
            }
            const rect = card.getBoundingClientRect();
            const style = getComputedStyle(card);
            return (
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              rect.width > 0 &&
              rect.height > 0 &&
              rect.right > 0 &&
              rect.left < window.innerWidth &&
              rect.bottom > 0 &&
              rect.top < window.innerHeight
            );
          })
          .catch(() => false);
        if (visibleCard) {
          directCards.push({
            card: candidate.locator("xpath=ancestor::li[1]"),
            directAdd: candidate,
          });
        }
      }
    }
    if (directCards.length === 1) {
      const { card, directAdd } = directCards[0];
      await card.hover({ force: true }).catch(() => {});
      const add = await waitFirstVisible(
        [
          card.locator(".btn.preview"),
          directAdd,
          ...textLocators(card, this.config.selectors.addButtonTexts),
        ],
        1200,
      );
      if (add) {
        return { outcome: "found", add };
      }
      const nativeAdd = card.locator(".btn.preview").first();
      if ((await nativeAdd.count().catch(() => 0)) === 1) {
        return { outcome: "found", add: nativeAdd };
      }
      return {
        outcome: "add_failed",
        reason: "找到精确 block_id，但结果卡片中没有可见“添加”按钮",
      };
    }
    if (directCards.length > 1) {
      return {
        outcome: "locator_ambiguous",
        reason: `搜索结果中出现 ${directCards.length} 个 appid=${blockId} 的添加按钮`,
      };
    }

    const exactId = new RegExp(
      `区块\\s*ID\\s*[:：]\\s*${escapeRegex(blockId)}(?:\\D|$)`,
      "i",
    );
    const visibleMatches = [];
    for (const scope of this.contexts()) {
      const locator = scope.getByText(exactId);
      const count = await locator.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const candidate = locator.nth(index);
        if (
          (await candidate.isVisible().catch(() => false)) &&
          (await isInViewport(candidate))
        ) {
          visibleMatches.push(candidate);
        }
      }
    }
    if (visibleMatches.length === 0) {
      return { outcome: "not_found" };
    }
    if (visibleMatches.length > 1) {
      return {
        outcome: "locator_ambiguous",
        reason: `搜索结果中出现 ${visibleMatches.length} 个精确 block_id`,
      };
    }

    const idText = visibleMatches[0];
    const listCard = idText.locator("xpath=ancestor::li[1]");
    const card =
      (await listCard.count().catch(() => 0)) > 0
        ? listCard
        : idText.locator(
            "xpath=ancestor::*[(self::div or self::li) and .//*[normalize-space(.)='添加' or normalize-space(.)='+ 添加']][1]",
          );
    await card.hover({ force: true }).catch(() => {});
    const add = await waitFirstVisible(
      [
        card.locator(".btn.preview"),
        ...textLocators(card, this.config.selectors.addButtonTexts),
      ],
      1200,
    );
    if (!add) {
      const nativeAdd = card.locator(".btn.preview").first();
      if ((await nativeAdd.count().catch(() => 0)) === 1) {
        return { outcome: "found", add: nativeAdd };
      }
      return {
        outcome: "add_failed",
        reason: "找到精确 block_id，但结果卡片中没有可见“添加”按钮",
      };
    }
    return { outcome: "found", add };
  }

  async waitForExactBlockResult(blockId) {
    const deadline =
      Date.now() + (this.config.timeouts.searchResultMs ?? 10000);
    let lastTransientFailure = null;
    while (Date.now() < deadline) {
      const result = await this.locateExactBlockResult(blockId);
      if (result.outcome === "found" || result.outcome === "locator_ambiguous") {
        return result;
      }
      if (result.outcome === "add_failed") {
        lastTransientFailure = result;
        await this.page.waitForTimeout(250);
        continue;
      }
      const panel = this.page
        .locator(".backstage-addmodules-chooseWrapper-new.on")
        .first();
      const explicitEmpty = await firstVisible(
        textLocators(
          panel,
          this.config.selectors.noBlockResultTexts ?? [],
        ),
      );
      if (explicitEmpty && (await isInViewport(explicitEmpty))) {
        return result;
      }
      await this.page.waitForTimeout(250);
    }
    return lastTransientFailure ?? { outcome: "not_found" };
  }

  async searchAndAdd(blockId) {
    const input = await this.openContentBlockPanel();
    await input.fill(blockId);
    await input.press("Enter");

    const result = await this.waitForExactBlockResult(blockId);
    if (result.outcome !== "found") {
      return result;
    }

    await result.add
      .locator("xpath=ancestor::li[1]")
      .hover({ force: true })
      .catch(() => {});
    await this.page.waitForTimeout(150);
    await result.add.evaluate((element) => element.click());
    return this.waitForBlockAudit(blockId);
  }

  async auditBlock(blockId) {
    const templates = this.config.selectors.blockRootTemplates;
    const selectors = templates.map((template) =>
      template.replaceAll("{id}", escapeCssAttributeValue(blockId)),
    );
    const errors = this.config.selectors.renderErrorTexts;
    const loaders = this.config.selectors.loadingSelectors;
    const audits = [];

    for (const frame of this.canvasContexts()) {
      const audit = await frame
        .evaluate(
          ({ id, rootSelectors, errorTexts, loadingSelectors }) => {
            const candidates = new Set();
            for (const selector of rootSelectors) {
              try {
                for (const element of document.querySelectorAll(selector)) {
                  candidates.add(element);
                }
              } catch {
                // A local selector override may be temporarily invalid.
              }
            }
            if (candidates.size === 0) {
              for (const element of document.querySelectorAll("*")) {
                for (const attribute of element.attributes) {
                  if (
                    attribute.value === id &&
                    /(block|module|component|app|(^|-)id$)/i.test(attribute.name)
                  ) {
                    candidates.add(element);
                    break;
                  }
                }
              }
            }

            const visible = [...candidates].filter((element) => {
              const style = getComputedStyle(element);
              const rect = element.getBoundingClientRect();
              return (
                style.display !== "none" &&
                style.visibility !== "hidden" &&
                rect.width > 0 &&
                rect.height > 0
              );
            });
            const roots = visible.filter(
              (candidate) =>
                !visible.some(
                  (other) => other !== candidate && other.contains(candidate),
                ),
            );

            return roots.map((root) => {
              const rect = root.getBoundingClientRect();
              const headingCounts = {};
              for (let level = 1; level <= 6; level += 1) {
                headingCounts[`h${level}`] = root.querySelectorAll(
                  `h${level}`,
                ).length;
              }
              const images = [...root.querySelectorAll("img")].map((image) => ({
                src: image.currentSrc || image.src || "",
                alt: image.getAttribute("alt") ?? "",
                width: image.getBoundingClientRect().width,
                height: image.getBoundingClientRect().height,
              }));
              const matchingAttribute = [...root.attributes].find(
                (attribute) => attribute.value === id,
              );
              const fingerprint = root.id
                ? `#${CSS.escape(root.id)}`
                : matchingAttribute
                  ? `[${CSS.escape(matchingAttribute.name)}="${CSS.escape(id)}"]`
                  : "";
              const text = (root.innerText || "").replace(/\s+/g, " ").trim();
              const loading = loadingSelectors.some((selector) => {
                try {
                  return [...root.querySelectorAll(selector)].some((element) => {
                    const childRect = element.getBoundingClientRect();
                    const style = getComputedStyle(element);
                    return (
                      childRect.width > 0 &&
                      childRect.height > 0 &&
                      style.display !== "none" &&
                      style.visibility !== "hidden"
                    );
                  });
                } catch {
                  return false;
                }
              });
              const errorText = errorTexts.find((error) => text.includes(error));
              return {
                editor_dom_id:
                  root.id ||
                  (matchingAttribute
                    ? `${matchingAttribute.name}=${matchingAttribute.value}`
                    : ""),
                fingerprint,
                visible: true,
                width: rect.width,
                height: rect.height,
                dom_index: [...document.querySelectorAll("*")].indexOf(root),
                visible_text_length: text.length,
                heading_counts: headingCounts,
                image_count: images.length,
                images,
                loading,
                error_text: errorText ?? "",
                has_default_content:
                  text.length > 0 ||
                  images.some(
                    (image) =>
                      image.src && image.width > 0 && image.height > 0,
                  ),
              };
            });
          },
          {
            id: blockId,
            rootSelectors: selectors,
            errorTexts: errors,
            loadingSelectors: loaders,
          },
        )
        .catch(() => []);
      audits.push(...audit.map((item) => ({ ...item, frame_url: frame.url() })));
    }
    return audits;
  }

  async listCanvasBlockIds() {
    const ids = [];
    for (const frame of this.canvasContexts()) {
      const frameIds = await frame.evaluate(() => {
        const found = [];
        for (const element of document.querySelectorAll("*")) {
          for (const attribute of element.attributes) {
            if (
              /(block|module|component)(-|_)?id/i.test(attribute.name) &&
              /^\d+$/.test(attribute.value)
            ) {
              found.push({
                block_id: attribute.value,
                attribute: attribute.name,
                dom_index: [...document.querySelectorAll("*")].indexOf(element),
              });
              break;
            }
          }
        }
        return found;
      });
      ids.push(...frameIds.map((item) => ({ ...item, frame_url: frame.url() })));
    }
    const unique = new Map();
    for (const item of ids) {
      if (!unique.has(item.block_id)) {
        unique.set(item.block_id, item);
      }
    }
    return [...unique.values()].sort((left, right) => left.dom_index - right.dom_index);
  }

  async waitForBlockAudit(blockId) {
    const deadline = Date.now() + this.config.timeouts.blockRenderMs;
    const noSignalMs =
      this.config.timeouts.blockNoSignalMs ??
      this.config.timeouts.blockRenderMs;
    const noSignalDeadline = Date.now() + noSignalMs;
    let lastAudit = [];
    while (Date.now() < deadline) {
      lastAudit = await this.auditBlock(blockId);
      if (
        lastAudit.length === 1 &&
        !lastAudit[0].loading &&
        !lastAudit[0].error_text
      ) {
        if (!lastAudit[0].has_default_content) {
          return {
            outcome: "render_failed",
            reason: "区块根节点存在，但没有可见文本或有效图片",
            audit: lastAudit[0],
          };
        }
        return { outcome: "added", audit: lastAudit[0] };
      }
      if (lastAudit.length > 1) {
        return {
          outcome: "render_failed",
          reason: `页面中检测到 ${lastAudit.length} 个目标 block_id`,
          audit: lastAudit,
        };
      }
      if (lastAudit[0]?.error_text) {
        return {
          outcome: "render_failed",
          reason: `区块出现错误提示：${lastAudit[0].error_text}`,
          audit: lastAudit[0],
        };
      }
      if (lastAudit.length === 0 && Date.now() >= noSignalDeadline) {
        return {
          outcome: "render_failed",
          reason: `添加后 ${Math.round(noSignalMs / 1000)} 秒内没有检测到目标 DOM 或加载信号`,
          audit: [],
        };
      }
      await this.page.waitForTimeout(500);
    }
    return {
      outcome: "render_failed",
      reason:
        lastAudit.length === 0
          ? "添加后 60 秒内未检测到目标 block_id"
          : "区块持续处于加载状态",
      audit: lastAudit,
    };
  }

  async removeBlock(blockId, audit) {
    const fingerprint = Array.isArray(audit)
      ? audit[0]?.fingerprint
      : audit?.fingerprint;
    if (!fingerprint) {
      return (await this.auditBlock(blockId)).length === 0;
    }
    for (const frame of this.canvasContexts()) {
      const root = frame.locator(fingerprint).first();
      if (!(await root.isVisible().catch(() => false))) {
        continue;
      }
      await root.hover();
      const remove = await firstVisible(
        textLocators(root, this.config.selectors.deleteBlockTexts),
      );
      if (!remove) {
        return false;
      }
      await remove.click();
      const confirm = await firstVisible([
        this.page.getByText(/^(确定|删除)$/),
      ]);
      if (confirm) {
        await confirm.click();
      }
      await this.page.waitForTimeout(500);
      return (await this.auditBlock(blockId)).length === 0;
    }
    return false;
  }

  async savePage() {
    if (this.insertionPending) throw new Error('整页仍在插入，禁止保存或发布');
    const save = await firstVisible([
      this.page.locator("#saveLayout"),
      ...textLocators(this.page, this.config.selectors.saveTexts),
    ]);
    if (!save) {
      throw new Error("未找到编辑器“保存”按钮");
    }

    let saveResponse = null;
    const onResponse = (response) => {
      if (
        response.request().method() === "POST" &&
        response.url().includes("/phoenix/pagebuilder/savegridlayout")
      ) {
        saveResponse = response;
      }
    };
    this.page.on("response", onResponse);
    try {
      await save.click();
      const deadline = Date.now() + this.config.timeouts.saveMs;
      while (Date.now() < deadline) {
        if (saveResponse) {
          if (!saveResponse.ok()) {
            throw new Error(
              `右上角保存接口返回 HTTP ${saveResponse.status()}`,
            );
          }
          this.unsavedChanges = false;
          return {
            evidence: "network",
            status: saveResponse.status(),
            url: saveResponse.url(),
          };
        }
        const success = await firstVisible(
          textLocators(this.page, this.config.selectors.saveSuccessTexts),
        );
        if (success) {
          this.unsavedChanges = false;
          return { evidence: "toast" };
        }
        await this.page.waitForTimeout(250);
      }
    } finally {
      this.page.off("response", onResponse);
    }
    throw new Error("点击右上角保存后未检测到成功提示或成功接口响应");
  }

  async publishSite() {
    if (this.insertionPending) throw new Error('整页仍在插入，禁止保存或发布');
    const publish = await firstVisible(
      [
        this.page.locator("#backstage_online"),
        ...textLocators(this.page, this.config.selectors.publishTexts),
      ],
    );
    if (!publish) {
      throw new Error("未找到“发布”按钮");
    }

    // The live 3.0 editor first opens a pre-publish confirmation dialog.  The
    // final publish link is disabled until the confirmation checkbox is
    // checked, so a generic text click on “发布” would only reopen the menu
    // and never start the asynchronous publish job.
    let publishResponse = null;
    const onResponse = (response) => {
      if (
        response.request().method() === "GET" &&
        /\/phoenix\/online\/open(?:\?|$)/i.test(response.url())
      ) {
        publishResponse = response;
      }
    };
    this.page.on("response", onResponse);
    try {
      await publish.click();
      const confirmationDialog = await waitFirstVisible(
        [
          this.page.locator("#onlineDialog"),
          ...textLocators(this.page, this.config.selectors.publishConfirmTexts),
        ],
        this.config.timeouts.actionMs,
      );
      if (confirmationDialog && await this.page.locator("#onlineDialog").isVisible().catch(() => false)) {
        const dialog = this.page.locator("#onlineDialog");
        const checkbox = dialog.locator("#confirmCheck").first();
        if (await checkbox.count().catch(() => 0)) {
          await checkbox.check({ force: true });
        } else {
          const label = dialog.getByText(/^我已确认$/).first();
          if (await label.count().catch(() => 0)) await label.click({ force: true });
        }
        const finalPublish = await firstVisible([
          dialog.locator(".backstage-dialog-submit").filter({ hasText: /^发布$/ }).first(),
          dialog.getByText(/^发布$/).last(),
        ]);
        if (!finalPublish) throw new Error("发布确认弹窗中未找到最终“发布”按钮");
        await finalPublish.click({ force: true });
      } else if (confirmationDialog) {
        await confirmationDialog.click();
      }

      const deadline = Date.now() + this.config.timeouts.publishMs;
      while (Date.now() < deadline) {
        const success = await firstVisible(
          textLocators(this.page, this.config.selectors.publishSuccessTexts),
        );
        if (success) return { evidence: "toast" };
        if (publishResponse) {
          if (!publishResponse.ok()) {
            throw new Error(`发布接口返回 HTTP ${publishResponse.status()}`);
          }
          // The publish endpoint is asynchronous; a successful response means
          // the job was accepted.  The AI runner separately polls the public
          // URL until all five blocks are actually visible.
          return {
            evidence: "network",
            status: publishResponse.status(),
            url: publishResponse.url(),
          };
        }
        await this.page.waitForTimeout(500);
      }
    } finally {
      this.page.off("response", onResponse);
    }
    throw new Error("发布后未检测到成功提示");
  }

  async inspect() {
    const frames = [];
    for (const frame of this.page.frames()) {
      const elements = await frame
        .evaluate(() =>
          [
            ...document.querySelectorAll(
              "input,button,a,[role='button'],[title],[aria-label]",
            ),
          ]
            .slice(0, 800)
            .map((element) => ({
              tag: element.tagName.toLowerCase(),
              type: element.getAttribute("type") ?? "",
              name: element.getAttribute("name") ?? "",
              id: element.id,
              class: element.className?.toString().slice(0, 180) ?? "",
              placeholder: element.getAttribute("placeholder") ?? "",
              title: element.getAttribute("title") ?? "",
              ariaLabel: element.getAttribute("aria-label") ?? "",
              href: element.getAttribute("href") ?? "",
              text: (element.innerText || element.textContent || "")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 180),
              parentText: (element.parentElement?.innerText || "")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 500),
            }))
            .filter(
              (element) =>
                element.placeholder ||
                element.title ||
                element.ariaLabel ||
                element.text,
            ),
        )
        .catch(() => []);
      frames.push({
        name: frame.name(),
        url: frame.url(),
        elementCount: elements.length,
        elements,
      });
    }
    return {
      capturedAt: new Date().toISOString(),
      pageUrl: this.page.url(),
      title: await this.page.title(),
      frames,
    };
  }
}
