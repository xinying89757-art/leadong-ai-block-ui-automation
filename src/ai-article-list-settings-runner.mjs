import { mkdir, writeFile } from "node:fs/promises";
import { AiBlockAutomation } from "./ai-runner.mjs";
import { DetailContentBrowser } from "./ai-detail-content.mjs";
import { MidsceneLocatorFallback, applyMidsceneEvidence, applyMidsceneFailure } from "./midscene-fallback.mjs";
import {
  assertArticleCategoryResult,
  assertArticleCatalogSort,
  assertArticlePageSize,
  assertArticlePagination,
  assertArticleRenderedColorChanged,
  assertArticleSort,
  normalizeArticleCards,
} from "./ai-article-list-observations.mjs";
import {
  articleListSettingsPaths,
  articleListSettingsDescriptor,
  articleListResumeAction,
  assertArticleListSettingsState,
  createArticleListSettingsState,
  readArticleListSettingsJson,
  writeArticleListSettingsJson,
} from "./ai-article-list-settings-state.mjs";

const pause = (page, ms) => page.waitForTimeout(ms);
const norm = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const hexToRgb = (hex) => `rgb(${Number.parseInt(hex.slice(1, 3), 16)}, ${Number.parseInt(hex.slice(3, 5), 16)}, ${Number.parseInt(hex.slice(5, 7), 16)})`;

export class AiArticleListSettingsAutomation {
  constructor(editor, config, runId) {
    this.editor = editor;
    this.config = config;
    this.mode = config.ai.articleListSettingsRegression;
    this.midscene = new MidsceneLocatorFallback(editor.page, {
      enabled: true,
      domFastPathTimeoutMs: 2000,
      maxCallsPerSetting: 1,
      midsceneTimeoutMs: 20000,
    });
    this.runId = runId;
    this.paths = articleListSettingsPaths(config, runId);
    const scoped = {
      ...config,
      ai: {
        ...config.ai,
        runId,
        types: [this.mode.type],
        blocksPerPage: 1,
        pageNamePrefix: this.mode.pageNamePrefix,
        pagePathPrefix: this.mode.pagePathPrefix,
        inputMode: this.mode.inputMode,
        generationMode: this.mode.generationMode,
        promptPolishEnabled: this.mode.promptPolishEnabled,
        applyIntervalMs: this.mode.applyIntervalMs,
        publishInitialWaitMs: this.mode.publishInitialWaitMs,
        publishPollIntervalMs: this.mode.publishPollIntervalMs,
        publishTimeoutMs: this.mode.publishTimeoutMs,
        prompts: { ...config.ai.prompts, [this.mode.type]: this.mode.prompt },
      },
    };
    this.base = new AiBlockAutomation(editor, scoped, {
      load: async () => readArticleListSettingsJson(this.paths.state),
      save: async (value) => writeArticleListSettingsJson(this.paths.state, value),
    });
    this.base.afterFinalApply = async ({ record }) => this.runSettings(record);
  }

  record() { return this.state.type; }
  async persist() { await writeArticleListSettingsJson(this.paths.state, this.state); }

  async initialize({ resume = false } = {}) {
    const old = await readArticleListSettingsJson(this.paths.state);
    if (old) this.state = assertArticleListSettingsState(old, this.config, this.runId);
    else {
      if (resume) throw new Error(`运行 ${this.runId} 没有文章列表状态，无法恢复`);
      this.state = createArticleListSettingsState(this.config, this.runId);
      await this.persist();
    }
    this.base.state = this.state;
    this.base.page = this.state.page;
    const exists = await this.editor.customPageExists(this.state.page.name);
    if (exists) {
      if (!this.state.page.creation_status || this.state.page.creation_status === "pending") throw new Error(`测试页 ${this.state.page.name} 已存在但归属未确认，拒绝覆盖`);
      await this.editor.openCustomPage(this.state.page.name);
    } else {
      if (resume && (this.record().generation_status !== "pending" || this.record().application_attempted)) throw new Error("恢复时找不到已有测试页，拒绝重复生成或插入");
      await this.editor.createCustomPage(this.state.page);
      this.state.page.creation_status = "created";
      this.state.page.created_at = new Date().toISOString();
      await this.persist();
    }
    this.base.page = this.state.page;
    // The run method reconciles an interrupted apply against the live editor
    // canvas before deciding whether that checkpoint is safe to resume.
    return this.state;
  }

  async findPagebuilderArticleBlock() {
    const matches = await this.pagebuilderArticleBlocks();
    if (matches.length !== 1) throw new Error(`文章列表区块唯一匹配失败：${matches.length} 个`);
    return matches[0];
  }

  async pagebuilderArticleBlocks() {
    const matches = [];
    for (const frame of this.editor.page.frames()) {
      if (!/\/phoenix\/pagebuilder(?:\/|\?|$)/.test(frame.url()) || /\/pagebuilder\/layout(?:\?|$)/.test(frame.url())) continue;
      const blocks = frame.locator("[data-block-uuid='ai-articlelist']");
      for (let index = 0; index < await blocks.count().catch(() => 0); index++) {
        const block = blocks.nth(index);
        const box = await block.boundingBox().catch(() => null);
        if (box?.width > 0 && box?.height > 0) matches.push({ frame, block, box });
      }
    }
    return matches;
  }

  async waitForArticleScopeCommit(expectedArticles, label, { expectedPageSize = null, canvasFrame = null } = {}) {
    const expectedTitleCounts = new Map();
    for (const article of expectedArticles) {
      if (!article.title) throw new Error(`${label}：后台文章标题为空，无法核对渲染结果`);
      expectedTitleCounts.set(article.title, (expectedTitleCounts.get(article.title) ?? 0) + 1);
    }
    if (!expectedArticles.length) throw new Error(`${label}：后台文章列表为空，无法核对渲染结果`);
    let lastObserved = null;
    let previousSignature = "";
    let stableObservations = 0;
    try {
      return await this.waitUntil(async () => {
        const matches = canvasFrame
          ? [{ frame: canvasFrame, block: canvasFrame.locator("[data-block-uuid='ai-articlelist']:visible") }]
          : await this.pagebuilderArticleBlocks();
        if (matches.length !== 1 || await matches[0].block.count().catch(() => 0) !== 1) return false;
        const snapshot = await this.readArticleListSnapshot(matches[0].frame, matches[0].block);
        const actualTitles = snapshot.cards.map((article) => article.title);
        lastObserved = {
          total: snapshot.total,
          page_size: snapshot.pageSize,
          titles: actualTitles,
        };
        const expectedVisibleCount = Math.min(expectedArticles.length, snapshot.pageSize);
        const actualTitleCounts = new Map();
        for (const title of actualTitles) actualTitleCounts.set(title, (actualTitleCounts.get(title) ?? 0) + 1);
        const membershipMatches = [...actualTitleCounts].every(([title, count]) => count <= (expectedTitleCounts.get(title) ?? 0));
        const exactWhenAllVisible = snapshot.cards.length === expectedArticles.length
          ? [...expectedTitleCounts].every(([title, count]) => actualTitleCounts.get(title) === count)
          : true;
        if (snapshot.total !== expectedArticles.length || !snapshot.pageSize
          || (expectedPageSize !== null && snapshot.pageSize !== expectedPageSize)
          || actualTitles.length !== expectedVisibleCount || !membershipMatches || !exactWhenAllVisible) {
          stableObservations = 0;
          previousSignature = "";
          return false;
        }
        const signature = JSON.stringify(lastObserved);
        stableObservations = signature === previousSignature ? stableObservations + 1 : 1;
        previousSignature = signature;
        return stableObservations >= 3 ? snapshot : false;
      }, this.config.timeouts.blockRenderMs, label);
    } catch (error) {
      if (canvasFrame) {
        await mkdir(this.paths.root, { recursive: true });
        const canvasState = await canvasFrame.locator("[data-block-uuid='ai-articlelist']").first().evaluate((node) => ({
          total: node.querySelector("input[name='totalRow']")?.value ?? "",
          pageSize: node.querySelector("input[name='pageSize']")?.value ?? "",
          cardText: [...node.querySelectorAll(".article-title")].map((item) => item.textContent?.replace(/\s+/g, " ").trim() ?? ""),
          loading: Boolean(node.querySelector(".loading, .el-loading-mask, [aria-busy='true']")),
        })).catch(() => null);
        const diagnostic = { label, observed: lastObserved, canvas: canvasState, captured_at: new Date().toISOString() };
        await writeFile(`${this.paths.root}/article-scope-refresh-diagnostic.json`, `${JSON.stringify(diagnostic, null, 2)}\n`, "utf8").catch(() => {});
        await this.editor.page.screenshot({ path: `${this.paths.root}/article-scope-refresh-failed.png` }).catch(() => {});
      }
      throw new Error(`${label}：页面数据未稳定到后台预期；最近观察 ${JSON.stringify(lastObserved)}；${error.message}`);
    }
  }

  async recoverGeneratedHistory() {
    const record = this.record();
    const frame = await this.base.openAiDialog();
    const history = frame.locator(this.config.selectors.aiHistoryTriggerSelector).first();
    if (!(await history.isVisible().catch(() => false))) throw new Error("AI 弹窗中未找到生成记录入口，无法恢复已生成文章列表");
    await history.click();
    const cards = frame.locator(this.config.selectors.aiHistoryCardSelector);
    const marker = record.history_marker;
    const matches = await this.waitUntil(async () => {
      const found = [];
      for (let index = 0; index < await cards.count().catch(() => 0); index++) {
        const card = cards.nth(index);
        const text = norm(await card.innerText().catch(() => ""));
        if (text.includes(marker)) found.push({ card, text, id: await card.getAttribute("data-id").catch(() => "") || await card.getAttribute("data-record-id").catch(() => "") });
      }
      return found.length ? found : false;
    }, 15000, "本轮文章列表生成记录");
    if (matches.length !== 1) throw new Error(`文章列表历史记录标记唯一匹配失败：${matches.length} 条`);
    const [{ card, id }] = matches;
    if (/生成失败|失败，点数将自动退还|已自动退还/.test(await card.innerText())) throw new Error("本轮文章列表生成记录明确失败，拒绝应用");
    const insert = card.getByText(/插入|应用模块|添加/).first();
    if (!(await insert.isVisible().catch(() => false))) throw new Error("本轮文章列表历史记录未显示可用的插入操作");
    const before = await this.pagebuilderArticleBlocks();
    if (before.length !== 0) throw new Error(`历史记录插入前页面已有 ${before.length} 个文章列表区块，拒绝重复插入`);
    await insert.click({ force: true });
    const next = await this.waitUntil(async () => {
      const controls = [frame.getByText("应用模块", { exact: true }), frame.locator("button").filter({ hasText: /^应用模块$/ })];
      for (const control of controls) if (await control.first().isVisible().catch(() => false) && await control.first().isEnabled().catch(() => false)) return { mode: "module", control: control.first() };
      const apply = frame.locator(this.config.selectors.aiApplySelector).filter({ hasText: /^应用$/ }).first();
      if (await apply.isVisible().catch(() => false) && await apply.isEnabled().catch(() => false)) return { mode: "final", control: apply };
      return false;
    }, this.config.timeouts.blockRenderMs, "历史文章模块插入");
    if (next.mode === "module") await next.control.click({ force: true });
    const finalApply = frame.locator(this.config.selectors.aiApplySelector).filter({ hasText: /^应用$/ }).first();
    await this.base.waitForAiControlReady(frame, finalApply, "文章列表历史结果应用");
    record.application_source = "history";
    record.generation_record_id = id;
    record.application_attempted = true;
    record.application_recovery = { source: "history", marker, before_count: before.length, started_at: new Date().toISOString() };
    await this.persist();
    await finalApply.click();
    await this.waitUntil(async () => (await this.pagebuilderArticleBlocks()).length === 1, this.config.timeouts.blockRenderMs, "历史文章列表提交到编辑器");
    record.apply_status = "applied";
    record.application_commit_confirmed = true;
    record.application_recovery.completed_at = new Date().toISOString();
    if (!this.state.page.types.includes(record.type)) this.state.page.types.push(record.type);
    this.state.page.saved = false;
    await this.persist();
    await this.base.closeAiResult().catch(() => {});
  }

  async openArticleBlockEditor() {
    const labels = ["文章列表", "选择文章", "文章排序", "加载方式", "每页展示数量", "展示内容", "基础配色"];
    const panelSelectors = ".modules-setting-container .el-drawer.open, .modules-setting-container:visible, .el-drawer.open, .block-setting-container:visible, .block-setting-panel:visible, .backstage-setting-panel:visible, .siteblocks-setting-panel:visible, .right-setting-panel:visible, .backstage-right-panel:visible";
    const findPanel = async () => {
      const matches = [];
      for (const scope of [this.editor.page, ...this.editor.page.frames()]) {
        const panels = scope.locator(panelSelectors);
        for (let index = 0; index < await panels.count().catch(() => 0); index++) {
          const panel = panels.nth(index);
          if (!(await panel.isVisible().catch(() => false))) continue;
          const text = norm(await panel.innerText().catch(() => ""));
          if (/文章列表/.test(text) && ["文章排序", "加载方式", "每页展示数量"].every((label) => text.includes(label))) matches.push({ frame: scope, panel, text });
        }
      }
      // Nested selectors can return both the drawer and its container. Prefer
      // the narrowest visible matching subtree; if two equally narrow panels
      // remain, the identity is ambiguous and we stop safely.
      const shortestText = matches.length ? Math.min(...matches.map((candidate) => candidate.text.length)) : 0;
      const distinct = matches.filter((candidate) => candidate.text.length === shortestText);
      if (distinct.length > 1) throw new Error(`文章列表设置侧栏唯一匹配失败：${distinct.length} 个可见面板`);
      return distinct.length === 1 ? distinct[0] : false;
    };
    const { frame: pagebuilderFrame, block: pagebuilderBlock } = await this.findPagebuilderArticleBlock();
    // The block toolbar is lazy-rendered only while the pointer is over the
    // owning pagebuilder component. Looking for a page-wide visible toolbar
    // before hovering was flaky: after returning from the block editor there
    // is normally no toolbar in the DOM yet. Resolve the unique owner first,
    // reveal its affordance, then scope the toolbar by that owner's stable id
    // (same interaction used by the product-list regression).
    // The floating block toolbar is owned by the outer siteblocks wrapper,
    // not by the inner developer-component that contains the article HTML.
    // Its id is the toolbar's data-id link (e.g. siteblocks-setting-wrap-…).
    const pagebuilderOwner = pagebuilderBlock.locator("xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' siteblocks-setting-wrap ')][1]");
    const ownerId = await pagebuilderOwner.getAttribute("id").catch(() => "");
    if (!ownerId) throw new Error("文章列表区块的 pagebuilder 所属组件缺少稳定 ID，无法安全定位全屏编辑入口");
    const ownerBox = await pagebuilderOwner.boundingBox().catch(() => null);
    if (!ownerBox || ownerBox.width <= 0 || ownerBox.height <= 0) throw new Error("文章列表区块所属组件不可见，无法唤出 toolbar");
    await pagebuilderOwner.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    await pagebuilderOwner.hover({ position: { x: Math.min(40, ownerBox.width / 2), y: Math.min(40, ownerBox.height / 2) }, timeout: 3000 }).catch(async () => {
      // Cross-frame canvases can occasionally reject Locator.hover while the
      // owner is still hit-testable. Move the real pointer to its center once;
      // subsequent lookup remains strict and owner-scoped.
      await this.editor.page.mouse.move(ownerBox.x + Math.min(40, ownerBox.width / 2), ownerBox.y + Math.min(40, ownerBox.height / 2)).catch(() => {});
    });
    const escapedOwnerId = ownerId.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
    const toolbar = pagebuilderFrame.locator(`.ai-block-floating-toolbar .ai-block-fullscreen-edit[data-id="${escapedOwnerId}"]:visible`);
    const toolbarCount = await this.waitUntil(async () => {
      const count = await toolbar.count().catch(() => 0);
      if (count > 1) throw new Error(`文章列表区块所属 toolbar 唯一匹配失败：${count} 个`);
      return count === 1 ? count : false;
    }, 2000, "悬停文章列表区块后显示所属 toolbar").catch(async () => await toolbar.count().catch(() => 0));
    if (toolbarCount !== 1) throw new Error(`文章列表区块的全屏编辑入口唯一匹配失败：${toolbarCount} 个`);
    await toolbar.click({ timeout: 3000 });

    const editorFrame = await this.waitUntil(async () => {
      const matches = [];
      for (const candidate of this.editor.page.frames()) {
        if (!/\/blockEditorUI\//i.test(candidate.url())) continue;
        if (await candidate.getByText("编辑区块", { exact: true }).count().catch(() => 0)) matches.push(candidate);
      }
      if (matches.length > 1) throw new Error(`全屏区块编辑器 frame 唯一匹配失败：${matches.length} 个`);
      return matches.length === 1 ? matches[0] : false;
    }, this.config.timeouts.blockRenderMs, "文章列表全屏编辑器加载");

    const isWithinEditorFrame = (candidate) => {
      let current = candidate;
      while (current) {
        if (current === editorFrame) return true;
        current = current.parentFrame?.() ?? null;
      }
      return false;
    };
    const scanEditorBlocks = async () => {
      const found = [];
      for (const candidate of this.editor.page.frames()) {
        if (!isWithinEditorFrame(candidate)) continue;
        const blocks = candidate.locator("[data-block-uuid='ai-articlelist']");
        for (let index = 0; index < await blocks.count().catch(() => 0); index++) {
          const block = blocks.nth(index);
          if (await block.isVisible().catch(() => false)) found.push({ frame: candidate, block });
        }
      }
      return found;
    };
    // The shell iframe appears before the nested GrapesJS canvas is ready.
    // Wait for the unique article-list node itself, not merely the editor title.
    const blockMatches = await this.waitUntil(async () => {
      const found = await scanEditorBlocks();
      return found.length === 1 ? found : false;
    }, this.config.timeouts.blockRenderMs, "全屏编辑器中的文章列表区块挂载").catch(async () => {
      const found = await scanEditorBlocks();
      await mkdir(this.paths.root, { recursive: true });
      const frameInventory = [];
      for (const [index, scope] of [this.editor.page, ...this.editor.page.frames()].entries()) {
        frameInventory.push({ index, url: scope.url?.() ?? "", articleBlockCount: await scope.locator("[data-block-uuid='ai-articlelist']").count().catch(() => 0), bodyText: norm(await scope.locator("body").innerText().catch(() => "")).slice(0, 1000) });
      }
      await writeFile(`${this.paths.root}/article-list-frame-inventory.json`, `${JSON.stringify({ captured_at: new Date().toISOString(), reason: `fullscreen article block matches: ${found.length}`, frames: frameInventory }, null, 2)}\n`, "utf8").catch(() => {});
      await this.editor.page.screenshot({ path: `${this.paths.root}/article-list-fullscreen-not-ready.png` }).catch(() => {});
      if (found.length > 1) throw new Error(`全屏编辑器中的文章列表区块唯一匹配失败：${found.length} 个`);
      throw new Error("全屏编辑器已打开，但内层画布未加载出文章列表区块");
    });
    if (blockMatches.length !== 1) throw new Error(`全屏编辑器中的文章列表区块唯一匹配失败：${blockMatches.length} 个`);
    const { frame: articleCanvas, block } = blockMatches[0];
    await block.scrollIntoViewIfNeeded({ timeout: 3000 });
    const targetBox = await block.boundingBox().catch(() => null);
    if (!targetBox || targetBox.width <= 0 || targetBox.height <= 0) throw new Error("全屏文章列表区块滚动后不可见");

    // Codegen confirmed the product interaction: click an article card inside
    // the uniquely identified block. Do not click the generated article link,
    // which could navigate away from the editor.
    const cardCandidates = block.locator("article, li, [class*='article-item'], [class*='news-item'], [class*='item']");
    let target = block;
    for (let index = 0; index < await cardCandidates.count().catch(() => 0); index++) {
      const candidate = cardCandidates.nth(index);
      if (!(await candidate.isVisible().catch(() => false))) continue;
      if (!(await candidate.locator("a[href]").count().catch(() => 0))) continue;
      target = candidate;
      break;
    }
    const clickBox = await target.boundingBox().catch(() => null);
    if (!clickBox || clickBox.width <= 0 || clickBox.height <= 0) throw new Error("全屏文章卡片不可见，拒绝点击画布空白区域");
    await target.click({ force: true, position: { x: Math.min(35, clickBox.width / 2), y: Math.min(35, clickBox.height / 2) }, timeout: 3000 });
    let panelResult = await this.waitUntil(findPanel, this.config.timeouts.actionMs, "点击全屏文章卡片后右侧设置栏").catch(() => false);
    let entry = { source: "playwright", locator_source: "playwright", action: "fullscreen-article-card-click", fallback_used: false, clicked_at: new Date().toISOString() };
    if (!panelResult) {
      try {
        const evidence = await this.midscene.locate("article-list-fullscreen-card", "在领动区块全屏编辑器的预览画布中，点击一张文章卡片的图片或内容区域，打开文章列表设置侧栏；不要点击标题链接或画布外的设置按钮");
        applyMidsceneEvidence(entry, evidence);
        await this.editor.page.mouse.click(evidence.center[0], evidence.center[1]);
        panelResult = await this.waitUntil(findPanel, 5000, "Midscene 辅助点击文章卡片后右侧设置栏").catch(() => false);
        if (!panelResult) throw new Error("视觉定位点击文章卡片后未出现包含文章排序、加载方式和每页展示数量的设置栏");
      } catch (error) {
        applyMidsceneFailure(entry, error);
        await mkdir(this.paths.root, { recursive: true });
        const frameInventory = [];
        for (const [index, scope] of [this.editor.page, ...this.editor.page.frames()].entries()) {
          const bodyText = norm(await scope.locator("body").innerText().catch(() => ""));
          frameInventory.push({ index, url: scope.url?.() ?? "", articleBlockCount: await scope.locator("[data-block-uuid='ai-articlelist']").count().catch(() => 0), bodyText: bodyText.slice(0, 1600), visibleSettingText: norm(await scope.locator(".modules-setting-container, .el-drawer.open, .block-setting-container").allInnerTexts().catch(() => [])).slice(0, 1800) });
        }
        entry.failure_reason = error.message;
        this.record().settings_entry = entry;
        await writeFile(`${this.paths.root}/article-list-frame-inventory.json`, `${JSON.stringify({ captured_at: new Date().toISOString(), reason: error.message, frames: frameInventory }, null, 2)}\n`, "utf8").catch(() => {});
        await this.editor.page.screenshot({ path: `${this.paths.root}/article-list-settings-entry-failed.png` }).catch(() => {});
        await this.persist();
        throw error;
      }
    }
    const rowEvidence = {};
    for (const label of labels) {
      const locator = panelResult.panel.getByText(label, { exact: true });
      rowEvidence[label] = { matches: await locator.count().catch(() => 0), visible: await locator.first().isVisible().catch(() => false) };
    }
    this.record().settings_entry = entry;
    this.record().settings_panel = { frame_url: panelResult.frame.url(), labels: rowEvidence, excerpt: panelResult.text.slice(0, 1800), discovered_at: new Date().toISOString() };
    this.record().block_editor_opened = true;
    await this.editor.page.screenshot({ path: `${this.paths.root}/article-list-settings-panel.png` }).catch(() => {});
    await this.persist();
    return { ui: panelResult.frame, articleCanvas, panel: panelResult.panel, pagebuilderBlock };
  }

  async waitForFrame(getter, timeoutMs, label) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const candidates = await getter();
      if (candidates.length === 1) return candidates[0];
      if (candidates.length > 1) throw new Error(`${label}唯一匹配失败：${candidates.length} 个`);
      await pause(this.editor.page, 150);
    }
    throw new Error(`${label}等待超时`);
  }

  async waitUntil(check, timeoutMs, label) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      try { const value = await check(); if (value) return value; } catch { /* transient render */ }
      await pause(this.editor.page, 200);
    }
    throw new Error(`${label}等待超时`);
  }

  async settingsRow(panel, label) {
    const labels = panel.locator(".lead-ed-option__label").filter({ hasText: label });
    let labelNode = null;
    for (let index = 0; index < await labels.count().catch(() => 0); index += 1) {
      const candidate = labels.nth(index);
      if (await candidate.isVisible().catch(() => false)) { labelNode = candidate; break; }
    }
    if (!labelNode) {
      const fallback = panel.getByText(label, { exact: true }).first();
      if (await fallback.isVisible().catch(() => false)) labelNode = fallback;
    }
    if (!labelNode) throw new Error(`文章列表侧栏未找到设置项：${label}`);
    const row = labelNode.locator("xpath=ancestor::*[(self::div or self::li) and (.//button or .//input or @role='slider' or .//*[contains(@class,'lead-ed-option__box') or contains(@class,'expandIcon') or contains(@class,'color-match')])][1]");
    return await row.isVisible().catch(() => false) ? row : labelNode;
  }

  async readSettingValue(row) {
    const controls = row.locator("input:not([type='checkbox']):not([type='radio']), select, [role='combobox'], [role='slider']");
    const values = [];
    for (let index = 0; index < await controls.count().catch(() => 0); index += 1) {
      const control = controls.nth(index);
      const value = await control.inputValue().catch(async () => await control.getAttribute("aria-valuenow").catch(() => ""));
      if (value) values.push(norm(value));
    }
    return values.join(" | ") || norm(await row.innerText().catch(() => ""));
  }

  async openArticleScopeDialog(row) {
    // This product uses a custom modal nested inside the settings el-drawer.
    // The drawer itself also has role=dialog, so generic dialog discovery
    // incorrectly treats the whole sidebar as the article picker. Scope to
    // the modal's own `.dialog_content` root and verify its title + data type
    // control before interacting with it.
    const dialogSelectors = ".dialog_content:visible";
    const findDialog = async () => {
      const diagnostics = [];
      for (const scope of [this.editor.page, ...this.editor.page.frames()]) {
        const dialogs = scope.locator(dialogSelectors);
        for (let index = 0; index < await dialogs.count().catch(() => 0); index += 1) {
          const candidate = dialogs.nth(index);
          if (!(await candidate.isVisible().catch(() => false))) continue;
          const isSettingsDrawer = await candidate.evaluate((element) => element.classList.contains("el-drawer")).catch(() => false);
          if (isSettingsDrawer) continue;
          const text = norm(await candidate.innerText().catch(() => ""));
          const title = norm(await candidate.locator(".dialog_header .tit, .dialog-header .tit, .dialog_header .title .tit").first().innerText().catch(() => ""));
          const content = candidate.locator(".dialog_content_wrap");
          const dataType = content.locator("input[role='combobox'], .dynamic-select, [aria-haspopup='listbox']");
          diagnostics.push({ frame_url: scope.url?.() ?? "", title, text: text.slice(0, 300), content_count: await content.count().catch(() => 0), data_type_count: await dataType.count().catch(() => 0) });
          // The actual UI title is `.box.dialog_header > .title > .tit`; some
          // builds omit the intermediate `.title`, so also allow the modal's
          // own text header when the unique content+combobox signature agrees.
          const hasArticlePickerIdentity = title === "选择文章" || (/选择文章/.test(text) && /文章数据/.test(text));
          if (hasArticlePickerIdentity && await content.count().catch(() => 0) === 1 && await dataType.count().catch(() => 0) > 0) {
            this.articleDialogDiscovery = diagnostics;
            return { scope, dialog: candidate };
          }
        }
      }
      this.articleDialogDiscovery = diagnostics;
      return null;
    };
    let found = await findDialog();
    if (found) return found;
    // The row/container itself is not an activator on this build. Clicking it
    // looks successful but leaves the picker hidden; only the right-hand
    // slider icon opens the article/category selector.
    const trigger = row.locator(".expandIcon").first();
    if (!(await trigger.isVisible().catch(() => false))) throw new Error("文章数据设置中未找到选择文章弹窗入口");
    await trigger.click({ force: true, timeout: 2000 }).catch(async () => trigger.evaluate((node) => node.click()));
    try {
      found = await this.waitUntil(findDialog, this.config.timeouts.actionMs, "选择文章弹窗");
    } catch (error) {
      await mkdir(this.paths.root, { recursive: true });
      const diagnostic = { captured_at: new Date().toISOString(), reason: error.message, candidates: this.articleDialogDiscovery ?? [] };
      await writeFile(`${this.paths.root}/article-picker-discovery.json`, `${JSON.stringify(diagnostic, null, 2)}\n`, "utf8").catch(() => {});
      await this.editor.page.screenshot({ path: `${this.paths.root}/article-picker-discovery-failed.png` }).catch(() => {});
      throw new Error(`${error.message}；弹窗候选诊断已保存`);
    }
    return found;
  }

  async setArticleCategory(panel, record) {
    const row = await this.settingsRow(panel, "选择文章");
    const before = await this.readSettingValue(row);
    const { scope, dialog } = await this.openArticleScopeDialog(row);
    const type = dialog.locator(".dialog_content_wrap input[role='combobox']").first();
    if (!(await type.isVisible().catch(() => false))) throw new Error("选择文章弹窗没有文章数据类型控件");
    const currentType = await type.inputValue().catch(() => "");
    if (!currentType.includes("指定分类")) {
      await type.click({ force: true });
      // Element-style dropdowns may be teleported from the picker iframe to
      // the top-level document. Search only currently visible options across
      // the live page/frame tree, and require a unique exact label before
      // selecting it (the hidden input's shadow copy is not actionable).
      const option = await this.waitUntil(async () => {
        const matches = [];
        for (const candidateScope of [this.editor.page, ...this.editor.page.frames()]) {
          const options = candidateScope.locator("[role='option']:visible, .el-select-dropdown:visible li, .dropdown-menu:visible li, .el-select-dropdown:visible [class*='option']");
          for (let index = 0; index < await options.count().catch(() => 0); index++) {
            const candidate = options.nth(index);
            if (norm(await candidate.innerText().catch(() => "")) === "指定分类" && await candidate.isVisible().catch(() => false)) matches.push(candidate);
          }
        }
        if (matches.length > 1) throw new Error(`文章数据类型“指定分类”选项唯一匹配失败：${matches.length} 个可见项`);
        return matches.length === 1 ? matches[0] : false;
      }, this.config.timeouts.actionMs, "文章数据类型菜单‘指定分类’");
      await option.click();
      await this.waitUntil(async () => (await type.inputValue().catch(() => "")).includes("指定分类"), this.config.timeouts.actionMs, "文章数据类型切换为指定分类");
    }
    const categoryName = String(this.mode.articleScopeCategoryName ?? "测试文章分类").trim();
    // Changing the mode triggers an async category-tree load. Wait for the
    // exact category checkbox to become visible before clicking it; selecting
    // the mode alone is not evidence that the filter has been configured.
    const treeItem = dialog.getByRole("treeitem").filter({ hasText: categoryName });
    await this.waitUntil(async () => {
      if (await treeItem.count().catch(() => 0) !== 1) return false;
      const checkbox = treeItem.locator("input[type='checkbox'], .el-checkbox__original").first();
      const label = treeItem.locator("label.el-checkbox, .el-checkbox, [role='checkbox']").first();
      return await checkbox.count().catch(() => 0) === 1 && await label.isVisible().catch(() => false);
    }, this.config.timeouts.blockRenderMs, `文章分类“${categoryName}”加载`);
    const matches = await treeItem.count().catch(() => 0);
    if (matches !== 1) throw new Error(`文章分类“${categoryName}”唯一匹配失败：${matches} 个`);
    const checkbox = treeItem.locator("input[type='checkbox'], .el-checkbox__original").first();
    if (!(await checkbox.count().catch(() => 0))) throw new Error(`文章分类“${categoryName}”没有可验证的复选框`);
    const checkLabel = treeItem.locator("label.el-checkbox, .el-checkbox, [role='checkbox']").first();
    const checked = await checkbox.isChecked().catch(async () => (await checkLabel.getAttribute("aria-checked").catch(() => "")) === "true");
    // A resumed draft can show a checked category while still rendering all
    // articles. Normalize through an actual off→on transition so the editor
    // requests filtered data again, as in the product-list setting flow.
    if (checked) {
      await checkLabel.click({ force: true });
      await this.waitUntil(async () => !(await checkbox.isChecked().catch(() => true)), this.config.timeouts.actionMs, `文章分类“${categoryName}”取消旧勾选`);
    }
    if (await checkLabel.isVisible().catch(() => false)) await checkLabel.click({ force: true });
    else await checkbox.setChecked(true, { force: true });
    const selected = await this.waitUntil(async () => {
      const state = await checkbox.isChecked().catch(async () => (await checkLabel.getAttribute("aria-checked").catch(() => "")) === "true");
      return state ? true : false;
    }, this.config.timeouts.actionMs, `文章分类“${categoryName}”勾选`);
    if (!selected) throw new Error(`文章分类“${categoryName}”复选框没有勾选`);
    record.settings_entry.category_target = categoryName;
    record.settings_entry.category_checkbox_checked = true;
    await this.waitForArticleScopeCommit(
      record.catalog.selected_category.articles,
      `指定分类“${categoryName}”选择器仍打开时等待列表加载`,
      { canvasFrame: this.activeArticleCanvas },
    );
    const close = dialog.locator(".dialog_header .close, .dialog-header .close, .el-dialog__headerbtn, [aria-label='Close']").first();
    if (await close.isVisible().catch(() => false)) await close.click({ force: true });
    else await this.editor.page.keyboard.press("Escape");
    await this.waitUntil(async () => !(await this.openDialogExists()), this.config.timeouts.actionMs, "选择文章弹窗关闭");
    const after = await this.waitUntil(async () => {
      const value = await this.readSettingValue(row);
      return value.includes("指定分类") ? value : false;
    }, this.config.timeouts.actionMs, "侧栏文章数据保持指定分类");
    return { key: "article_scope", label: "选择文章", before, selected: `指定分类 — ${categoryName}`, after, category: categoryName, status: "succeeded", changed_at: new Date().toISOString(), effect_status: "pending", failure_reason: "" };
  }

  async openDialogExists() {
    for (const scope of [this.editor.page, ...this.editor.page.frames()]) {
      const dialogs = scope.locator(".dialog_content:visible, .box_body.dialog_wrap:visible, .el-dialog:visible");
      for (let index = 0; index < await dialogs.count().catch(() => 0); index += 1) {
        const dialog = dialogs.nth(index);
        if (await dialog.evaluate((element) => element.classList.contains("el-drawer")).catch(() => false)) continue;
        const title = norm(await dialog.locator(".dialog_header .tit, .dialog-header .tit, .dialog_header").first().innerText().catch(() => ""));
        if (title === "选择文章") return true;
      }
    }
    return false;
  }

  async chooseArticleDropdown(panel, key, label, wanted) {
    const row = await this.settingsRow(panel, label);
    // Target the actual input, not Element Plus's outer .el-select wrapper.
    // A selector union returns DOM order (the wrapper comes first), so keep
    // the input preference explicit rather than relying on selector order.
    const inputCombobox = row.locator("input[role='combobox']").first();
    const combobox = await inputCombobox.count().catch(() => 0)
      ? inputCombobox
      : row.locator("select, .el-select").first();
    if (!(await combobox.isVisible().catch(() => false))) throw new Error(`文章列表设置“${label}”下拉框不可见`);
    const before = await combobox.inputValue().catch(async () => norm(await combobox.innerText().catch(() => "")));
    if (before.includes(wanted)) return { key, label, before, selected: before, after: before, unchanged: true, status: "succeeded", changed_at: new Date().toISOString(), effect_status: "pending", failure_reason: "" };
    await combobox.click({ force: true, timeout: 2000 });
    const option = await this.waitUntil(async () => {
      for (const scope of [this.editor.page, ...this.editor.page.frames()]) {
        const options = scope.locator("[role='option']:visible, .el-select-dropdown:visible li, .dropdown-menu:visible li");
        for (let index = 0; index < await options.count().catch(() => 0); index += 1) {
          const candidate = options.nth(index);
          const text = norm(await candidate.innerText().catch(() => ""));
          if (text && text.includes(wanted)) return { candidate, text };
        }
      }
      return false;
    }, this.config.timeouts.actionMs, `${label}选项“${wanted}”`);
    await option.candidate.click({ force: true });
    const after = await this.waitUntil(async () => {
      const value = await combobox.inputValue().catch(async () => norm(await combobox.innerText().catch(() => "")));
      return value && value !== before ? value : false;
    }, this.config.timeouts.actionMs, `${label}值更新`);
    return { key, label, before, selected: option.text, after, status: "succeeded", changed_at: new Date().toISOString(), effect_status: "pending", failure_reason: "" };
  }

  async setAllArticles(panel, expectedArticles) {
    const expectedTotal = expectedArticles.length;
    const row = await this.settingsRow(panel, "选择文章");
    const before = await this.readSettingValue(row);
    const { scope, dialog } = await this.openArticleScopeDialog(row);
    const type = dialog.locator(".dialog_content_wrap input[role='combobox']").first();
    if (!(await type.isVisible().catch(() => false))) throw new Error("选择文章弹窗没有文章数据类型控件");
    const chooseType = async (wanted) => {
      await type.click({ force: true });
      const option = await this.waitUntil(async () => {
        for (const candidateScope of [scope, ...this.editor.page.frames()]) {
          const options = candidateScope.locator("[role='option']:visible, .el-select-dropdown:visible li, .dropdown-menu:visible li");
          for (let index = 0; index < await options.count().catch(() => 0); index++) {
            const candidate = options.nth(index);
            if (norm(await candidate.innerText().catch(() => "")) === wanted) return candidate;
          }
        }
        return false;
      }, this.config.timeouts.actionMs, `文章数据类型“${wanted}”`);
      await option.click({ force: true });
      await this.waitUntil(async () => (await type.inputValue().catch(() => "")).includes(wanted), this.config.timeouts.actionMs, `文章数据类型切换为“${wanted}”`);
    };
    const currentType = await type.inputValue().catch(() => "");
    const currentSnapshot = await this.readArticleListSnapshot(this.activeArticleCanvas);
    const needsReset = !currentType.includes("全部文章") || currentSnapshot.total !== expectedTotal;
    if (needsReset) {
      // A prior filtered category can survive beneath a visible “全部文章”
      // label. Re-enter the category mode, clear its actual checkbox, then
      // select all. This forces a genuine data-source transition.
      if (!currentType.includes("指定分类")) await chooseType("指定分类");
      const categoryName = String(this.mode.articleScopeCategoryName ?? "测试文章分类").trim();
      const category = dialog.getByRole("treeitem").filter({ hasText: categoryName });
      await this.waitUntil(async () => await category.count().catch(() => 0) === 1, this.config.timeouts.blockRenderMs, `恢复全部文章前加载“${categoryName}”分类`);
      const checkbox = category.locator("input[type='checkbox'], .el-checkbox__original").first();
      if (await checkbox.isChecked().catch(() => false)) {
        await category.locator("label.el-checkbox, .el-checkbox, [role='checkbox']").first().click({ force: true });
        await this.waitUntil(async () => !(await checkbox.isChecked().catch(() => true)), this.config.timeouts.actionMs, `恢复全部文章前取消“${categoryName}”勾选`);
      }
      await chooseType("全部文章");
    }
    const pickerState = await dialog.evaluate((element) => ({
      mode: element.querySelector("input[role='combobox']")?.value ?? "",
      categories: [...element.querySelectorAll(".el-tree-node")].map((node) => ({
        label: node.querySelector(".el-tree-node__label")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
        checked: node.querySelector("input[type='checkbox']")?.checked === true,
        ariaChecked: node.getAttribute("aria-checked"),
      })).filter((item) => item.label),
      buttons: [...element.querySelectorAll("button")].map((button) => button.textContent?.replace(/\s+/g, " ").trim() ?? "").filter(Boolean),
    })).catch(() => null);
    await mkdir(this.paths.root, { recursive: true });
    await writeFile(`${this.paths.root}/article-scope-picker-state.json`, `${JSON.stringify({ before, needsReset, pickerState, captured_at: new Date().toISOString() }, null, 2)}\n`, "utf8").catch(() => {});
    // Keep the selector open until its asynchronous data request has updated
    // the actual canvas. Closing it immediately after the label flips can
    // leave the five-category result cached under an “全部文章” label.
    await this.waitForArticleScopeCommit(expectedArticles, "全部文章选择器仍打开时等待列表加载", { canvasFrame: this.activeArticleCanvas });
    const close = dialog.locator(".dialog_header .close, .dialog-header .close, .el-dialog__headerbtn, [aria-label='Close']").first();
    if (await close.isVisible().catch(() => false)) await close.click({ force: true });
    else await this.editor.page.keyboard.press("Escape");
    await this.waitUntil(async () => !(await this.openDialogExists()), this.config.timeouts.actionMs, "全部文章选择弹窗关闭");
    const after = await this.waitUntil(async () => {
      const value = await this.readSettingValue(row);
      return value.includes("全部文章") ? value : false;
    }, this.config.timeouts.actionMs, "侧栏文章数据保持全部文章");
    return { key: "article_scope", label: "选择文章", before, selected: "全部文章", after, category: "", status: "succeeded", changed_at: new Date().toISOString(), effect_status: "pending", failure_reason: "" };
  }

  async applyFullscreenSettings(ui) {
    const header = ui.locator(".header-container").filter({ hasText: "编辑区块" }).first();
    const apply = header.getByRole("button", { name: "应用", exact: true }).first();
    if (!(await apply.isVisible().catch(() => false)) || !(await apply.isEnabled().catch(() => false))) throw new Error("全屏区块编辑器顶部“应用”不可用");
    await apply.click({ force: true });
    await this.waitUntil(async () => !(await header.isVisible().catch(() => false)), this.config.timeouts.blockRenderMs, "文章列表区块设置应用");
  }

  async setArticlePageSize(panel) {
    const row = await this.settingsRow(panel, "每页展示数量");
    const input = row.locator("input[type='number'], input[role='spinbutton']").first();
    if (!(await input.isVisible().catch(() => false))) throw new Error("文章列表每页数量右侧输入框不可见");
    const before = await input.inputValue();
    const target = Number(this.mode.expectedPageSize ?? 5);
    await input.fill(String(target), { timeout: 2000 });
    await input.press("Enter").catch(() => {});
    await input.blur().catch(() => {});
    const after = await this.waitUntil(async () => (await input.inputValue().catch(() => "")) === String(target) ? String(target) : false, this.config.timeouts.actionMs, "每页数量设为 5");
    return { key: "page_size", label: "每页展示数量", before, selected: after, after, status: "succeeded", changed_at: new Date().toISOString(), effect_status: "pending", failure_reason: "" };
  }

  async setArticleDisplayField(panel, targetChecked = false) {
    const row = await this.settingsRow(panel, "展示内容");
    const trigger = row.locator("button, .lead-ed-option__box, .expandIcon").last();
    await trigger.click({ force: true, timeout: 2000 });
    const label = String(this.mode.displayFieldLabel ?? "文章分类");
    const checkbox = await this.waitUntil(async () => {
      for (const scope of [this.editor.page, ...this.editor.page.frames()]) {
        const groups = scope.locator(".lead-ed-content-checkbox:visible");
        for (let gi = 0; gi < await groups.count().catch(() => 0); gi++) {
          const group = groups.nth(gi);
          const groupTitle = norm(await group.locator(".lead-ed-content-checkbox-label, .title, .label").first().innerText().catch(() => ""));
          if (groupTitle && !/显示字段|展示内容/.test(groupTitle)) continue;
          const labels = group.locator("label.el-checkbox");
          for (let i = 0; i < await labels.count().catch(() => 0); i++) {
            const candidate = labels.nth(i);
            if (norm(await candidate.innerText().catch(() => "")) === label) return { scope, candidate, input: candidate.locator("input[type='checkbox']").first() };
          }
        }
      }
      return false;
    }, this.config.timeouts.actionMs, `展示内容字段“${label}”`);
    const before = await checkbox.input.isChecked().catch(() => false);
    // Normalize the baseline to visible on resume, then later switch the
    // field off again for a fresh before/after render assertion.
    if (before !== targetChecked) {
      await checkbox.candidate.click({ force: true });
      await this.waitUntil(async () => (await checkbox.input.isChecked().catch(() => !targetChecked)) === targetChecked, this.config.timeouts.actionMs, `展示内容字段“${label}”切换为${targetChecked ? "显示" : "隐藏"}`);
    }
    const after = await checkbox.input.isChecked().catch(() => !targetChecked);
    if (after !== targetChecked) throw new Error(`展示内容字段“${label}”未处于${targetChecked ? "显示" : "隐藏"}状态`);
    const close = checkbox.scope.locator(".box_body.dialog_wrap:visible .dialog_header .close, .box_body.dialog_wrap:visible .close").first();
    if (await close.isVisible().catch(() => false)) await close.click({ force: true });
    return { key: "display_content", label: "展示内容", before: `${label}: ${before ? "on" : "off"}`, selected: `${label}: ${targetChecked ? "on" : "off"}`, after: `${label}: ${after ? "on" : "off"}`, field: label, status: "succeeded", changed_at: new Date().toISOString(), effect_status: "pending", failure_reason: "" };
  }

  async readArticleDisplayField(panel, label = String(this.mode.displayFieldLabel ?? "文章分类")) {
    const row = await this.settingsRow(panel, "展示内容");
    const findField = async () => {
      for (const scope of [this.editor.page, ...this.editor.page.frames()]) {
        const groups = scope.locator(".lead-ed-content-checkbox:visible");
        for (let gi = 0; gi < await groups.count().catch(() => 0); gi++) {
          const group = groups.nth(gi);
          const labels = group.locator("label.el-checkbox");
          for (let i = 0; i < await labels.count().catch(() => 0); i++) {
            const candidate = labels.nth(i);
            if (norm(await candidate.innerText().catch(() => "")) === label) return { candidate, input: candidate.locator("input[type='checkbox']").first() };
          }
        }
      }
      return null;
    };
    let field = await findField();
    if (!field) {
      const trigger = row.locator("button, .lead-ed-option__box, .expandIcon").last();
      await trigger.click({ force: true, timeout: 2000 });
      field = await this.waitUntil(findField, this.config.timeouts.actionMs, `重新打开后读取字段“${label}”`);
    }
    const checked = await field.input.isChecked().catch(() => false);
    const close = field.candidate.locator("xpath=ancestor::*[contains(@class,'lead-ed-content-checkbox')][1]").locator(".close, .dialog_header .close").first();
    if (await close.isVisible().catch(() => false)) await close.click({ force: true });
    return checked;
  }

  async setArticleColor(panel) {
    const row = await this.settingsRow(panel, "基础配色");
    const before = await this.readRenderedArticles(this.activeArticleCanvas);
    const beforeColors = [...new Set(before.flatMap((item) => item.colors ?? []))];
    if (!beforeColors.length) throw new Error("文章列表区块没有可读取的 CTA 计算颜色");
    const configuredTarget = String(this.mode.targetColorHex ?? "#2458D3").toUpperCase();
    const targetHex = beforeColors.includes(hexToRgb(configuredTarget)) ? "#007D4D" : configuredTarget;
    const palette = row.locator(".block-color-match").first();
    if (!(await palette.isVisible().catch(() => false))) throw new Error("文章基础配色没有可见的颜色编辑入口");
    await palette.click({ force: true });
    const hexInput = await this.waitUntil(async () => {
      for (const scope of [this.editor.page, ...this.editor.page.frames()]) {
        const inputs = scope.locator("input:not([type='checkbox']):not([type='radio']):visible");
        for (let index = 0; index < await inputs.count().catch(() => 0); index++) {
          const input = inputs.nth(index);
          const value = await input.inputValue().catch(() => "");
          if (!/^#[0-9a-f]{6}$/i.test(value)) continue;
          const context = await input.evaluate((node) => {
            let current = node;
            const classes = [];
            for (let depth = 0; current && depth < 5; depth += 1, current = current.parentElement) classes.push(String(current.className ?? ""));
            return classes.join(" ");
          }).catch(() => "");
          if (/color|picker/i.test(context)) return input;
        }
      }
      return false;
    }, this.config.timeouts.actionMs, "文章基础配色 HEX 输入框");
    await hexInput.fill(targetHex);
    await hexInput.press("Enter").catch(() => {});
    const after = await this.waitUntil(async () => (await hexInput.inputValue().catch(() => "")).toUpperCase() === targetHex ? targetHex : false, this.config.timeouts.actionMs, "文章基础配色 HEX 值更新");
    return { key: "base_color", label: "基础配色", before: beforeColors.join(" | "), selected: targetHex, after, status: "succeeded", changed_at: new Date().toISOString(), effect_status: "pending", effect_before: { rendered_colors: beforeColors }, effect_after: { target_hex: targetHex, expected_rendered_rgb: hexToRgb(targetHex) }, failure_reason: "" };
  }

  async readBackendArticleCatalog() {
    const helper = new DetailContentBrowser(this.editor.page.context(), this.config);
    try {
      const backend = await helper.open();
      const moduleUrl = new URL(backend.url());
      moduleUrl.pathname = "/phoenix/website";
      moduleUrl.search = "?module=article";
      await backend.goto(moduleUrl.toString(), { waitUntil: "domcontentloaded" });
      await backend.locator("iframe#article").waitFor({ state: "visible", timeout: this.config.timeouts.blockRenderMs });
      const frame = backend.locator("iframe#article").contentFrame();
      await frame.getByRole("link", { name: "管理文章", exact: true }).waitFor({ state: "visible", timeout: this.config.timeouts.blockRenderMs });
      const rows = frame.locator("tr").filter({ has: frame.locator("a[href*='article_update']") });
      await this.waitUntil(async () => await rows.count().catch(() => 0) > 0, this.config.timeouts.blockRenderMs, "内容后台文章数据行");

      const readRows = async () => frame.locator("tr").evaluateAll((nodes) => {
        const headerRow = nodes.find((row) => row.querySelector("th") && !row.querySelector("a[href*='article_update']"));
        const headers = [...(headerRow?.querySelectorAll("th,td") ?? [])].map((cell) => (cell.innerText ?? "").replace(/\\s+/g, " ").trim());
        const categoryIndex = headers.findIndex((header) => /文章分类|分类/.test(header));
        const statusIndex = headers.findIndex((header) => /文章状态|状态/.test(header));
        const publishedIndex = headers.findIndex((header) => /发布时间|发布日期/.test(header));
        return nodes
          .filter((row) => row.querySelector("a[href*='article_update']") && row.getBoundingClientRect().height > 0)
          .map((row) => {
            const link = row.querySelector("a[href*='article_update']");
            const cells = [...row.cells].map((cell) => (cell.innerText ?? "").replace(/\\s+/g, " ").trim());
            const url = new URL(link.href, location.href);
            return {
              id: url.searchParams.get("articleId") ?? "",
              title: (link.innerText ?? "").replace(/\\s+/g, " ").trim(),
              category: cells[categoryIndex] ?? "",
              status: cells[statusIndex] ?? "",
              published_at: cells[publishedIndex] ?? "",
            };
          })
          .filter((article) => article.id && article.title);
      });
      const waitForRowsSettled = async (label) => {
        await backend.waitForTimeout(500);
        let previous = "";
        let stable = 0;
        return this.waitUntil(async () => {
          const current = await readRows();
          const fingerprint = current.map((item) => item.id).join(",");
          stable = fingerprint === previous ? stable + 1 : 0;
          previous = fingerprint;
          const loading = await frame.locator(".loading:visible, .loding_prod:visible, .el-loading-mask:visible, [aria-busy='true']:visible").count().catch(() => 0);
          return stable >= 2 && loading === 0 ? current : false;
        }, this.config.timeouts.blockRenderMs, label);
      };
      const selectCategory = async (name) => {
        const trigger = frame.locator("#searchProd a[action='dropdown_classification_article_searchProd']");
        const menu = frame.locator("#searchProd ul.imitateSelect");
        const current = norm(await trigger.innerText().catch(() => ""));
        if (current !== name) {
          const menuOpen = await menu.evaluate((node) => getComputedStyle(node).display !== "none").catch(() => false);
          if (!menuOpen) await trigger.click({ force: true });
          await this.waitUntil(async () => {
            const text = norm(await menu.innerText().catch(() => ""));
            const visible = await menu.isVisible().catch(() => false);
            return visible && await menu.locator("li[valueid]").count().catch(() => 0) > 0 && !/分类加载中|加载中/.test(text);
          }, this.config.timeouts.blockRenderMs, "后台文章分类选项加载");
          const options = await menu.locator("li[valueid]").evaluateAll((items) => items.map((item) => ({ id: item.getAttribute("valueid") ?? "", name: (item.innerText ?? "").replace(/\\s+/g, " ").trim() })));
          const matches = options.filter((item) => item.name === name);
          if (matches.length !== 1) throw new Error(`内容后台文章分类“${name}”唯一匹配失败：${matches.length} 个`);
          const option = menu.locator(`li[valueid="${matches[0].id}"]`);
          if (!(await option.isVisible().catch(() => false))) throw new Error(`内容后台文章分类“${name}”菜单项不可见`);
          await option.click({ force: true });
          await this.waitUntil(async () => norm(await trigger.innerText().catch(() => "")) === name, this.config.timeouts.actionMs, `后台文章分类选中“${name}”`);
        }
        await frame.locator("a[action='search_article']").click({ force: true });
        return waitForRowsSettled(`后台文章分类“${name}”筛选结果稳定`);
      };

      const allArticles = await selectCategory("全部分类");
      const requestedCategoryName = String(this.mode.articleScopeCategoryName ?? "测试文章分类").trim();
      const filteredArticles = await selectCategory(requestedCategoryName);
      const allIds = new Set(allArticles.map((article) => article.id));
      if (!allArticles.length || !filteredArticles.length || filteredArticles.length >= allArticles.length || filteredArticles.some((article) => !allIds.has(article.id))) {
        throw new Error(`内容后台文章分类“${requestedCategoryName}”筛选结果不是全部文章的非空真子集：${filteredArticles.length}/${allArticles.length}`);
      }
      if (filteredArticles.some((article) => article.category !== requestedCategoryName)) {
        throw new Error(`内容后台筛选“${requestedCategoryName}”后仍出现其他文章分类`);
      }
      const catalog = {
        source: "site-content-management-article-category-filter",
        status: "succeeded",
        articles: allArticles,
        categories: [{ id: "", name: requestedCategoryName, article_ids: filteredArticles.map((article) => article.id), result_count: filteredArticles.length }],
        selected_category: { name: requestedCategoryName, articles: filteredArticles },
        captured_at: new Date().toISOString(),
        failure_reason: "",
      };
      this.record().catalog = catalog;
      await this.persist();
      return catalog;
    } finally {
      await helper.close();
    }
  }

  async configureSettings(record) {
    this.state.type.settings_status = "running";
    this.state.type.settings_opened = true;
    this.state.type.settings_started_at = new Date().toISOString();
    await this.persist();
    const { ui: initialUi, articleCanvas, panel: initialPanel } = await this.openArticleBlockEditor();
    let ui = initialUi;
    let panel = initialPanel;
    this.activeArticleCanvas = articleCanvas;
    record.article_canvas_url = articleCanvas.url();
    record.settings_snapshot_before = await this.readRenderedArticles(articleCanvas);
    record.settings_dom_inventory = await ui.locator(".lead-ed-option, .el-form-item, .setting-item").evaluateAll((nodes) => nodes.map((node) => ({ text: (node.innerText || "").replace(/\s+/g, " ").trim(), classes: typeof node.className === "string" ? node.className : "" })).filter((item) => /选择文章|文章排序|加载方式|每页展示数量|跳转方式|展示内容|基础配色/.test(item.text)));
    const initiallyRenderedCards = record.settings_snapshot_before;
    if (initiallyRenderedCards.length < 2) throw new Error(`编辑器中只有 ${initiallyRenderedCards.length} 篇文章，无法验证文章列表设置`);
    const categoryName = String(this.mode.articleScopeCategoryName ?? "测试文章分类").trim();
    const catalog = await this.readBackendArticleCatalog();

    // A resumed/editor fixture may already be filtered to the test category.
    // Establish an explicit all-articles editor baseline and independently
    // read expected membership from the content-management category filter.
    const allArticlesBaselineSetting = await this.setAllArticles(panel, catalog.articles);
    await this.setArticleDisplayField(panel, true);
    await this.waitForArticleScopeCommit(catalog.articles, "全部文章选择后等待全屏列表加载", { canvasFrame: this.activeArticleCanvas });
    await this.applyFullscreenSettings(ui);
    const allArticlesBaselineSnapshot = await this.waitForArticleScopeCommit(
      catalog.articles, "全部文章基线应用后等待页面数据更新",
    );
    const allArticlesBaseline = allArticlesBaselineSnapshot.cards;
    const expectedCategoryArticles = catalog.selected_category.articles;
    const allBackendIds = catalog.articles.map((article) => article.id);
    if (allArticlesBaseline.length < 2 || expectedCategoryArticles.length < 1 || expectedCategoryArticles.length >= catalog.articles.length) {
      throw new Error(`文章分类“${categoryName}”后台基线数量不足：${expectedCategoryArticles.length}/${catalog.articles.length}`);
    }
    record.result_checks.article_scope_baseline = {
      status: "passed",
      evidence: {
        source: catalog.source,
        article_count: allArticlesBaseline.length,
        backend_total: allArticlesBaselineSnapshot.total,
        rendered_article_ids: allArticlesBaseline.map((article) => article.id),
        backend_article_ids: allBackendIds,
        backend_category_article_ids: expectedCategoryArticles.map((article) => article.id),
      },
    };
    Object.assign(record.settings.find((item) => item.key === "article_scope"), allArticlesBaselineSetting);
    await this.persist();

    const reopenedForCategory = await this.openArticleBlockEditor();
    ui = reopenedForCategory.ui;
    panel = reopenedForCategory.panel;
    this.activeArticleCanvas = reopenedForCategory.articleCanvas;
    const scope = await this.setArticleCategory(panel, record);
    Object.assign(record.settings.find((item) => item.key === "article_scope"), scope);
    await this.persist();
    await this.waitForArticleScopeCommit(expectedCategoryArticles, `指定分类“${categoryName}”选择后等待全屏列表加载`, { canvasFrame: this.activeArticleCanvas });

    // Like the product-list regression, exercise a strict child category first,
    // commit it, and compare the actual rendered article IDs with the catalog
    // baseline.  Then restore “all articles” before testing pagination.
    await this.applyFullscreenSettings(ui);
    const filteredSnapshot = await this.waitForArticleScopeCommit(
      expectedCategoryArticles, `指定分类“${categoryName}”应用后等待页面数据更新`,
    );
    const filteredCards = filteredSnapshot.cards;
    const backendIdByTitle = new Map(expectedCategoryArticles.map((article) => [article.title, article.id]));
    if (backendIdByTitle.size !== expectedCategoryArticles.length) throw new Error(`后台分类“${categoryName}”文章标题不唯一，无法把渲染卡片映射到后台记录`);
    const filteredCardsMapped = filteredCards.map((article) => ({ ...article, backend_id: backendIdByTitle.get(article.title) ?? "" }));
    if (filteredCardsMapped.some((article) => !article.backend_id)) throw new Error(`文章列表渲染结果包含未匹配到后台分类“${categoryName}”的文章标题`);
    const categoryEvidence = assertArticleCategoryResult(
      normalizeArticleCards(filteredCardsMapped.map((article) => ({ ...article, id: article.backend_id }))),
      expectedCategoryArticles.map((article) => article.id),
      catalog.articles.map((article) => article.id),
    );
    record.result_checks.article_scope = { status: "passed", evidence: { category: categoryName, source: catalog.source, ...categoryEvidence, actual_titles: filteredCards.map((article) => article.title), rendered_routes: filteredCards.map((article) => article.href) } };
    Object.assign(record.settings.find((item) => item.key === "article_scope"), { effect_status: "passed", effect_after: record.result_checks.article_scope.evidence });
    await this.persist();

    const reopenedForRestore = await this.openArticleBlockEditor();
    panel = reopenedForRestore.panel;
    ui = reopenedForRestore.ui;
    this.activeArticleCanvas = reopenedForRestore.articleCanvas;
    const allArticlesSetting = await this.setAllArticles(panel, catalog.articles);
    Object.assign(record.settings.find((item) => item.key === "article_scope"), allArticlesSetting);
    await this.persist();
    await this.waitForArticleScopeCommit(catalog.articles, "恢复全部文章选择后等待全屏列表加载", { canvasFrame: this.activeArticleCanvas });
    await this.applyFullscreenSettings(ui);
    const restoredAllSnapshot = await this.waitForArticleScopeCommit(
      catalog.articles, "恢复全部文章后等待页面数据更新",
    );
    record.result_checks.article_scope_restore = {
      status: "passed",
      evidence: {
        backend_total: catalog.articles.length,
        rendered_total: restoredAllSnapshot.total,
        visible_article_ids: restoredAllSnapshot.cards.map((article) => article.id),
      },
    };
    await this.persist();

    const reopened = await this.openArticleBlockEditor();
    panel = reopened.panel;
    ui = reopened.ui;
    this.activeArticleCanvas = reopened.articleCanvas;

    const sort = await this.chooseArticleDropdown(panel, "sort", "文章排序", this.mode.articleSortLabel ?? "按发布日期降序");
    Object.assign(record.settings.find((item) => item.key === "sort"), sort);
    await this.persist();
    const loading = await this.chooseArticleDropdown(panel, "loading", "加载方式", "分页");
    Object.assign(record.settings.find((item) => item.key === "loading"), loading);
    await this.persist();
    const pageSize = await this.setArticlePageSize(panel);
    Object.assign(record.settings.find((item) => item.key === "page_size"), pageSize);
    await this.persist();
    const display = await this.setArticleDisplayField(panel);
    Object.assign(record.settings.find((item) => item.key === "display_content"), display);
    await this.persist();
    const color = await this.setArticleColor(panel);
    Object.assign(record.settings.find((item) => item.key === "base_color"), color);
    await this.persist();

    await this.applyFullscreenSettings(reopened.ui);
    await this.waitForArticleScopeCommit(
      catalog.articles, "文章列表其余设置应用后等待页面数据更新",
      { expectedPageSize: Number(this.mode.expectedPageSize ?? 5) },
    );
    const readback = await this.openArticleBlockEditor();
    const readBackValues = {};
    for (const [key, label] of [["article_scope", "选择文章"], ["sort", "文章排序"], ["loading", "加载方式"], ["page_size", "每页展示数量"]]) {
      readBackValues[key] = await this.readSettingValue(await this.settingsRow(readback.panel, label));
    }
    readBackValues.display_content_checked = await this.readArticleDisplayField(readback.panel);
    const requiredValueMatches = {
      article_scope: /全部文章/.test(readBackValues.article_scope),
      sort: /发布日期降序/.test(readBackValues.sort),
      loading: /分页/.test(readBackValues.loading),
      page_size: /(?:^|\D)5(?:\D|$)/.test(readBackValues.page_size),
      display_content: readBackValues.display_content_checked === false,
    };
    const failedReadbacks = Object.entries(requiredValueMatches).filter(([, passed]) => !passed).map(([key]) => key);
    if (failedReadbacks.length) throw new Error(`文章列表设置重新打开后值未保持：${failedReadbacks.join(", ")}`);
    record.settings_reopened = true;
    record.result_checks.after_reopen = { status: "passed", evidence: { settings: readBackValues, checks: requiredValueMatches } };
    for (const item of record.settings) item.reopened = item.key === "base_color" ? item.after : item.key === "display_content" ? `${this.mode.displayFieldLabel}: off` : readBackValues[item.key];
    await this.applyFullscreenSettings(readback.ui);
    await this.waitForArticleScopeCommit(
      catalog.articles, "重新打开核对后等待页面设置稳定",
      { expectedPageSize: Number(this.mode.expectedPageSize ?? 5) },
    );
    const committed = await this.waitUntil(async () => {
      const matches = await this.pagebuilderArticleBlocks();
      return matches.length === 1 ? matches[0] : false;
    }, this.config.timeouts.blockRenderMs, "文章列表区块设置应用后回到页面编辑器");
    const rendered = await this.readArticleListSnapshot(committed.frame);
    const expectedPageSize = Number(this.mode.expectedPageSize ?? 5);
    assertArticlePageSize(rendered.cards, expectedPageSize);
    if (rendered.pageSize !== expectedPageSize) throw new Error(`文章列表渲染元数据每页数量为 ${rendered.pageSize}，预期 ${expectedPageSize}`);
    record.result_checks.page_size = { status: "passed", evidence: { expected_count: expectedPageSize, actual_count: rendered.cards.length, article_ids: rendered.cards.map((item) => item.id), configured_page_size: rendered.pageSize } };
    Object.assign(record.settings.find((item) => item.key === "page_size"), { effect_status: "passed", effect_after: record.result_checks.page_size.evidence });
    if (!rendered.pagerVisible) throw new Error("设置应用后文章列表没有实际显示分页控件");
    record.result_checks.loading_pagination = { status: "pending", evidence: { pager_visible: rendered.pagerVisible, total_articles: rendered.total, first_page_ids: rendered.cards.map((item) => item.id), second_page: "等待预览页交互验证" } };
    Object.assign(record.settings.find((item) => item.key === "loading"), { effect_status: "pending", effect_after: record.result_checks.loading_pagination.evidence });
    const sortEvidence = assertArticleSort(rendered.cards, { field: "date", direction: "desc" });
    const uniqueDates = [...new Set(rendered.cards.map((item) => item.date))];
    record.result_checks.sort = { status: "passed", evidence: { ...sortEvidence, ordered_article_ids: rendered.cards.map((item) => item.id), distinct_visible_dates: uniqueDates.length, limitation: uniqueDates.length < 2 ? "本页可见文章发布日期相同，顺序校验只确认符合降序，不足以区分先后" : "" } };
    Object.assign(record.settings.find((item) => item.key === "sort"), { effect_status: uniqueDates.length < 2 ? "limited" : "passed", effect_after: record.result_checks.sort.evidence });
    const baselineCategoryVisible = allArticlesBaseline.some((item) => item.fields.category === true);
    const categoryVisibleAfter = rendered.cards.some((item) => item.fields.category === true);
    const fieldEvidence = { field: "文章分类", before_visible: baselineCategoryVisible, after_visible: categoryVisibleAfter };
    if (baselineCategoryVisible && !categoryVisibleAfter) {
      record.result_checks.display_field = { status: "passed", evidence: fieldEvidence };
      Object.assign(record.settings.find((item) => item.key === "display_content"), { effect_status: "passed", effect_before: { field: "文章分类", visible: true }, effect_after: fieldEvidence });
    } else {
      throw new Error(`关闭文章分类字段后卡片分类仍${categoryVisibleAfter ? "可见" : "无法确认基线可见"}`);
    }
    const oldColor = [...new Set(allArticlesBaseline.flatMap((item) => item.colors ?? []))];
    const currentColor = [...new Set(rendered.cards.flatMap((item) => item.colors ?? []))];
    const colorEvidence = assertArticleRenderedColorChanged(oldColor, currentColor);
    record.result_checks.base_color = { status: "passed", evidence: colorEvidence };
    Object.assign(record.settings.find((item) => item.key === "base_color"), { effect_status: "passed", effect_after: colorEvidence });
    record.settings_saved = true;
    record.block_editor_applied = true;
    record.settings_status = "applied_pending_result_checks";
    await this.persist();
  }

  async readArticleListSnapshot(frame, block = null) {
    block ??= frame.locator("[data-block-uuid='ai-articlelist'], .backstage-blocksEditor-wrap:has(li.artclelist-site-block)").first();
    if (await block.count().catch(() => 0) !== 1) throw new Error("文章列表结果断言未找到唯一 AI 文章列表区块");
    const cards = await this.readRenderedArticles(frame, block);
    const meta = await block.evaluate((node) => {
      const read = (name) => node.querySelector(`input[name='${name}']`)?.value ?? "";
      const pagination = node.querySelector("[class*='artclelist-site-pagination']");
      return {
        total: Number(read("totalRow")) || 0,
        page: Number(read("pageNumber")) || 1,
        pageSize: Number(read("pageSize")) || 0,
        pagerVisible: Boolean(pagination && !pagination.classList.contains("hide") && pagination.getBoundingClientRect().height > 0),
      };
    }).catch(() => ({ total: 0, page: 1, pageSize: 0, pagerVisible: false }));
    return { ...meta, cards, frameUrl: frame.url() };
  }

  async runSettings(record) {
    try {
      // Persist the recovered/generated fixture before entering a settings
      // interaction that may safely stop for diagnosis. Otherwise closing a
      // headed browser after an uncertain sidebar step would discard the
      // unsaved block and make the next recording session appear empty.
      if (record.apply_status === "applied" && this.state.page.saved !== true) {
        await this.editor.savePage();
        this.state.page.saved = true;
        record.fixture_saved_before_settings = true;
        record.fixture_saved_at = new Date().toISOString();
        await this.persist();
      }
      return await this.configureSettings(record);
    }
    catch (error) {
      record.settings_status = "failed";
      record.settings_failure_reason = error.message;
      record.failure_reason = error.message;
      record.failed_at = new Date().toISOString();
      await this.persist();
      throw error;
    }
  }

  async readRenderedArticles(frame, block = null) {
    block ??= frame.locator("[data-block-uuid='ai-articlelist']").first();
    return block.evaluate((block) => {
      const links = [...block.querySelectorAll("a[href]")];
      const seen = new Set();
      return links.map((link) => {
        const card = link.closest("li.artclelist-site-block, article, li")
          || link.closest("[class*='article-card'], [class*='news-card'], [class*='article-item'], [class*='news-item'], [class*='card']")
          || link.parentElement;
        const href = link.href || link.getAttribute("href") || "";
        const titleNode = card?.querySelector(".article-title, h1, h2, h3, h4, [class*='article-title'], [class*='news-title']");
        const title = titleNode?.innerText || link.title || link.getAttribute("aria-label")
          || (link.matches(".read-more, [class*='read-more']") ? "" : link.innerText)
          || card?.querySelector("a:not(.read-more):not([class*='read-more'])")?.innerText
          || card?.innerText || "";
        const date = (card?.innerText || "").match(/\b\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}/)?.[0] || "";
        const url = new URL(href, location.href);
        const idMatch = url.pathname.match(/id([a-z0-9]+)\.html?$/i);
        const id = link.getAttribute("data-id") || link.dataset.articleId || idMatch?.[1] || url.pathname;
        if (!id || seen.has(id)) return null;
        seen.add(id);
        const category = card?.querySelector(".article-category")?.textContent ?? "";
        const summary = card?.querySelector(".article-summary")?.textContent ?? "";
        const cta = card?.querySelector(".read-more");
        const colors = cta ? [getComputedStyle(cta).color, getComputedStyle(cta).backgroundColor].filter((color) => color && color !== "rgba(0, 0, 0, 0)" && color !== "transparent") : [];
        return { id, title: title.replace(/\s+/g, " ").trim(), date, category: category.replace(/\s+/g, " ").trim(), summary: summary.replace(/\s+/g, " ").trim(), href, text: (card?.innerText ?? "").replace(/\s+/g, " ").trim(), fields: { summary: Boolean(summary.trim()), image: Boolean(card?.querySelector("img")), date: Boolean(date), category: Boolean(category.trim()) }, colors };
      }).filter(Boolean);
    }).then(normalizeArticleCards);
  }

  async articleBlocksInPage(page) {
    const matches = [];
    for (const frame of page.frames()) {
      const blocks = frame.locator("[data-block-uuid='ai-articlelist'], .backstage-blocksEditor-wrap:has(li.artclelist-site-block)");
      for (let index = 0; index < await blocks.count().catch(() => 0); index++) {
        const block = blocks.nth(index);
        if (await block.isVisible().catch(() => false)) matches.push({ frame, block });
      }
    }
    return matches;
  }

  async verifyArticleResults(page, stage) {
    const matches = await this.articleBlocksInPage(page);
    if (matches.length !== 1) throw new Error(`${stage}唯一文章列表区块匹配失败：${matches.length} 个`);
    const { frame, block } = matches[0];
    const expected = Number(this.mode.expectedPageSize ?? 5);
    let firstSignature = "";
    let stableFirstObservations = 0;
    await this.waitUntil(async () => {
      const snapshot = await this.readArticleListSnapshot(frame, block).catch(() => null);
      if (!snapshot) return false;
      const signature = JSON.stringify({ total: snapshot.total, pageSize: snapshot.pageSize, ids: snapshot.cards.map((item) => item.id), pager: snapshot.pagerVisible });
      stableFirstObservations = signature === firstSignature ? stableFirstObservations + 1 : 1;
      firstSignature = signature;
      return snapshot.cards.length === expected && snapshot.pageSize === expected && snapshot.total > expected && snapshot.pagerVisible && stableFirstObservations >= 3;
    }, this.config.timeouts.blockRenderMs, `${stage}文章列表第一页和分页控件加载`);
    const first = await this.readArticleListSnapshot(frame, block);
    assertArticlePageSize(first.cards, expected);
    if (first.pageSize !== expected) throw new Error(`${stage}文章列表元数据每页数量 ${first.pageSize}，预期 ${expected}`);
    if (!first.pagerVisible) throw new Error(`${stage}文章列表未展示分页控件`);
    if (first.total <= expected) throw new Error(`${stage}文章总量 ${first.total} 不足以验证第二页（每页 ${expected}）`);
    const next = block.locator(".layui-laypage-next:not(.layui-disabled)").first();
    await this.waitUntil(async () => await next.count().catch(() => 0) === 1
      && await next.isVisible().catch(() => false)
      && await next.isEnabled().catch(() => true), this.config.timeouts.blockRenderMs, `${stage}可点击的下一页控件加载`);
    if (!(await next.isVisible().catch(() => false))) throw new Error(`${stage}未找到可点击的下一页控件`);
    const firstIds = first.cards.map((item) => item.id);
    await next.scrollIntoViewIfNeeded({ timeout: 3000 });
    try {
      await next.click({ timeout: 3000 });
    } catch (error) {
      const maskIntercepts = await next.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return Boolean(hit?.closest(".ai-block-mask"));
      }).catch(() => false);
      if (!maskIntercepts) throw error;
      // The preview builder overlays a transparent mask over the canvas. If
      // hit-testing confirms it covers this exact pager control, invoke that
      // control's native click handler, then still require changed card IDs.
      await next.evaluate((node) => node.click());
    }
    let lastPageObservation = null;
    let previousSecondSignature = "";
    let stableSecondObservations = 0;
    const expectedSecondCount = Math.min(expected, Math.max(0, first.total - expected));
    const second = await this.waitUntil(async () => {
      const snapshot = await this.readArticleListSnapshot(frame, block).catch(() => null);
      if (!snapshot) return false;
      const ids = snapshot.cards.map((item) => item.id);
      lastPageObservation = { page: snapshot.page, count: ids.length, ids, titles: snapshot.cards.map((item) => item.title), hrefs: snapshot.cards.map((item) => item.href), expected_count: expectedSecondCount };
      // This theme keeps its hidden pageNumber input at 1 after a client-side
      // pager click. Wait for a complete, non-overlapping second-page result
      // to settle instead of accepting a transient partial card replacement.
      const validPage = ids.length === expectedSecondCount && new Set(ids).size === ids.length;
      const signature = validPage ? ids.join("|") : "";
      stableSecondObservations = signature && signature === previousSecondSignature ? stableSecondObservations + 1 : signature ? 1 : 0;
      previousSecondSignature = signature;
      return stableSecondObservations >= 3 ? snapshot : false;
    }, this.config.timeouts.blockRenderMs, `${stage}文章列表翻至第二页`).catch(async (error) => {
      await mkdir(this.paths.root, { recursive: true });
      const pager = await block.locator(".layui-laypage").first().evaluate((node) => ({
        text: node.innerText?.replace(/\s+/g, " ").trim() ?? "",
        html: node.outerHTML.slice(0, 6000),
      })).catch(() => null);
      await writeFile(`${this.paths.root}/article-${stage}-pager-failure.json`, `${JSON.stringify({ stage, page_url: page.url(), first_ids: firstIds, last_observed: lastPageObservation, pager, captured_at: new Date().toISOString() }, null, 2)}\n`, "utf8").catch(() => {});
      await page.screenshot({ path: `${this.paths.root}/article-${stage}-pager-failure.png` }).catch(() => {});
      throw new Error(`${error.message}；最近观察 ${JSON.stringify(lastPageObservation)}`);
    });
    let pagination;
    try {
      pagination = assertArticlePagination({ firstPage: first.cards, secondPage: second.cards, pagerVisible: first.pagerVisible, totalArticles: first.total });
    } catch (error) {
      await mkdir(this.paths.root, { recursive: true });
      const diagnostic = { stage, page_url: page.url(), first_cards: first.cards.map(({ id, title, href }) => ({ id, title, href })), second_cards: second.cards.map(({ id, title, href }) => ({ id, title, href })), pager_text: await block.locator(".layui-laypage").first().innerText().catch(() => ""), reason: error.message, captured_at: new Date().toISOString() };
      await writeFile(`${this.paths.root}/article-${stage}-pagination-assertion-failure.json`, `${JSON.stringify(diagnostic, null, 2)}\n`, "utf8").catch(() => {});
      await page.screenshot({ path: `${this.paths.root}/article-${stage}-pagination-assertion-failure.png` }).catch(() => {});
      throw error;
    }
    const allCards = [...first.cards, ...second.cards];
    const sortEvidence = assertArticleCatalogSort(allCards, this.record().catalog.articles, { direction: "desc" });
    const categoryField = second.cards.some((article) => article.fields.category === true);
    if (categoryField) throw new Error(`${stage}第二页文章分类字段仍然可见`);
    const baseline = this.record().settings_snapshot_before ?? [];
    const beforeColors = [...new Set(baseline.flatMap((article) => article.colors ?? []))];
    const actualColors = [...new Set(allCards.flatMap((article) => article.colors ?? []))];
    const colorEvidence = assertArticleRenderedColorChanged(beforeColors, actualColors);
    return { first, second, pagination, sort: sortEvidence, field: { label: "文章分类", visible: categoryField }, color: colorEvidence };
  }

  async verifyPreviewResults() {
    const beforePages = new Set(this.editor.page.context().pages());
    const editorUrlBeforePreview = this.editor.page.url();
    const preview = this.editor.page.locator(".clickToPreview").first();
    if (await preview.isVisible().catch(() => false)) await preview.click();
    else {
      const text = this.editor.page.getByText("预览", { exact: true }).first();
      if (!(await text.isVisible().catch(() => false))) throw new Error("找不到文章列表预览入口");
      await text.click();
    }
    const previewPage = await this.waitUntil(async () => {
      const newPage = this.editor.page.context().pages().find((candidate) => !beforePages.has(candidate));
      if (newPage) return newPage;
      if (this.editor.page.url() !== editorUrlBeforePreview) return this.editor.page;
      return false;
    }, this.config.timeouts.blockRenderMs, "文章列表预览页打开");
    await previewPage.waitForLoadState("domcontentloaded").catch(() => {});
    const result = await this.verifyArticleResults(previewPage, "预览");
    this.record().result_checks.loading_pagination = { status: "passed", evidence: result.pagination };
    this.record().result_checks.sort = { status: "passed", evidence: result.sort };
    this.record().result_checks.display_field = { status: "passed", evidence: result.field };
    this.record().result_checks.base_color = { status: "passed", evidence: result.color };
    this.record().result_checks.preview = { status: "passed", evidence: { url: previewPage.url(), first_page_ids: result.first.cards.map((item) => item.id), second_page_ids: result.second.cards.map((item) => item.id) } };
    this.record().preview_verified = true;
    await this.persist();
    if (previewPage !== this.editor.page && !previewPage.isClosed()) await previewPage.close();
    return result;
  }

  async verifyPublishedResults() {
    const published = await this.editor.page.context().newPage();
    await published.goto(this.state.page.publicUrl, { waitUntil: "domcontentloaded" });
    const result = await this.verifyArticleResults(published, "公开页");
    this.record().result_checks.published = { status: "passed", evidence: { url: published.url(), first_page_ids: result.first.cards.map((item) => item.id), second_page_ids: result.second.cards.map((item) => item.id) } };
    this.record().published_verified = true;
    await this.persist();
    await published.close();
    return result;
  }

  async run({ resume = false, publish = true } = {}) {
    await this.initialize({ resume });
    if (resume && this.record().settings_status === "running") {
      // A process can stop while a fullscreen-only draft is open. Opening
      // the saved custom page discards that draft. Reconcile only when the
      // unique persisted block still shows the known all-article baseline;
      // otherwise leave the safety stop in articleListResumeAction intact.
      const blocks = await this.pagebuilderArticleBlocks();
      const expectedTotal = this.record().catalog?.articles?.length ?? 0;
      if (this.state.page.saved && blocks.length === 1 && expectedTotal > 0) {
        const snapshot = await this.readArticleListSnapshot(blocks[0].frame, blocks[0].block);
        if (snapshot.total === expectedTotal && snapshot.cards.length === Math.min(expectedTotal, snapshot.pageSize)) {
          this.record().settings_status = "failed";
          this.record().settings_failure_reason = "中断后重新打开已保存页面，唯一文章区块仍为全部文章基线；丢弃未应用的全屏草稿并重试设置";
          this.record().settings_reconciled_at = new Date().toISOString();
          await this.persist();
        }
      }
    }
    const canReconcileUncertainApply = resume && this.record().application_recovery_required === true
      && this.record().generation_status === "succeeded" && this.record().apply_status !== "applied";
    const action = resume && !canReconcileUncertainApply ? articleListResumeAction(this.state, true) : "continue";
    if (action === "recover-generated-result") throw new Error("生成记录已成功但尚未应用；请运行 history reuse 后再从记录添加，拒绝重复生成");
    if (canReconcileUncertainApply) {
      const existing = await this.pagebuilderArticleBlocks();
      if (existing.length > 1) throw new Error(`应用状态核对发现 ${existing.length} 个文章列表区块，拒绝恢复`);
      if (existing.length === 1) {
        this.record().apply_status = "applied";
        this.record().application_commit_confirmed = true;
        if (!this.state.page.types.includes(this.record().type)) this.state.page.types.push(this.record().type);
      } else {
        this.record().application_attempted = false;
        this.record().application_commit_confirmed = false;
        this.record().application_recovery_reconciled_at = new Date().toISOString();
        await this.recoverGeneratedHistory();
      }
      await this.persist();
    }
    if (this.record().apply_status === "applied" && !(await this.pagebuilderArticleBlocks()).length) {
      if (this.record().generation_status !== "succeeded" || !this.record().history_marker) throw new Error("文章列表状态記为已应用但编辑器区块不存在，且无成功生成记录，拒绝恢复");
      this.record().application_recovery_required = true;
      this.record().apply_status = "pending";
      this.state.page.types = this.state.page.types.filter((type) => type !== this.record().type);
      this.record().application_commit_confirmed = false;
      await this.persist();
      await this.recoverGeneratedHistory();
    }
    if (this.record().apply_status !== "applied") {
      if (this.record().generation_status !== "pending" && resume) throw new Error("已有生成但未确认应用，恢复时拒绝重复生成");
      try { await this.base.generateAndApply(this.record()); }
      catch (error) { this.record().failure_reason = error.message; this.record().failed_at = new Date().toISOString(); await this.persist(); throw error; }
    } else if (this.record().settings_status !== "succeeded"
      && !(this.record().settings_status === "applied_pending_result_checks"
        && this.record().settings_saved === true
        && ["article_scope", "article_scope_restore", "sort", "page_size", "display_field", "base_color", "after_reopen"].every((key) => this.record().result_checks[key]?.status === "passed"))) {
      // An already-applied block is resumed in place; never invoke generation
      // again just because the settings-only checkpoint needs attention.
      await this.runSettings(this.record());
    }
    await this.editor.savePage();
    this.state.page.saved = true;
    await this.persist();
    if (!this.state.page.preview_verified || this.record().result_checks.preview?.status !== "passed") {
      await this.base.verifyPreview(1);
      await this.verifyPreviewResults();
      this.state.page.preview_verified = true;
      this.record().preview_verified = true;
      await this.persist();
    }
    if (publish) {
      if (!this.state.page.published_verified) {
        await this.editor.publishSite();
        await this.base.verifyPublished();
        this.state.page.published_verified = true;
        this.record().published_verified = true;
        await this.persist();
      }
      if (this.record().result_checks.published?.status !== "passed") await this.verifyPublishedResults();
    }
    const requiredResults = ["article_scope", "sort", "loading_pagination", "page_size", "display_field", "base_color", "preview", "published"];
    if (requiredResults.every((key) => this.record().result_checks[key]?.status === "passed")) {
      this.record().settings_status = "succeeded";
      this.record().settings_failure_reason = "";
      this.record().failure_reason = "";
      this.record().failed_at = null;
    } else this.record().settings_status = "partial";
    await this.persist();
    return this.state;
  }

  async cleanup() {
    const current = await readArticleListSettingsJson(this.paths.state);
    if (!current) return { ...this.state, page: { cleanup_status: "not-found" } };
    if (current.page.name !== articleListSettingsDescriptor(this.config, this.runId).name) throw new Error("页面身份不匹配，拒绝清理");
    throw new Error("文章列表专项默认保留测试页；当前版本暂未开放自动删除，请人工确认后再清理");
  }
}
