import { mkdir, writeFile } from "node:fs/promises";
import { AiBlockAutomation } from "./ai-runner.mjs";
import { DetailContentBrowser } from "./ai-detail-content.mjs";
import { waitForCategoryTreeReady } from "./product-category-readiness.mjs";
import { markTypeApplied, markTypeGenerated, markTypeStarted } from "./ai-state.mjs";
import {
  assertProductListSettingsState,
  createProductListSettingsState,
  productListSettingsDescriptor,
  productListSettingsPaths,
  productScopeResumeAction,
  markProductScopeEffect,
  productListSettingsResumeAction,
  readProductListSettingsJson,
  writeProductListSettingsJson,
} from "./ai-product-list-settings-state.mjs";
import {
  MidsceneLocatorFallback,
  applyMidsceneEvidence,
  applyMidsceneFailure,
} from "./midscene-fallback.mjs";
import {
  assertAscendingProductNames,
  assertCategoryResult,
  assertExactCategoryResult,
  assertDistinctPages,
  assertFieldVisibility,
  assertPageSize,
  assertRenderedColorChanged,
  normalizeProductCards,
} from "./ai-product-list-observations.mjs";
import {
  choosePreviewContentFrame,
  chooseProductCanvasCandidate,
  chooseProductListPanelCandidate,
  frameAncestry,
  isPagebuilderCanvasUrl,
  isFrameWithin,
  sanitizeFrameUrl,
} from "./product-list-frame-resolver.mjs";

async function waitFor(check, timeoutMs, label, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value; }
    catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`${label}等待超时${lastError ? `：${lastError.message}` : ""}`);
}

async function visible(locator) { return Boolean(locator) && locator.isVisible().catch(() => false); }

async function firstVisible(locators) {
  for (const locator of locators) if (await visible(locator)) return locator;
  return null;
}

function normalize(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function hexToRgb(hex) {
  const value = String(hex).replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(value)) throw new Error(`无效 HEX 颜色：${hex}`);
  return `rgb(${parseInt(value.slice(0, 2), 16)}, ${parseInt(value.slice(2, 4), 16)}, ${parseInt(value.slice(4, 6), 16)})`;
}

export class AiProductListSettingsAutomation {
  constructor(editor, config, runId) {
    this.editor = editor;
    this.config = config;
    this.mode = config.ai.productListSettingsRegression;
    this.runId = runId;
    this.paths = productListSettingsPaths(config, runId);
    const scopedConfig = {
      ...config,
      ai: {
        ...config.ai,
        runId,
        types: [this.mode.type],
        blocksPerPage: 1,
        inputMode: this.mode.inputMode,
        generationMode: this.mode.generationMode,
        promptPolishEnabled: this.mode.promptPolishEnabled,
        pageNamePrefix: this.mode.pageNamePrefix,
        pagePathPrefix: this.mode.pagePathPrefix,
        applyIntervalMs: this.mode.applyIntervalMs,
        publishInitialWaitMs: this.mode.publishInitialWaitMs,
        publishPollIntervalMs: this.mode.publishPollIntervalMs,
        publishTimeoutMs: this.mode.publishTimeoutMs,
        prompts: { ...config.ai.prompts, [this.mode.type]: this.mode.prompt },
      },
    };
    const store = {
      load: async () => readProductListSettingsJson(this.paths.state),
      save: async (value) => writeProductListSettingsJson(this.paths.state, value),
    };
    this.base = new AiBlockAutomation(editor, scopedConfig, store);
    this.midscene = new MidsceneLocatorFallback(editor.page, this.mode.midsceneFallback);
    this.base.verifyEditorType = async () => this.verifyEditorBlock();
    this.base.afterFinalApply = async ({ record }) => {
      await this.configureSettings(record);
      await this.verifyCommittedSettings(record);
    };
  }

  record() { return this.state.type; }
  async persist() { await writeProductListSettingsJson(this.paths.state, this.state); }

  async productBlockLocator(wrapper) {
    const isBlock = await wrapper.evaluate((element) =>
      element.matches("[data-block-uuid='ai-productlist'], .ai-generated-block"),
    ).catch(() => false);
    return isBlock
      ? wrapper
      : wrapper.locator("[data-block-uuid='ai-productlist'], .ai-generated-block").first();
  }

  async floatingBlockControl(match, className) {
    const wrapperId = await match.wrapper.getAttribute("id").catch(() => "");
    if (!wrapperId) return match.frame.locator(".__product_list_missing_stable_owner__").first();
    // The AI mask/toolbar are appended near the end of the canvas document,
    // outside the block wrapper. Use the toolbar's data-id ownership link.
    return match.frame.locator(`.ai-block-floating-toolbar .${className}[data-id="${wrapperId}"]`).first();
  }

  async initialize({ resume = false } = {}) {
    const existing = await readProductListSettingsJson(this.paths.state);
    if (existing) this.state = assertProductListSettingsState(existing, this.config, this.runId);
    else {
      if (resume) throw new Error(`运行 ${this.runId} 没有产品列表设置状态，无法恢复`);
      this.state = createProductListSettingsState(this.config, this.runId);
      await this.persist();
    }
    this.base.state = this.state;
    this.base.page = this.state.page;
    const scopeSetting = this.settingRecord(this.record(), "product_scope");
    if (this.mode.productScopeOnly === true
      && this.record().result_checks?.product_scope?.status !== "passed"
      && scopeSetting?.effect_reopened?.after_apply?.result_validation_pending === true
      && scopeSetting.reopened === this.mode.productScopeCategoryName) {
      // Migrate earlier scope-only runs that copied the requested category
      // into `reopened` without actually reading it back from the UI.
      scopeSetting.reopened = "";
      scopeSetting.effect_reopened.after_apply.category_ui_reread = false;
      this.record().settings_reopened = false;
      await this.persist();
    }
    const exists = await this.editor.customPageExists(this.state.page.name);
    if (!exists) {
      const freshHistoryReuse = this.record().history_source_run_id
        && !this.state.page.created_at
        && this.state.page.types.length === 0
        && !this.state.page.saved
        && !this.state.page.published_verified;
      if (existing && !freshHistoryReuse && (this.state.page.types.length > 0 || this.record().generation_status !== "pending")) {
        throw new Error(`测试页 ${this.state.page.name} 已不存在，拒绝重复生成或扣点`);
      }
      try {
        await this.editor.createCustomPage(this.state.page);
      } catch (error) {
        // The create API can succeed while the editor's page selector still
        // briefly displays the previous page. Re-check the custom-page list
        // before treating that stale selector as a creation failure.
        if (!(await this.editor.customPageExists(this.state.page.name))) throw error;
        await this.editor.openCustomPage(this.state.page.name);
      }
      this.state.page.created_at ??= new Date().toISOString();
      await this.persist();
    } else {
      await this.editor.openCustomPage(this.state.page.name);
      this.state.page.created_at ??= new Date().toISOString();
    }
    if (resume) return productListSettingsResumeAction(this.state, true);
    return this.state;
  }

  async blockMatches({ canvasOnly = false } = {}) {
    const matches = await this.editor.findAiBlockWrappers();
    if (!canvasOnly) return matches;
    // Prefer the active 3.0 pagebuilder canvas. Some builds render a second,
    // visually similar product preview in a nested frame; the generic AI
    // wrapper selector can see that preview while missing the committed
    // module marker in the editor canvas.
    const canvasFrames = this.editor.page.frames().filter((frame) => {
      const url = frame.url();
      // Both /phoenix/pagebuilder/<page-id> and /phoenix/pagebuilder?_=... are
      // used by the live builder across navigation states. Exclude the outer
      // /layout shell, but don't assume a slash before the query string.
      return isPagebuilderCanvasUrl(url) && !/\/phoenix\/pagebuilder\/layout(?:\?|$)/.test(url);
    });
    const activeCanvas = [];
    for (const frame of canvasFrames) {
      const nodes = frame.locator("[data-block-uuid='ai-productlist']");
      for (let index = 0; index < await nodes.count().catch(() => 0); index += 1) {
        const block = nodes.nth(index);
        if (!(await block.locator("li.prodlist-site-block").count().catch(() => 0))) continue;
        const box = await block.boundingBox().catch(() => null);
        if (!(await visible(block)) && (!box || box.width <= 0 || box.height <= 0)) continue;
        const wrapper = block.locator("xpath=ancestor::div[contains(@class,'siteblocks-setting-wrap')][1]");
        activeCanvas.push({ frame, wrapper: (await visible(wrapper)) ? wrapper : block });
      }
    }
    if (activeCanvas.length > 0) return activeCanvas;
    // Only a real pagebuilder frame can prove that the generated block was
    // committed. AI history/result iframes also contain the same marker and
    // must never satisfy the application assertion.
    const committed = [];
    for (const match of matches) {
      if (!match.frame.url().includes("/phoenix/pagebuilder/")) continue;
      const productBlock = match.wrapper.locator("[data-block-uuid='ai-productlist'], .ai-generated-block").first();
      const markerCount = await productBlock.count().catch(() => 0);
      const cardCount = await productBlock.locator("li.prodlist-site-block").count().catch(() => 0);
      if (markerCount > 0 && cardCount > 0) committed.push(match);
    }
    if (committed.length > 0) return committed;
    return [];
  }

  async verifyEditorBlock() {
    const matches = await waitFor(async () => {
      const found = await this.blockMatches({ canvasOnly: true });
      return found.length === 1 ? found : false;
    }, this.config.timeouts.blockRenderMs, "产品列表编辑器区块");
    this.record().editor_verified = true;
    this.record().block_identity = await this.editor.describeAiBlockWrappers().then((items) => items.find((item) => item.frame === matches[0].frame)?.identity ?? null);
    await this.persist();
    return Boolean(matches.length === 1);
  }

  async settingsPanel({ timeoutMs = 4000 } = {}) {
    const selectors = this.config.selectors.aiProductListSettingsPanelSelector || ".block-setting-panel, .backstage-setting-panel, .siteblocks-setting-panel, .right-setting-panel, .backstage-right-panel";
    const resolve = async () => {
      const candidates = [];
      for (const scope of [this.editor.page, ...this.editor.page.frames()]) {
        // The AI editor keeps stale drawers mounted while switching blocks.
        // Only the currently open module drawer is actionable; selecting a
        // hidden clone makes its coordinates disagree with the visible panel.
        const openDrawers = scope.locator(".modules-setting-container .el-drawer.open, .el-drawer.open");
        for (let index = 0; index < await openDrawers.count().catch(() => 0); index += 1) {
          const panel = openDrawers.nth(index);
          // Do not rely on Locator.filter({has}) here.  The drawer and the
          // style container can live in different Vue subtrees, and Playwright
          // may therefore reject a relative `has` locator even though the
          // drawer is the visible one.  Inspect the candidate in place.
          if (!(await panel.locator(".style-setting-container").count().catch(() => 0))) continue;
          const text = await panel.innerText().catch(() => "");
          const box = await panel.boundingBox().catch(() => null);
          candidates.push({
            frame: scope,
            panel,
            text,
            visible: Boolean(box && box.width > 0 && box.height > 0),
            hasProductListTitle: /产品列表/.test(text),
            hasRequiredSettings: /产品排序/.test(text) && /加载方式/.test(text) && /每页(?:显示|展示)数量/.test(text),
          });
        }
        const panels = scope.locator(selectors);
        for (let index = 0; index < await panels.count().catch(() => 0); index += 1) {
          const panel = panels.nth(index);
          const text = await panel.innerText().catch(() => "");
          const isOpenDrawer = await panel.evaluate((element) => element.matches(".el-drawer.open") || Boolean(element.closest(".el-drawer.open"))).catch(() => false);
          if (!isOpenDrawer) candidates.push({
            frame: scope,
            panel,
            text,
            visible: await visible(panel),
            hasProductListTitle: /产品列表/.test(text),
            hasRequiredSettings: /产品排序/.test(text) && /加载方式/.test(text) && /每页(?:显示|展示)数量/.test(text),
          });
        }
      }
      const eligible = candidates.filter((candidate) => candidate.visible && candidate.hasProductListTitle && candidate.hasRequiredSettings);
      if (eligible.length > 1) throw new Error(`产品列表设置侧栏唯一匹配失败：${eligible.length} 个可见侧栏包含相同设置项`);
      if (!eligible.length) return false;
      const candidate = chooseProductListPanelCandidate(eligible);
      this.activeSettingsFrame = candidate.frame;
      this.activeSettingsPanel = candidate.panel;
      return candidate.panel;
    };
    const deadline = Date.now() + Math.min(timeoutMs, this.config.timeouts.actionMs);
    let lastError;
    while (Date.now() < deadline) {
      try {
        const panel = await resolve();
        if (panel) return panel;
      } catch (error) {
        if (/唯一匹配失败/.test(error.message)) throw error;
        lastError = error;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    throw new Error(`产品列表设置侧边栏等待超时${lastError ? `：${lastError.message}` : ""}`);
  }

  async settingsRow(panel, label) {
    const labels = panel.locator(".lead-ed-option__label").filter({ hasText: label });
    let text = null;
    for (let index = 0; index < await labels.count().catch(() => 0); index += 1) {
      const candidate = labels.nth(index);
      if (await visible(candidate) && await candidate.boundingBox().catch(() => null)) { text = candidate; break; }
    }
    if (!text) {
      const fallback = panel.getByText(label, { exact: true }).first();
      if (await visible(fallback)) text = fallback;
    }
    if (!text) throw new Error(`产品列表侧边栏未找到设置项：${label}`);
    const row = text.locator("xpath=ancestor::*[(self::div or self::li) and (.//button or .//input or @role='slider' or .//*[contains(@class,'lead-ed-option__box') or contains(@class,'expandIcon') or contains(@class,'dynamic-select') or contains(@class,'color-match-items')])][1]");
    return (await visible(row)) ? row : text;
  }

  async readRow(row) {
    const values = [];
    for (const selector of ["input", "select", "[role='combobox']", "[role='slider']"]) {
      const nodes = row.locator(selector);
      for (let index = 0; index < await nodes.count().catch(() => 0); index += 1) {
        const node = nodes.nth(index);
        values.push(await node.getAttribute("value").catch(() => "") || await node.getAttribute("aria-valuenow").catch(() => ""));
      }
    }
    return normalize(values.filter(Boolean).join(" | ") || await row.innerText().catch(() => ""));
  }

  settingRecord(record, key) {
    return record.settings.find((item) => item.key === key);
  }

  async clickWithLocatorFallback(record, key, control, description, readyCheck) {
    const fastTimeout = this.mode.midsceneFallback?.domFastPathTimeoutMs ?? 2000;
    let directError;
    try {
      await control.click({ force: true, timeout: fastTimeout });
      if (!readyCheck || await waitFor(readyCheck, Math.min(750, fastTimeout), `${key}控件展开`, 100).catch(() => false)) {
        applyMidsceneEvidence(this.settingRecord(record, key), { source: "playwright", duration_ms: 0, rect: null });
        return { source: "playwright" };
      }
      directError = new Error(`${key}点击后状态未变化`);
    } catch (error) {
      directError = error;
    }
    if (!this.midscene.isEnabled()) throw directError;
    const setting = this.settingRecord(record, key);
    try {
      const evidence = await this.midscene.locate(key, description);
      applyMidsceneEvidence(this.settingRecord(record, key), evidence);
      await this.editor.page.mouse.click(evidence.center[0], evidence.center[1]);
      if (readyCheck && !(await waitFor(readyCheck, fastTimeout, `${key}视觉点击后状态`, 100).catch(() => false))) {
        throw new Error(`${key}视觉点击后状态未确认`);
      }
      return evidence;
    } catch (error) {
      applyMidsceneFailure(setting, error);
      error.cause ??= directError;
      throw error;
    }
  }

  async chooseDifferentDropdown(panel, key, label, record, desiredLabel = "") {
    const row = await this.settingsRow(panel, label);
    if (key === "product_scope") {
      return this.chooseDifferentProductScope(row, label, record);
    }
    // Keep the value separate from the row label.  Comparing against the
    // whole row text would allow the current option (for example “按后台设置
    // 顺序排”) through the filter because the row also contains “产品排序”.
    const readSelectValue = async () => {
      const input = row.locator("input[role='combobox'], select").first();
      const inputValue = await input.inputValue().catch(() => "");
      if (inputValue) return normalize(inputValue);
      return normalize(await row.locator(".lead-ed-option__box").innerText().catch(() => ""));
    };
    const before = await readSelectValue();
    if (desiredLabel && before.includes(desiredLabel)) {
      return { key, label, before, selected: desiredLabel, after: before, status: "succeeded", changed_at: new Date().toISOString(), failure_reason: "", effect_status: "pending" };
    }
    const control = await firstVisible([
      row.locator("select").first(), row.locator("[role='combobox']").first(),
      row.locator("button").first(), row.locator(".el-select, .select, .dropdown").first(),
      row.getByText(label, { exact: true }).first(),
      row,
    ]);
    if (!control) throw new Error(`产品列表设置项 ${label} 没有可操作控件`);
    await this.clickWithLocatorFallback(
      record,
      key,
      control,
      `产品列表侧边栏中的“${label}”下拉控件`,
      async () => {
        for (const scope of this.editor.contexts()) {
          if (await scope.locator(".el-select-dropdown:visible, .dropdown-menu:visible, .select-options:visible").count().catch(() => 0)) return true;
        }
        return false;
      },
    );
    const option = await waitFor(async () => {
      const candidates = [];
      for (const scope of this.editor.contexts()) {
        candidates.push(scope.locator(key === "product_scope"
          ? "[role='option']:visible, .el-select-dropdown:visible li, .dropdown-menu:visible li, .select-options:visible li, .box_body:visible label, .box_body:visible .el-checkbox"
          : "[role='option']:visible, .el-select-dropdown:visible li, .dropdown-menu:visible li, .select-options:visible li"));
      }
      for (const list of candidates) {
        for (let index = 0; index < await list.count().catch(() => 0); index += 1) {
          const item = list.nth(index);
          const text = normalize(await item.innerText().catch(() => ""));
          if (
            text &&
            text !== label &&
            text !== before &&
            (!desiredLabel || text.includes(desiredLabel)) &&
            !/^(产品列表|选择产品|指定分类|指定产品|相关产品|产品数据)$/.test(text) &&
            !/^(Inverters|Solar Applications|Solar Cell Panels|产品分类|兴趣标签)$/.test(text)
          ) return item;
        }
      }
      return false;
    }, this.config.timeouts.actionMs, `${label}可选值`);
    const selected = normalize(await option.innerText().catch(() => ""));
    await option.click({ force: true });
    // Element-Plus teleported menus can remain mounted for a transition (or
    // after a force click). Close only a still-visible dropdown before the
    // next setting so its options cannot be mistaken for the next row's
    // choices.
    const dropdownStillVisible = async () => {
      for (const scope of this.editor.contexts()) {
        if (await scope.locator(".el-select-dropdown:visible, [role='listbox']:visible, .dropdown-menu:visible, .select-options:visible").count().catch(() => 0)) return true;
      }
      return false;
    };
    if (await waitFor(async () => !(await dropdownStillVisible()), 750, `${label}下拉关闭`, 50).catch(() => false) === false && await dropdownStillVisible()) {
      await this.editor.page.keyboard.press("Escape").catch(() => {});
      await waitFor(async () => !(await dropdownStillVisible()), 500, `${label}下拉关闭重试`, 50).catch(() => {});
    }
    const after = (await readSelectValue()) || selected;
    await writeFile(`${this.paths.root}/dropdown-${key}-debug.json`, `${JSON.stringify({ before, selected, after, rowText: await row.innerText().catch(() => "") }, null, 2)}\n`, "utf8").catch(() => {});
    if (after === before) throw new Error(`${label}选择后值未发生变化`);
    if (desiredLabel && !after.includes(desiredLabel) && !selected.includes(desiredLabel)) {
      throw new Error(`${label}未选择预期选项“${desiredLabel}”，实际为“${after}”`);
    }
    return { key, label, before, selected, after, status: "succeeded", changed_at: new Date().toISOString(), failure_reason: "" };
  }

  async chooseDifferentProductScope(row, label, record, scopeLabel = "指定分类", category = this.record().catalog?.selected_category) {
    const before = await this.readRow(row);
    let categorySelectionEvidence = null;
    const box = row.locator(".lead-ed-option__box").first();
    if (!(await visible(box))) throw new Error(`${label}未找到产品范围展开容器`);

    // “选择产品” is a two-level custom control.  The outer span/icon only
    // toggles .dialog_wrap; the actual options are rendered by the nested
    // Element-Plus combobox.  Never scan hidden poppers in document.body.
    const dialog = row.locator(".box_body.dialog_wrap").first();
    const inlineDialogOpen = async () => {
      const state = await dialog.evaluate((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const content = element.querySelector(".dialog_content");
        const contentStyle = content ? getComputedStyle(content) : null;
        const contentRect = content?.getBoundingClientRect();
        return {
          visible: style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0,
          contentVisible: Boolean(content && contentStyle?.display !== "none" && contentStyle?.visibility !== "hidden" && contentRect?.width > 0 && contentRect?.height > 0),
        };
      }).catch(() => ({ visible: false, contentVisible: false }));
      return state.visible || state.contentVisible;
    };
    const currentDialog = async () => {
      if (await inlineDialogOpen()) return dialog;
      for (const scope of this.editor.contexts()) {
        // The product selector is rendered by different editor builds as a
        // `.box_body.dialog_wrap`, an Element-Plus dialog, or a plain overlay
        // with a generated dialog class.  Search all visible dialog-shaped
        // containers, but require the product-data controls so the outer
        // settings drawer itself is never mistaken for this popup.
        const dialogs = scope.locator(".box_body.dialog_wrap:visible, .dialog_content:visible, .el-dialog:visible, [role='dialog']:visible, [class*='dialog']:visible");
        for (let index = 0; index < await dialogs.count().catch(() => 0); index += 1) {
          const candidate = dialogs.nth(index);
          if (!(await visible(candidate))) continue;
          if (await candidate.evaluate((element) => element.classList.contains("el-drawer")).catch(() => false)) continue;
          const text = normalize(await candidate.innerText().catch(() => ""));
          const hasSelect = await candidate.locator("input[role='combobox'], .dynamic-select, [aria-haspopup='listbox']").count().catch(() => 0);
          if (/选择产品/.test(text) && (/产品数据|全部产品|指定分类|指定产品|相关产品/.test(text) || hasSelect)) return candidate;
        }
      }
      return null;
    };
    const openDialog = async () => {
      if (await currentDialog()) return { source: "playwright", duration_ms: 0, rect: null };
      const fastTimeout = this.mode.midsceneFallback?.domFastPathTimeoutMs ?? 2000;
      const targets = [
        row.locator(".expandIcon").first(),
        row.locator(".lead-ed-expand__name").first(),
        box,
      ];
      const perTargetTimeout = Math.max(250, Math.floor(fastTimeout / targets.length));
      for (const target of targets) {
        if (!(await visible(target))) continue;
        await target.click({ force: true, timeout: perTargetTimeout }).catch(() => {});
        // Vue's custom expand control occasionally ignores Playwright's
        // synthesized click while the page selector overlay is transitioning.
        // Dispatch the same DOM click once, then verify the inline dialog
        // itself rather than relying only on a global visible-dialog scan.
        if (!(await inlineDialogOpen())) {
          await target.evaluate((element) => element.click()).catch(() => {});
        }
        if (await waitFor(currentDialog, perTargetTimeout, `${label}产品范围面板`, 75).catch(() => false)) {
          return { source: "playwright", duration_ms: 0, rect: null };
        }
      }
      if (this.midscene.isEnabled()) {
        const setting = this.settingRecord(record, "product_scope");
        try {
          const evidence = await this.midscene.locate(
            "product_scope",
            "产品列表设置右侧侧边栏中，选择产品这一行最右侧的滑杆设置图标，用它打开选择产品弹窗",
          );
          applyMidsceneEvidence(this.settingRecord(record, "product_scope"), evidence);
          // Midscene returns screenshot-space coordinates.  The AI editor can
          // render the sidebar in a child frame and Vue may leave stale row
          // clones mounted, so reconcile the visual point with the *current*
          // visible settings control before falling back to a raw mouse click.
          // This keeps Midscene as a locator only while Playwright performs the
          // actual event and state assertion.
          let reconciled = false;
          // Prefer the live visible row whose label is exactly “选择产品”.
          // This avoids clicking a stale hidden clone left by the editor when
          // the selected block has just been opened.
          for (const scope of this.editor.contexts()) {
            const boxes = scope.locator(".lead-ed-option__box:visible");
            for (let index = 0; index < await boxes.count().catch(() => 0); index += 1) {
              const boxNode = boxes.nth(index);
              const text = normalize(await boxNode.innerText().catch(() => ""));
              if (!/^选择产品(?:\\s|全部产品|指定分类|指定产品|相关产品)/.test(text)) continue;
              const target = boxNode.locator(".expandIcon, .lead-ed-expand__name, [class*='expand']").first();
              if (await visible(target)) {
                await target.click({ force: true, timeout: fastTimeout }).catch(() => {});
                reconciled = true;
                break;
              }
            }
            if (reconciled) break;
          }
          const points = [
            evidence.center,
            [evidence.center[0] * (evidence.dpr || 1), evidence.center[1] * (evidence.dpr || 1)],
          ];
          for (const scope of this.editor.contexts()) {
            if (reconciled) break;
            const candidates = scope.locator(".lead-ed-option__box:visible .expandIcon, .lead-ed-option__box:visible .lead-ed-expand__name, .lead-ed-option__box:visible [class*='expand']");
            for (let index = 0; index < await candidates.count().catch(() => 0); index += 1) {
              const candidate = candidates.nth(index);
              const box = await candidate.boundingBox().catch(() => null);
              if (!box || box.width <= 0 || box.height <= 0) continue;
              const hit = points.some(([x, y]) => x >= box.x - 16 && x <= box.x + box.width + 16 && y >= box.y - 16 && y <= box.y + box.height + 16);
              if (!hit) continue;
              await candidate.click({ force: true, timeout: fastTimeout }).catch(() => {});
              reconciled = true;
              break;
            }
            if (reconciled) break;
          }
          if (!reconciled) {
            await this.editor.page.mouse.click(evidence.center[0], evidence.center[1]);
          }
          let opened = await waitFor(currentDialog, fastTimeout, `${label}视觉点击后产品范围面板`, 100).catch(() => false);
          // Some Chrome/iframe combinations expose screenshot coordinates in
          // device pixels even though Playwright's mouse API expects CSS
          // pixels. Try the alternate scale once before failing safely.
          if (!opened && reconciled) {
            for (const [x, y] of points) {
              await this.editor.page.mouse.click(x, y).catch(() => {});
              opened = await waitFor(currentDialog, Math.min(1000, fastTimeout), `${label}视觉坐标重试`, 100).catch(() => false);
              if (opened) break;
            }
          }
          if (!opened) {
            // If the visual click hit the page selector instead of the live
            // row, close that overlay and retry the deterministic inline
            // control once. Midscene remains a locator fallback only.
            await this.editor.dismissPageMenu?.().catch(() => {});
            for (const target of targets) {
              if (!(await visible(target))) continue;
              await target.evaluate((element) => element.click()).catch(() => {});
              opened = await waitFor(currentDialog, Math.min(1000, fastTimeout), `${label}产品范围面板DOM重试`, 100).catch(() => false);
              if (opened) break;
            }
          }
          if (!opened) {
            throw new Error(`${label}视觉点击后产品范围面板未展开`);
          }
          return evidence;
        } catch (error) {
          applyMidsceneFailure(setting, error);
          throw error;
        }
      }
      const debug = await row.evaluate((element) => ({
        html: element.outerHTML,
        rowRect: (() => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })(),
        box: element.querySelector('.lead-ed-option__box')?.outerHTML ?? '',
        dialog: element.querySelector('.box_body.dialog_wrap')?.getAttribute('style') ?? '',
        target: (() => {
          const node = element.querySelector('.expandIcon') || element.querySelector('.lead-ed-expand__name');
          if (!node) return null;
          const rect = node.getBoundingClientRect();
          const owner = node.closest('.lead-ed-option__box');
          const vm = owner?.__vueParentComponent;
          return {
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            pointerEvents: getComputedStyle(node).pointerEvents,
            ownerPointerEvents: owner ? getComputedStyle(owner).pointerEvents : '',
            ownerVueKeys: vm ? Object.keys(vm.ctx ?? {}).slice(0, 80) : [],
            ancestorVue: (() => {
              const result = [];
              let current = node;
              for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
                const parent = current.__vueParentComponent;
                if (parent) result.push({ tag: current.tagName, cls: current.className, keys: Object.keys(parent.ctx ?? {}).slice(0, 30) });
              }
              return result;
            })(),
          };
        })(),
      })).catch(() => null);
      await mkdir(this.paths.root, { recursive: true }).catch(() => {});
      await writeFile(`${this.paths.root}/product-scope-open-failure.json`, `${JSON.stringify(debug, null, 2)}\n`, "utf8").catch(() => {});
      throw new Error(`${label}产品范围面板等待超时`);
    };
    await openDialog();

    const activeDialog = await waitFor(currentDialog, this.config.timeouts.actionMs, `${label}当前产品范围面板`);
    await writeFile(
      `${this.paths.root}/product-scope-dialog.html`,
      await activeDialog.evaluate((element) => element.outerHTML).catch(() => ""),
      "utf8",
    ).catch(() => {});
    const scopeSelect = activeDialog.locator("input[role='combobox'], .dynamic-select").first();
    if (!(await visible(scopeSelect))) throw new Error(`${label}面板未找到产品数据下拉框`);
    await scopeSelect.click({ force: true });
    for (let contextIndex = 0; contextIndex < this.editor.contexts().length; contextIndex += 1) {
      const context = this.editor.contexts()[contextIndex];
      await writeFile(
        `${this.paths.root}/product-scope-options-${contextIndex}.html`,
        await context.locator("body").evaluate((element) => element.outerHTML).catch(() => ""),
        "utf8",
      ).catch(() => {});
    }

    const option = await waitFor(async () => {
      // Element-Plus teleports the listbox outside the side panel. Scope it
      // to visible listboxes and exclude the current “全部产品” option.
      const optionSelector = ".el-select-dropdown:visible li[role='option'], .el-select-dropdown:visible .el-select-dropdown__item, [role='listbox']:visible [role='option'], [class*='select-dropdown']:visible li, [class*='select-dropdown']:visible [role='option']";
      for (const scope of this.editor.contexts()) {
        const options = scope.locator(optionSelector);
          for (let index = 0; index < await options.count().catch(() => 0); index += 1) {
            const candidate = options.nth(index);
            const text = normalize(await candidate.innerText().catch(() => ""));
            const selected = await candidate.getAttribute("aria-selected").catch(() => "false");
            if (!text || text !== scopeLabel) continue;
            // Resume may encounter a selector whose mode has already been
            // persisted as “指定分类”. Return the selected option as an
            // idempotent match instead of filtering it out and timing out.
            if (selected === "true") return { candidate, alreadySelected: true, text };
            if (text === before.replace(/^选择产品\s*/, "")) return { candidate, alreadySelected: true, text };
            return { candidate, alreadySelected: false, text };
          }
      }
      return false;
    }, this.config.timeouts.actionMs, `${label}可选值`);

    const selected = normalize(option.text ?? await option.candidate.innerText().catch(() => ""));
    // Clicking even the current option closes this teleported mode menu.
    await option.candidate.click({ timeout: this.config.timeouts.actionMs });
    if (scopeLabel === "指定分类" && category?.name) {
      const dialogAfterScope = await waitFor(currentDialog, this.config.timeouts.actionMs, `${label}分类选择面板`);
      // This dialog has one combobox: the product-data mode itself. The
      // category tree loads automatically after choosing 指定分类. Clicking
      // that combobox again reopens the mode menu while the tree initializes.
      const ready = await waitForCategoryTreeReady(() => dialogAfterScope.evaluate((element, categoryName) => {
        const shown = (node) => {
          if (!node || !node.getClientRects().length) return false;
          const style = getComputedStyle(node);
          return style.display !== "none" && style.visibility !== "hidden";
        };
        const input = element.querySelector("input[role='combobox']");
        const nodes = [...element.querySelectorAll(".el-tree-node")].filter(shown).map((node) => ({
          key: node.getAttribute("data-key"),
          label: node.querySelector(":scope > .el-tree-node__content .el-tree-node__label")?.textContent?.trim() ?? "",
          disabled: node.getAttribute("aria-disabled") === "true" || node.querySelector(":scope > .el-tree-node__content .el-checkbox")?.classList.contains("is-disabled") === true,
        }));
        return {
          mode: input?.value?.trim() ?? "",
          loading: [...element.querySelectorAll(".el-loading-mask, [aria-busy='true'], .is-loading")].some(shown),
          nodeCount: nodes.length,
          signature: nodes.map((node) => `${node.key}:${node.label}`).join("|"),
          targets: nodes.filter((node) => node.label === categoryName),
        };
      }, category.name), { timeoutMs: Math.max(20000, this.config.timeouts.actionMs) });
      if (ready.targets.length === 1) {
        await mkdir(this.paths.root, { recursive: true }).catch(() => {});
        for (const [contextIndex, scope] of this.editor.contexts().entries()) {
          await writeFile(
            `${this.paths.root}/product-scope-category-context-${contextIndex}.html`,
            await scope.locator("body").evaluate((element) => element.outerHTML).catch(() => ""),
            "utf8",
          ).catch(() => {});
        }
        const categoryTarget = await waitFor(async () => {
          const nodes = dialogAfterScope.locator(`.el-tree-node[data-key="${ready.targets[0].key}"]:visible`);
          if (await nodes.count() !== 1) return false;
          const node = nodes.first();
          const checkbox = node.locator(":scope > .el-tree-node__content label.el-checkbox").first();
          return await visible(checkbox) ? { kind: "tree", node, checkbox } : false;
        }, this.config.timeouts.actionMs, `${label}目标分类 ${category.name}`).catch(async (error) => {
          const diagnostic = [];
          for (const [scopeIndex, scope] of this.editor.contexts().entries()) {
            const selectors = ["[role='option']", ".el-select-dropdown__item", ".el-cascader-node", ".el-tree-node", "[class*='category'] li", "[class*='classify'] li"];
            const entries = [];
            for (const selector of selectors) {
              const nodes = scope.locator(`${selector}:visible`);
              for (let index = 0, count = Math.min(await nodes.count().catch(() => 0), 100); index < count; index += 1) {
                const node = nodes.nth(index);
                entries.push({ selector, text: normalize(await node.innerText().catch(() => "")).slice(0, 200), cls: await node.getAttribute("class").catch(() => ""), value: await node.getAttribute("value").catch(() => ""), title: await node.getAttribute("title").catch(() => "") });
              }
            }
            diagnostic.push({ scopeIndex, url: scope.url?.() ?? "", entries });
          }
          await writeFile(`${this.paths.root}/product-scope-category-failure.json`, `${JSON.stringify({ target: category.name, diagnostic, reason: error.message }, null, 2)}\n`, "utf8").catch(() => {});
          await this.editor.page.screenshot({ path: `${this.paths.root}/product-scope-category-failure.png` }).catch(() => {});
          throw error;
        });
        const findVisibleCategoryNode = async (dialogScope = null) => {
          if (dialogScope) {
            const treeNodes = dialogScope.locator(".el-tree-node:visible");
            for (let index = 0; index < await treeNodes.count().catch(() => 0); index += 1) {
              const node = treeNodes.nth(index);
              if (normalize(await node.innerText().catch(() => "")) === category.name) return node;
            }
            return false;
          }
          for (const scope of this.editor.contexts()) {
            const treeNodes = scope.locator(".el-tree-node:visible");
            for (let index = 0; index < await treeNodes.count().catch(() => 0); index += 1) {
              const node = treeNodes.nth(index);
              if (normalize(await node.innerText().catch(() => "")) === category.name) return node;
            }
          }
          return false;
        };
        const readCategoryChecked = async (node) => node.evaluate((element) => {
          const input = element.querySelector(".el-tree-node__content input[type='checkbox']");
          const checkbox = element.querySelector(".el-tree-node__content .el-checkbox__input");
          return {
            ariaChecked: element.getAttribute("aria-checked"),
            inputChecked: input?.checked === true,
            checkboxClass: checkbox?.className ?? "",
            checked: element.getAttribute("aria-checked") === "true" || input?.checked === true || checkbox?.classList.contains("is-checked") === true,
          };
        }).catch(() => null);
        if (categoryTarget.kind === "tree") {
          if (!categoryTarget.checkbox) throw new Error(`${label}分类树节点“${category.name}”没有可操作的复选框`);
          const initiallyChecked = await readCategoryChecked(categoryTarget.node);
          const clickCategoryCheckbox = async () => {
            const inner = categoryTarget.checkbox.locator(".el-checkbox__inner").first();
            if (await visible(inner)) {
              await inner.click({ timeout: this.config.timeouts.actionMs });
            } else {
              await categoryTarget.checkbox.click({ timeout: this.config.timeouts.actionMs });
            }
          };
          const transitions = [];
          // A saved run can reopen with a checked tree node while the product
          // result is still unfiltered. Force a real UI transition instead of
          // treating the pre-existing checkmark as proof that this run
          // committed the choice: normalize to unchecked, then check it again.
          if (initiallyChecked?.checked) {
            await clickCategoryCheckbox();
            const unchecked = await waitFor(async () => {
              const value = await readCategoryChecked(categoryTarget.node);
              return value?.checked === false ? value : false;
            }, this.config.timeouts.actionMs, `${label}分类“${category.name}”取消勾选`);
            transitions.push({ action: "uncheck", checked: unchecked.checked, aria_checked: unchecked.ariaChecked });
          }
          const beforeCheck = await readCategoryChecked(categoryTarget.node);
          if (!beforeCheck?.checked) {
            await clickCategoryCheckbox();
            const checked = await waitFor(async () => {
              const value = await readCategoryChecked(categoryTarget.node);
              return value?.checked === true ? value : false;
            }, this.config.timeouts.actionMs, `${label}分类“${category.name}”勾选`);
            transitions.push({ action: "check", checked: checked.checked, aria_checked: checked.ariaChecked });
          }
          const selectionEvidence = await readCategoryChecked(categoryTarget.node);
          if (!selectionEvidence?.checked) {
            throw new Error(`${label}分类“${category.name}”点击后仍未勾选`);
          }
          // A transient checked UI is insufficient. Close the complete
          // product-selector dialog and reopen it through the same setting
          // row, matching the real persisted-selection path demonstrated by
          // Codegen. Re-read only inside the newly visible dialog so a stale
          // tree clone in another frame cannot satisfy this assertion.
          const closeSelector = async (dialogScope, suffix) => {
            const close = dialogScope.locator(".dialog_header .close, .dialog_header .el-icon, .close").first();
            if (await visible(close)) await close.click({ force: true }).catch(() => {});
            await waitFor(async () => !(await currentDialog()), this.config.timeouts.actionMs, `${label}${suffix}选择产品弹窗关闭`, 100)
              .catch(async () => {
                await this.editor.page.keyboard.press("Escape").catch(() => {});
                return waitFor(async () => !(await currentDialog()), 1000, `${label}${suffix}选择产品弹窗关闭重试`, 100);
              });
          };
          await closeSelector(dialogAfterScope, "勾选后");
          await openDialog();
          const reopenedDialog = await waitFor(currentDialog, this.config.timeouts.actionMs, `${label}重开后的选择产品弹窗`);
          // The “指定分类” mode control belongs to the sidebar row, outside
          // the nested “选择产品” dialog. Read it from that row after reopen;
          // the dialog itself contains the category tree and search field only.
          const reopenedText = normalize(await this.readRow(row));
          if (!reopenedText.includes("指定分类")) {
            throw new Error(`${label}关闭重开后产品数据模式不再是“指定分类”`);
          }
          let reopenedCategoryNode = await findVisibleCategoryNode(reopenedDialog);
          if (!reopenedCategoryNode) {
            const reopenedChooser = reopenedDialog.locator("input[role='combobox'], .dynamic-select").last();
            if (!(await visible(reopenedChooser))) throw new Error(`${label}重开后未找到分类选择控件`);
            await reopenedChooser.click({ force: true });
            reopenedCategoryNode = await waitFor(() => findVisibleCategoryNode(reopenedDialog), this.config.timeouts.actionMs, `${label}重开后分类“${category.name}”选项`);
          }
          const reopenedEvidence = await readCategoryChecked(reopenedCategoryNode);
          await mkdir(this.paths.root, { recursive: true }).catch(() => {});
          categorySelectionEvidence = {
            category: category.name,
            category_id: ready.targets[0].key,
            list_readiness: ready,
            initially_checked_at_start: initiallyChecked?.checked === true,
            transitions,
            checked_before_close: selectionEvidence.checked === true,
            checked_after_dialog_reopen: reopenedEvidence?.checked === true,
            aria_checked_after_dialog_reopen: reopenedEvidence?.ariaChecked ?? null,
            input_checked_after_dialog_reopen: reopenedEvidence?.inputChecked ?? false,
            checkbox_class_after_dialog_reopen: reopenedEvidence?.checkboxClass ?? "",
          };
          await writeFile(`${this.paths.root}/product-scope-category-reopened.json`, `${JSON.stringify(categorySelectionEvidence, null, 2)}\n`, "utf8").catch(() => {});
          if (!reopenedEvidence?.checked) {
            await this.editor.page.screenshot({ path: `${this.paths.root}/product-scope-category-unchecked-after-reopen.png` }).catch(() => {});
            throw new Error(`${label}分类“${category.name}”关闭并重新打开后未保持勾选；停止，不点击最终应用`);
          }
          await closeSelector(reopenedDialog, "重开核验后");
        } else {
          await categoryTarget.candidate.click({ force: true });
        }
        await waitFor(async () => normalize(await dialogAfterScope.innerText().catch(() => "")).includes(category.name), this.config.timeouts.actionMs, `${label}分类选择值`);
      } else {
        await mkdir(this.paths.root, { recursive: true }).catch(() => {});
        await writeFile(`${this.paths.root}/product-scope-after-category-mode.html`, await dialogAfterScope.evaluate((element) => element.outerHTML).catch(() => ""), "utf8").catch(() => {});
        throw new Error(`${label}选择指定分类后未出现分类选择控件`);
      }
    }
    // A resume can reopen a setting whose mode is already “指定分类”.  In
    // that case the sidebar row text is expected to remain unchanged even
    // though the nested category checkbox has just been verified across a
    // close/reopen. Treat that persisted checkbox + selected mode as the
    // state transition; the actual rendered product IDs are asserted after
    // committing the block editor.
    const after = await waitFor(async () => {
      const value = await this.readRow(row);
      const modeConfirmed = value && value.includes(scopeLabel);
      const categoryConfirmed = scopeLabel !== "指定分类"
        || !category?.name
        || categorySelectionEvidence?.checked_after_dialog_reopen === true;
      if (modeConfirmed && categoryConfirmed && (value !== before || scopeLabel === "指定分类")) return value;
      return false;
    }, this.config.timeouts.actionMs, `${label}值变化`);
    // Choosing a product-data mode opens a nested selector drawer.  Close it
    // explicitly before moving to the next setting; otherwise its teleported
    // options can intercept the next dropdown operation.
    const nestedClose = activeDialog.locator(".dialog_header .close, .dialog_header .el-icon, .close").first();
    if (await visible(nestedClose)) {
      await nestedClose.click({ force: true }).catch(() => {});
      await waitFor(async () => !(await currentDialog()), this.config.timeouts.actionMs, `${label}面板关闭`, 100).catch(() => {});
    }
    // The custom dialog sometimes ignores the icon click while its Vue
    // transition is still running. Escape closes only this nested selector
    // and prevents its teleported option tree from affecting the next row.
    if (await currentDialog()) {
      await this.editor.page.keyboard.press("Escape").catch(() => {});
      await waitFor(async () => !(await currentDialog()), 1000, `${label}面板关闭重试`, 100).catch(() => {});
    }
    if (scopeLabel === "指定分类" && category?.name && categorySelectionEvidence?.checked_after_dialog_reopen !== true) {
      throw new Error(`${label}分类“${category.name}”没有关闭重开后的勾选证据，拒绝标记设置成功`);
    }
    return { key: "product_scope", label, before, selected: category?.name ? `${selected} — ${category.name}` : selected, after, category_selection: categorySelectionEvidence, status: "succeeded", changed_at: new Date().toISOString(), failure_reason: "" };
  }

  async changeSlider(panel, key, label, record) {
    const row = await this.settingsRow(panel, label);
    const before = await this.readRow(row);
    // This control exposes an editable number field to the right of the
    // slider. Prefer that user-facing field: it is faster and avoids
    // synthetic range-value mutation that can bypass the editor's handlers.
    const numericInput = await firstVisible([
      row.locator("input[type='number']").first(),
      row.locator("input[role='spinbutton']").first(),
      row.locator("input:not([type='range']):not([type='checkbox']):not([type='radio'])").last(),
    ]);
    if (numericInput) {
      const raw = await numericInput.inputValue().catch(() => "");
      const current = Number(raw);
      if (!Number.isFinite(current)) throw new Error(`${label}右侧数量输入框当前值不是数字：${raw}`);
      const bounds = await numericInput.evaluate((element) => ({
        min: Number(element.min || element.getAttribute("min") || 0),
        max: Number(element.max || element.getAttribute("max") || Number(element.value) + 1),
        step: Number(element.step || element.getAttribute("step") || 1),
      }));
      const next = Number(this.mode.expectedPageSize ?? 5);
      if (next < bounds.min || next > bounds.max) throw new Error(`${label}不支持目标数量 ${next}（范围 ${bounds.min}–${bounds.max}）`);
      applyMidsceneEvidence(this.settingRecord(record, key), { source: "playwright", duration_ms: 0, rect: null });
      if (current !== next) {
        await numericInput.fill(String(next), { timeout: this.mode.midsceneFallback?.domFastPathTimeoutMs ?? 2000 });
        await numericInput.press("Enter").catch(() => {});
        await numericInput.blur().catch(() => {});
      }
      const after = await waitFor(async () => {
        const inputValue = Number(await numericInput.inputValue().catch(() => NaN));
        return inputValue === next ? String(inputValue) : false;
      }, this.config.timeouts.actionMs, `${label}右侧输入值变化`);
      return { key, label, before, selected: after, after, input_before: raw, input_selected: String(next), status: "pending", changed_at: new Date().toISOString(), failure_reason: "", effect_status: "pending" };
    }
    const slider = await firstVisible([row.locator("input[type='range']").first(), row.locator("[role='slider']").first()]);
    if (!slider) {
      if (!this.midscene.isEnabled()) throw new Error(`产品列表设置项 ${label} 未找到滑块`);
      const setting = this.settingRecord(record, key);
      try {
        const evidence = await this.midscene.locate(key, "产品列表设置右侧侧边栏中‘每页展示数量’的滑块控件");
        const [x, y] = evidence.center;
        await this.editor.page.mouse.move(x, y);
        await this.editor.page.mouse.down();
        await this.editor.page.mouse.move(x + 24, y, { steps: 5 });
        await this.editor.page.mouse.up();
        applyMidsceneEvidence(setting, evidence);
        const after = await waitFor(async () => {
          const value = await this.readRow(row);
          return value && value !== before ? value : false;
        }, this.config.timeouts.actionMs, `${label}值变化`);
        return { key, label, before, selected: after, after, status: "pending", changed_at: new Date().toISOString(), failure_reason: "", effect_status: "pending" };
      } catch (error) {
        applyMidsceneFailure(setting, error);
        throw error;
      }
    }
    applyMidsceneEvidence(this.settingRecord(record, key), { source: "playwright", duration_ms: 0, rect: null });
    const next = await slider.evaluate((element, requested) => {
      const value = Number(element.value ?? element.getAttribute("aria-valuenow") ?? 0);
      const min = Number(element.min ?? element.getAttribute("aria-valuemin") ?? 0);
      const max = Number(element.max ?? element.getAttribute("aria-valuemax") ?? value + 1);
      if (requested < min || requested > max) throw new Error(`requested value ${requested} outside slider range ${min}-${max}`);
      return requested;
    }, Number(this.mode.expectedPageSize ?? 5));
    const box = await slider.boundingBox().catch(() => null);
    if (!box) throw new Error(`${label}滑块没有可交互区域`);
    const min = Number(await slider.getAttribute("min").catch(() => "0"));
    const max = Number(await slider.getAttribute("max").catch(() => String(next)));
    const current = Number(await slider.inputValue().catch(() => before.match(/-?\d+(?:\.\d+)?/)?.[0] ?? min));
    const ratio = max > min ? (next - min) / (max - min) : 0;
    const currentRatio = max > min ? (current - min) / (max - min) : 0;
    await this.editor.page.mouse.move(box.x + box.width * currentRatio, box.y + box.height / 2);
    await this.editor.page.mouse.down();
    await this.editor.page.mouse.move(box.x + box.width * ratio, box.y + box.height / 2, { steps: 5 });
    await this.editor.page.mouse.up();
    const after = await waitFor(async () => {
      const value = await this.readRow(row);
      return value && value !== before ? value : false;
    }, this.config.timeouts.actionMs, `${label}值变化`);
    return { key, label, before, selected: after, after, status: "succeeded", changed_at: new Date().toISOString(), failure_reason: "" };
  }

  async toggleDisplayContent(panel, key, label, record) {
    const row = await this.settingsRow(panel, label);
    const popupVisible = async () => {
      for (const scope of this.editor.contexts()) {
        const groups = scope.locator(".lead-ed-content-checkbox:visible");
        for (let index = 0; index < await groups.count().catch(() => 0); index += 1) {
          const title = normalize(await groups.nth(index).locator(".lead-ed-content-checkbox-label").innerText().catch(() => ""));
          if (title === "显示字段") return true;
        }
      }
      return false;
    };
    if (!(await popupVisible())) {
      const trigger = await firstVisible([row.locator("button").last(), row]);
      await this.clickWithLocatorFallback(
        record,
        key,
        trigger,
        "产品列表设置右侧侧边栏中‘展示内容’的配置入口",
        popupVisible,
      );
    }
    const beforeFields = await this.readDisplayFields({ groupLabel: "显示字段" });
    const rating = beforeFields.find((item) => item.label === (this.mode.displayFieldLabel ?? "星级评价"));
    if (!rating) throw new Error(`${label}未找到“${this.mode.displayFieldLabel ?? "星级评价"}”字段`);
    if (!rating.checked) throw new Error(`${label}基线“${rating.label}”本来就未显示，无法验证关闭效果`);
    const before = beforeFields.filter((item) => item.checked).map((item) => item.label).join(" | ");
    const option = await waitFor(async () => {
      for (const scope of this.editor.contexts()) {
        const groups = scope.locator(".lead-ed-content-checkbox:visible");
        for (let groupIndex = 0; groupIndex < await groups.count().catch(() => 0); groupIndex += 1) {
          const group = groups.nth(groupIndex);
          const groupLabel = normalize(await group.locator(".lead-ed-content-checkbox-label, .title, .label").first().innerText().catch(() => ""));
          if (groupLabel !== "显示字段") continue;
          const labels = group.locator("label.el-checkbox");
        for (let index = 0; index < await labels.count().catch(() => 0); index += 1) {
          const candidate = labels.nth(index);
          const input = candidate.locator("input[type='checkbox']").first();
          const name = normalize(await candidate.locator(".el-checkbox__label").innerText().catch(() => ""));
          if (name === (this.mode.displayFieldLabel ?? "星级评价")) {
            return { scope, group, label: candidate, input, name, wasChecked: await input.isChecked().catch(() => false) };
          }
        }
        }
      }
      return false;
    }, this.config.timeouts.actionMs, `${label}可选字段`);
    if (!option.name) throw new Error(`${label}未读取到可切换字段名称`);
    if (!option.wasChecked) throw new Error(`${label}“${option.name}”已经关闭，拒绝切换其他字段代替目标字段`);
    await option.label.click({ force: true });
    await waitFor(async () => !(await option.input.isChecked().catch(() => true)), this.config.timeouts.actionMs, `${label}字段取消勾选`);
    const afterFields = await this.readDisplayFields({ groupLabel: "显示字段" });
    const after = afterFields.filter((item) => item.checked).map((item) => item.label).join(" | ");
    if (afterFields.find((item) => item.label === option.name)?.checked !== false || after === before) throw new Error(`${label}字段取消勾选后状态未变化`);
    const close = option.scope.locator(".box_body.dialog_wrap:visible .dialog_header .close").first();
    if (await visible(close)) {
      await close.click({ force: true }).catch(() => {});
      await waitFor(async () => !(await option.scope.locator(".box_body.dialog_wrap:visible").count().catch(() => 0)), 1500, `${label}弹层关闭`, 100).catch(() => {});
    }
    return { key, label, before, selected: `${option.name}: off`, after, status: "succeeded", changed_at: new Date().toISOString(), failure_reason: "", effect_status: "pending" };
  }

  async readDisplayFields({ groupLabel = "显示字段" } = {}) {
    for (const scope of this.editor.contexts()) {
      const groups = scope.locator(".lead-ed-content-checkbox:visible");
      for (let groupIndex = 0; groupIndex < await groups.count().catch(() => 0); groupIndex += 1) {
        const popup = groups.nth(groupIndex);
        const title = normalize(await popup.locator(".lead-ed-content-checkbox-label, .title, .label").first().innerText().catch(() => ""));
        if (title !== groupLabel) continue;
        const labels = popup.locator("label.el-checkbox");
        const values = [];
        for (let index = 0; index < await labels.count().catch(() => 0); index += 1) {
          const candidate = labels.nth(index);
          values.push({
            label: normalize(await candidate.locator(".el-checkbox__label").innerText().catch(() => "")),
            checked: await candidate.locator("input[type='checkbox']").isChecked().catch(() => false),
          });
        }
        if (values.length) return values;
      }
    }
    return [];
  }

  async chooseColor(panel, key, label, record) {
    const row = await this.settingsRow(panel, label);
    const expectedHex = String(this.mode.targetColorHex ?? "#2458D3").toUpperCase();
    let beforePreview = await this.readRenderedProductColors();
    if (!beforePreview.length) beforePreview = (await this.productListSnapshot()).colors;
    if (!beforePreview.length) throw new Error(`${label}修改前未读取到产品卡片 CTA 的实际颜色`);
    if (beforePreview.some((color) => color.replace(/\s/g, "").toLowerCase() === hexToRgb(expectedHex).replace(/\s/g, "").toLowerCase())) {
      throw new Error(`${label}目标颜色 ${expectedHex} 已经生效，无法证明此次变更`);
    }
    const palette = row.locator(".block-color-match");
    if (!(await palette.count().catch(() => 0))) throw new Error(`${label}未找到颜色方案或自定义颜色入口`);
    // The first palette swatch opens the editor's custom color picker; the
    // rendered CTA is still green at this point. Changing the swatch selection
    // alone is not accepted as a result-level assertion.
    await palette.first().click({ force: true });
    const hexInput = await waitFor(async () => {
      for (const scope of this.editor.contexts()) {
        const inputs = scope.locator("input:not([type='checkbox']):not([type='radio']):visible");
        for (let index = 0; index < await inputs.count().catch(() => 0); index += 1) {
          const input = inputs.nth(index);
          const value = await input.inputValue().catch(() => "");
          if (!/^#[0-9a-f]{6}$/i.test(value)) continue;
          const parentText = normalize(await input.locator("xpath=ancestor::*[.//*[normalize-space()='HEX']][1]").innerText().catch(() => ""));
          const className = await input.evaluate((node) => {
            let parent = node;
            const classes = [];
            for (let depth = 0; parent && depth < 5; depth += 1, parent = parent.parentElement) classes.push(String(parent.className ?? ""));
            return classes.join(" ");
          }).catch(() => "");
          if (/HEX/.test(parentText) || /color|picker/i.test(className)) return input;
        }
      }
      return false;
    }, this.config.timeouts.actionMs, `${label}HEX颜色输入框`);
    const setting = this.settingRecord(record, key);
    applyMidsceneEvidence(setting, { source: "playwright", duration_ms: 0, rect: null });
    await hexInput.fill(expectedHex);
    await hexInput.press("Enter").catch(() => {});
    const pickerValue = await waitFor(async () => {
      const value = await hexInput.inputValue().catch(() => "");
      return value.toUpperCase() === expectedHex ? value : false;
    }, this.config.timeouts.actionMs, `${label}HEX输入更新`);
    // Do not send Escape here: block selection itself is what opens the
    // product-list sidebar on the current 3.0 editor. Escape clears that
    // selection and made every subsequent toolbar fallback ineffective.
    return {
      key,
      label,
      before: beforePreview.join(" | "),
      selected: expectedHex,
      after: pickerValue,
      status: "succeeded",
      changed_at: new Date().toISOString(),
      failure_reason: "",
      effect_status: "pending",
      effect_before: { rendered_colors: beforePreview },
      effect_after: { target_hex: expectedHex, expected_rendered_rgb: hexToRgb(expectedHex) },
    };
  }

  async readRenderedProductColors() {
    const colors = [];
    for (const { wrapper } of await this.blockMatches()) {
      const block = await this.productBlockLocator(wrapper);
      if (!(await visible(block))) continue;
      const values = await block.locator("button, a, [class*='button'], [class*='btn']").evaluateAll((nodes) => nodes
        .map((node) => getComputedStyle(node).backgroundColor)
        .filter((color) => color && color !== "rgba(0, 0, 0, 0)" && color !== "transparent"),
      ).catch(() => []);
      colors.push(...values);
    }
    return [...new Set(colors)];
  }

  async productListSnapshot() {
    for (const scope of this.editor.contexts()) {
      const blocks = scope.locator("[data-block-uuid='ai-productlist'], .ai-generated-block");
      for (let index = 0; index < await blocks.count().catch(() => 0); index += 1) {
        const block = blocks.nth(index);
        if (!(await visible(block))) continue;
        const cards = normalizeProductCards(await block.locator("li.prodlist-site-block").evaluateAll((nodes) => nodes
          .filter((node) => {
            const style = getComputedStyle(node);
            const rect = node.getBoundingClientRect();
            return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
          })
          .map((node) => ({
            id: node.getAttribute("data-pid") || "",
            name: node.querySelector(".titleLabel .heading5, .titleLabel, .prodlist-site-block-name")?.textContent || node.querySelector(".product-image")?.getAttribute("title") || "",
            href: node.querySelector(".titleLabel, .product-image")?.getAttribute("href") || "",
          }))).catch(() => []));
        if (!cards.length) continue;
        const meta = await block.evaluate((node) => {
          const read = (name) => node.querySelector(`input[name='${name}']`)?.value ?? "";
          return {
            total: Number(read("totalRow")) || 0,
            page: Number(read("pageNumber")) || 1,
            pageSize: Number(read("pageSize")) || 0,
            layoutStyle: read("layoutStyle"),
            jumpMethod: read("jumpMethod"),
            dataType: read("dataType"),
            dataIds: read("dataIds"),
            dataGroupId: read("dataGroupId"),
            orderBy: read("orderBy"),
          };
        }).catch(() => ({}));
        const cardNodes = block.locator("li.prodlist-site-block");
        let ratingVisible = false;
        let ratingCount = 0;
        for (let cardIndex = 0; cardIndex < await cardNodes.count().catch(() => 0); cardIndex += 1) {
          const rating = cardNodes.nth(cardIndex).locator(".solar-rating .prodlist-site-rate");
          if (await visible(rating) && (await rating.innerText().catch(() => "")).trim()) {
            ratingVisible = true;
            ratingCount += 1;
          }
        }
        const colors = await block.locator(".prodlist-site-buttons a, .prodlist-site-buttons .text-wrap").evaluateAll((nodes) => nodes
          .map((node) => getComputedStyle(node).backgroundColor)
          .filter((color) => color && color !== "rgba(0, 0, 0, 0)" && color !== "transparent"),
        ).catch(() => []);
        const pager = await block.evaluate((node) => {
          const parent = node.closest(".siteblocks-setting-wrap")?.parentElement ?? node.parentElement;
          const controls = [...(parent?.querySelectorAll(".el-pagination, .pagination, [class*='pagination'], [class*='pagebar']") ?? [])]
            .filter((element) => {
              const rect = element.getBoundingClientRect();
              const style = getComputedStyle(element);
              return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
            });
          return { visible: controls.length > 0, text: controls.map((element) => element.innerText).join(" ").replace(/\\s+/g, " ").trim() };
        }).catch(() => ({ visible: false, text: "" }));
        return { cards, meta, rating_visible: ratingVisible, rating_count: ratingCount, colors: [...new Set(colors)], pager, context_url: scope.url?.() ?? "", block };
      }
    }
    throw new Error("产品列表区块中未读取到可见产品卡片");
  }

  async readBackendProductCatalog({ includeCategoryFilter = true } = {}) {
    const helper = new DetailContentBrowser(this.editor.page.context(), this.config);
    try {
      const backend = await helper.open();
      const url = new URL(backend.url());
      url.pathname = "/phoenix/website";
      url.search = "?module=prod";
      await backend.goto(url.toString(), { waitUntil: "domcontentloaded" });
      await backend.locator("iframe#prod").waitFor({ state: "visible", timeout: this.config.timeouts.blockRenderMs });
      const frame = backend.locator("iframe#prod").contentFrame();
      await frame.getByRole("link", { name: "管理产品", exact: true }).click();
      const rows = frame.locator("tr").filter({ has: frame.locator("input[name='dataId']") });
      await waitFor(async () => (await rows.count().catch(() => 0)) > 0, this.config.timeouts.blockRenderMs, "后台产品数据行");
      const requestedCategoryName = String(this.mode.productScopeCategoryName ?? "").trim();
      const readRows = async () => frame.locator("tr").evaluateAll((items, targetCategory) => items
        .filter((row) => row.querySelector("input[name='dataId']") && row.getBoundingClientRect().height > 0)
        .map((row) => {
          const table = row.closest("table");
          const headerRow = table ? [...table.querySelectorAll("tr")].find((candidate) => candidate.querySelector("th") && !candidate.querySelector("input[name='dataId']")) : null;
          const headers = [...(headerRow?.querySelectorAll("th, td") ?? [])]
            .map((cell) => (cell.innerText ?? "").replace(/\\s+/g, " ").trim());
          const categoryIndexes = headers.flatMap((header, index) => /分类|类别/.test(header) ? [index] : []);
          const categories = categoryIndexes.flatMap((index) => {
            const cell = row.cells[index];
            if (!cell) return [];
            const titled = [...cell.querySelectorAll("[title]")].map((item) => item.title).filter(Boolean);
            return titled.length ? titled : [cell.innerText.replace(/\\s+/g, " ").trim()].filter(Boolean);
          });
          if (targetCategory) {
            const exactCategoryTitles = [...row.querySelectorAll("[title]")]
              .map((item) => item.getAttribute("title") ?? "")
              .filter((title) => title.normalize("NFKC").replace(/\s+/g, " ").trim() === targetCategory.normalize("NFKC").replace(/\s+/g, " ").trim());
            categories.push(...exactCategoryTitles);
          }
          return {
            id: row.querySelector("input[name='dataId']")?.value ?? "",
            name: row.querySelector("a[prodid][title]")?.title ?? "",
            categories,
          };
        })
        .filter((item) => item.id && item.name), requestedCategoryName);
      const baseline = await readRows();
      if (baseline.length < 2) throw new Error(`后台产品数据不足：只读取到 ${baseline.length} 条`);
      if (!includeCategoryFilter) {
        const catalog = {
          source: "site-content-management-product-list",
          products: baseline,
          categories: [],
          selected_category: null,
          captured_at: new Date().toISOString(),
          status: "category-skipped",
          failure_reason: "本轮按要求跳过产品分类设置项，仅使用后台产品 ID 验证分页和平铺结果",
        };
        this.record().catalog = catalog;
        await this.persist();
        return catalog;
      }
      if (requestedCategoryName) {
        // Some content-backend builds leave the category filter permanently
        // in “分类加载中...” even though each product row already exposes its
        // assigned category. For a specifically requested category, use the
        // complete visible product table as the source of truth when its
        // exact category membership is uniquely observable; the generated
        // block's own selector will still select that category by name.
        const normalizeCategoryName = (value) => String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
        const targetProducts = baseline.filter((product) => product.categories.some((name) => normalizeCategoryName(name) === normalizeCategoryName(requestedCategoryName)));
        if (targetProducts.length > 0 && targetProducts.length < baseline.length) {
          const catalog = {
            source: "site-content-management-product-category-column",
            products: baseline,
            categories: [{ id: "", name: requestedCategoryName, depth: "row-membership", product_ids: targetProducts.map((item) => item.id), result_count: targetProducts.length }],
            selected_category: { id: "", name: requestedCategoryName, products: targetProducts },
            captured_at: new Date().toISOString(),
            status: "succeeded",
            failure_reason: "后台分类筛选控件未加载；使用后台产品表格中的逐产品分类字段交叉校验",
          };
          this.record().catalog = catalog;
          await this.persist();
          return catalog;
        }
      }
      const trigger = frame.locator("a[action='dropdown_classification_prod_new']");
      const menu = frame.locator("ul.imitateSelect");
      await trigger.click({ force: true });
      await waitFor(async () => {
        const menuText = normalize(await menu.innerText().catch(() => ""));
        const options = menu.locator(requestedCategoryName ? "li[valueid]" : "li[valueid][name='2']");
        return (await options.count().catch(() => 0)) > 0 && !/分类加载中|加载中/.test(menuText);
      }, this.config.timeouts.blockRenderMs, "后台可筛选末级产品分类加载完成");
      const categoryOptionSelector = requestedCategoryName ? "li[valueid]" : "li[valueid][name='2']";
      const categories = await menu.locator(categoryOptionSelector).evaluateAll((items) => items
        .map((item) => ({ id: item.getAttribute("valueid") ?? "", name: item.innerText.replace(/\s+/g, " ").trim(), depth: item.getAttribute("name") ?? "" }))
        .filter((item) => item.id && item.name));
      if (categories.length === 0) {
        await mkdir(this.paths.root, { recursive: true }).catch(() => {});
        await writeFile(`${this.paths.root}/backend-category-filter-debug.html`, await frame.locator("body").innerHTML().catch(() => ""), "utf8").catch(() => {});
        await backend.screenshot({ path: `${this.paths.root}/backend-category-filter-debug.png`, fullPage: false }).catch(() => {});
        throw new Error("后台产品分类菜单打开后未加载出可筛选的末级分类；已保存后台页面诊断证据");
      }
      const normalizeCategoryName = (value) => String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
      const requestedCategory = requestedCategoryName
        ? categories.filter((item) => normalizeCategoryName(item.name) === normalizeCategoryName(requestedCategoryName))
        : null;
      if (requestedCategoryName && requestedCategory.length !== 1) {
        this.record().catalog = {
          ...this.record().catalog,
          products: baseline,
          categories,
          captured_at: new Date().toISOString(),
          status: "requested-category-not-found",
          failure_reason: `后台分类“${requestedCategoryName}”唯一匹配失败：${requestedCategory.length} 个`,
        };
        await this.persist();
        throw new Error(`后台产品分类“${requestedCategoryName}”唯一匹配失败：${requestedCategory.length} 个；可用分类=${categories.map((item) => `${item.name}(depth=${item.depth})`).join(" | ")}`);
      }
      const waitForRowsSettled = async () => {
        // The backend performs its query asynchronously and can leave the old
        // rows in place for the first few hundred milliseconds. Keep a short
        // minimum window before accepting a stable fingerprint so an
        // unchanged pre-query table is not mistaken for the selected result.
        await backend.waitForTimeout(750);
        let previous = "";
        let stable = 0;
        return waitFor(async () => {
          const currentRows = await readRows();
          const fingerprint = currentRows.map((item) => item.id).join(",");
          stable = fingerprint === previous ? stable + 1 : 0;
          previous = fingerprint;
          const loading = await frame.locator(".loading:visible, .el-loading-mask:visible, [aria-busy='true']:visible").count().catch(() => 0);
          return stable >= 3 && loading === 0 ? currentRows : false;
        }, this.config.timeouts.blockRenderMs, "后台分类筛选结果稳定", 250);
      };
      const filtered = [];
      const categoriesToQuery = requestedCategory ?? categories;
      for (const category of categoriesToQuery) {
        const isOpen = await menu.evaluate((node) => getComputedStyle(node).display !== "none").catch(() => false);
        if (!isOpen) await trigger.click({ force: true });
        await waitFor(async () => {
          const text = normalize(await menu.innerText().catch(() => ""));
          return !/分类加载中|加载中/.test(text) && (await menu.locator(`li[valueid="${category.id}"]`).count().catch(() => 0)) === 1;
        }, this.config.timeouts.blockRenderMs, `后台分类“${category.name}”可选`);
        await menu.locator(`li[valueid="${category.id}"]`).click({ force: true });
        await waitFor(async () => normalize(await trigger.innerText().catch(() => "")).includes(category.name), this.config.timeouts.actionMs, `后台已选择分类“${category.name}”`);
        await frame.locator("a.filterBtn").click({ force: true });
        const products = await waitForRowsSettled();
        filtered.push({ ...category, selected_in_filter: true, products });
        if (products.length && products.length < baseline.length) break;
      }
      const baselineIds = new Set(baseline.map((item) => item.id));
      const selected = requestedCategoryName
        ? filtered.find((category) => normalizeCategoryName(category.name) === normalizeCategoryName(requestedCategoryName)
          && category.products.length > 0
          && category.products.length < baseline.length
          && category.products.every((product) => baselineIds.has(product.id)))
        : filtered.find((category) => category.products.length > 0 && category.products.length < baseline.length && category.products.every((product) => baselineIds.has(product.id)));
      const catalog = {
        source: "site-content-management-category-filter",
        products: baseline,
        categories: filtered.map(({ products, ...category }) => ({ ...category, product_ids: products.map((item) => item.id), result_count: products.length })),
        selected_category: selected ? { id: selected.id, name: selected.name, products: selected.products } : null,
        captured_at: new Date().toISOString(),
        status: selected ? "succeeded" : "insufficient-category-result",
        failure_reason: selected ? "" : requestedCategoryName
          ? `后台分类“${requestedCategoryName}”未筛出与全部产品不同的非空结果集`
          : "后台可选末级分类未筛出与全部产品不同的非空结果集",
      };
      this.record().catalog = catalog;
      await this.persist();
      return catalog;
    } finally {
      await helper.close();
    }
  }

  async verifyPageSizeResult(record, snapshot = null) {
    const actual = snapshot ?? await this.productListSnapshot();
    assertPageSize(actual.cards, Number(this.mode.expectedPageSize ?? 5));
    if (actual.meta.pageSize && actual.meta.pageSize !== Number(this.mode.expectedPageSize ?? 5)) {
      throw new Error(`产品列表配置的 pageSize 元数据不匹配：${actual.meta.pageSize}`);
    }
    const setting = this.settingRecord(record, "page_size");
    setting.effect_status = "passed";
    setting.effect_after = { count: actual.cards.length, ids: actual.cards.map((card) => card.id), configured_page_size: actual.meta.pageSize };
    record.result_checks.page_size = { status: "passed", evidence: setting.effect_after };
    return actual;
  }

  async verifySortResult(record, snapshot = null) {
    const actual = snapshot ?? await this.productListSnapshot();
    assertAscendingProductNames(actual.cards);
    const evidence = { names: actual.cards.map((card) => card.name), ids: actual.cards.map((card) => card.id) };
    const setting = this.settingRecord(record, "sort");
    setting.effect_status = "passed";
    setting.effect_after = evidence;
    record.result_checks.sort = { status: "passed", evidence };
    return actual;
  }

  async verifyRatingHidden(record, snapshot = null) {
    const actual = snapshot ?? await this.productListSnapshot();
    assertFieldVisibility(actual.rating_visible, false, this.mode.displayFieldLabel ?? "星级评价");
    const setting = this.settingRecord(record, "display_content");
    setting.effect_status = "passed";
    setting.effect_after = { rating_visible: actual.rating_visible, cards_with_rating: actual.rating_count };
    record.result_checks.display_field = { status: "passed", evidence: setting.effect_after };
    return actual;
  }

  async verifyRenderedColor(record, beforeColor, snapshot = null) {
    const actual = snapshot ?? await this.productListSnapshot();
    const afterColor = actual.colors.find((color) => color !== beforeColor);
    assertRenderedColorChanged(beforeColor, afterColor, "产品卡片 CTA 配色");
    const setting = this.settingRecord(record, "base_color");
    setting.effect_status = "passed";
    setting.effect_after = { before: beforeColor, after: afterColor, rendered_colors: actual.colors };
    record.result_checks.base_color = { status: "passed", evidence: setting.effect_after };
    return actual;
  }

  async clickProductPager(snapshot, direction) {
    const selector = direction === "next"
      ? ".el-pagination .btn-next:not(.is-disabled), .pagination .next:not(.disabled), [class*='pagination'] [aria-label*='Next']:not([disabled]), .layui-laypage-next:not(.layui-disabled)"
      : ".el-pagination .btn-prev:not(.is-disabled), .pagination .prev:not(.disabled), [class*='pagination'] [aria-label*='Previous']:not([disabled]), .layui-laypage-prev:not(.layui-disabled)";
    const control = await firstVisible([snapshot.block.locator(selector).first(), ...this.editor.contexts().map((scope) => scope.locator(selector).first())]);
    if (!control) throw new Error(`分页控件中未找到${direction === "next" ? "下一页" : "上一页"}按钮`);
    await control.click({ force: true });
    const oldPage = snapshot.meta.page;
    await waitFor(async () => {
      const current = await this.productListSnapshot().catch(() => null);
      return current && (current.meta.page !== oldPage || current.cards.map((card) => card.id).join(",") !== snapshot.cards.map((card) => card.id).join(","));
    }, this.config.timeouts.actionMs, `产品列表${direction === "next" ? "下一页" : "上一页"}渲染`);
    return this.productListSnapshot();
  }

  async readLiveProductCards(page) {
    const scopes = typeof page.frames === "function" ? [page, ...page.frames()] : [page];
    for (const scope of scopes) {
      const cards = await scope.locator("li.prodlist-site-block").evaluateAll((nodes) => nodes
        .filter((node) => {
          const style = getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        })
        .map((node) => ({
          id: node.getAttribute("data-pid") || "",
          name: node.querySelector(".titleLabel .heading5, .titleLabel, .prodlist-site-block-name")?.textContent?.replace(/\s+/g, " ").trim() || "",
        }))).catch(() => []);
      if (cards.length) {
        // Pagination is part of the product list's own document. Searching
        // every frame can accidentally pair cards from the preview iframe
        // with an unrelated visible pager in the preview chrome/parent frame;
        // that false match has no enabled “next” button and breaks interaction.
        const pagerScope = scope;
        const pagerCandidates = scope.locator(".layui-laypage, [id^='prodlist-laypage-'], .prodlist-site-pagination");
        let pager = null;
        for (let index = 0; index < await pagerCandidates.count().catch(() => 0); index += 1) {
          const candidate = pagerCandidates.nth(index);
          if (await visible(candidate)) { pager = candidate; break; }
        }
        const pagerVisible = Boolean(pager);
        const ratingVisible = await scope.locator("li.prodlist-site-block .prodlist-site-rate").evaluateAll((nodes) => nodes.some((node) => {
          const style = getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        })).catch(() => false);
        const colors = await scope.locator("li.prodlist-site-block .prodlist-site-buttons a, li.prodlist-site-block .prodlist-site-buttons .text-wrap").evaluateAll((nodes) => [...new Set(nodes
          .map((node) => getComputedStyle(node).backgroundColor)
          .filter((value) => value && value !== "rgba(0, 0, 0, 0)" && value !== "transparent"))]).catch(() => []);
        return { scope, cards, pagerVisible, pager, pagerScope, ratingVisible, colors };
      }
    }
    throw new Error("预览/公开页没有读取到可见产品卡片");
  }

  async verifyProductListPreview({ cardWaitMs = this.config.timeouts.blockRenderMs } = {}) {
    // The product-list sidebar is opened through a separate fullscreen editor
    // document. Even after its drawer closes, some builds leave that editor's
    // overlay/frame tree attached to the pagebuilder and the preview popup is
    // immediately closed by the host. The page is saved before this method is
    // called, so rebuild the editor frame tree once and verify the page
    // identity before opening preview. This also guarantees we don't reuse a
    // stale Frame/Locator from the settings flow.
    const pagebuilderUrl = this.editor.page.url();
    if (!pagebuilderUrl.includes("/phoenix/pagebuilder/")) {
      throw new Error(`预览前当前页面不是 3.0 页面构建器：${sanitizeFrameUrl(pagebuilderUrl)}`);
    }
    const reloadStartedAt = Date.now();
    await this.editor.page.reload({ waitUntil: "domcontentloaded" });
    await this.editor.page.waitForLoadState("domcontentloaded").catch(() => {});
    let pageSelectionRecovery = "reload-toolbar";
    try {
      await this.editor.waitForPageLoaded(this.state.page.name);
    } catch (reloadError) {
      // Some pagebuilder reloads restore the canvas but leave the toolbar's
      // page label empty. Re-select the exact run-owned custom page through
      // the UI, then verify its block identity below; do not infer identity
      // from the URL or continue on an unknown page.
      pageSelectionRecovery = "reselected-by-unique-page-name";
      try {
        await this.editor.openCustomPage(this.state.page.name);
        await this.editor.waitForPageLoaded(this.state.page.name);
      } catch (reselectError) {
        throw new Error(`预览前恢复测试页失败：reload=${reloadError.message}；按唯一页面名重选=${reselectError.message}`);
      }
    }
    this.record().frame_steps ??= [];
    this.record().frame_steps.push({
      step: "pagebuilder-reloaded-before-preview",
      frame_url: sanitizeFrameUrl(this.editor.page.url()),
      duration_ms: Date.now() - reloadStartedAt,
      page_name_verified: this.state.page.name,
      recovery: pageSelectionRecovery,
    });
    const pageBlockMatches = await this.blockMatches({ canvasOnly: true });
    if (pageBlockMatches.length !== 1) {
      await this.captureFrameDiagnostics("preview-page-reload-block-identity", `预览前页面重载后产品列表区块匹配数=${pageBlockMatches.length}`);
      throw new Error(`预览前页面重载后产品列表区块匹配数=${pageBlockMatches.length}，拒绝继续`);
    }
    const previewLinks = this.editor.page.locator(".clickToPreview a[target='_blank'][href]");
    const visiblePreviewLinks = [];
    for (let index = 0; index < await previewLinks.count().catch(() => 0); index += 1) {
      const link = previewLinks.nth(index);
      if (await visible(link)) visiblePreviewLinks.push(link);
    }
    if (visiblePreviewLinks.length !== 1) {
      throw new Error(`预览链接唯一匹配失败：${visiblePreviewLinks.length} 个`);
    }
    const preview = visiblePreviewLinks[0];
    const previewHref = await preview.getAttribute("href");
    if (!previewHref || !/\/phoenix\/pagebuilder\/preview(?:\?|$)/.test(previewHref)) {
      throw new Error(`预览链接目标不符合页面预览路由：${sanitizeFrameUrl(previewHref ?? "")}`);
    }
    const originalUrl = this.editor.page.url();
    const before = new Set(this.editor.page.context().pages());
    const popupEvent = this.editor.page.waitForEvent("popup", { timeout: 10000 }).catch(() => null);
    await preview.click();
    const popup = await popupEvent;
    await this.editor.page.waitForTimeout(500);
    const openedPages = [...this.editor.page.context().pages()].filter((item) => !before.has(item) && !item.isClosed());
    let previewPage = openedPages.find((item) => /\/phoenix\/pagebuilder\/preview/.test(item.url()))
      ?? (popup && !popup.isClosed() ? popup : null)
      ?? openedPages[0]
      ?? (this.editor.page.url() !== originalUrl ? this.editor.page : null);
    let previewOpenSource = "ui-popup";
    if (!previewPage && popup?.isClosed()) {
      // Some live builds create a blank popup from the preview anchor and
      // immediately close it. The UI click is still required, but once it has
      // been attempted, open only the exact, validated preview href in the
      // same authenticated context. This is not a guessed URL or an assertion
      // shortcut: all result checks below still run against rendered cards,
      // pagination, rating visibility and computed CTA colors.
      const fallbackPage = await this.editor.page.context().newPage();
      try {
        await fallbackPage.goto(previewHref, { waitUntil: "domcontentloaded", timeout: this.config.timeouts.blockRenderMs });
        if (!/\/phoenix\/pagebuilder\/preview(?:\?|$)/.test(new URL(fallbackPage.url()).pathname + new URL(fallbackPage.url()).search)) {
          throw new Error(`直接打开预览后落到非预览路由：${sanitizeFrameUrl(fallbackPage.url())}`);
        }
        previewPage = fallbackPage;
        previewOpenSource = "validated-href-fallback";
      } catch (error) {
        await fallbackPage.close().catch(() => {});
        throw new Error(`预览 popup 关闭，使用已校验链接打开也失败：${error.message}`);
      }
    }
    if (!previewPage) {
      await mkdir(this.paths.root, { recursive: true }).catch(() => {});
      const diagnostics = {
        original_url: sanitizeFrameUrl(originalUrl),
        editor_url_after_click: sanitizeFrameUrl(this.editor.page.url()),
        popup_received: Boolean(popup),
        popup_closed: popup?.isClosed() ?? null,
        popup_url: popup ? sanitizeFrameUrl(popup.url()) : null,
        preview_href: sanitizeFrameUrl(previewHref),
        opened_pages: this.editor.page.context().pages().map((item) => ({ url: sanitizeFrameUrl(item.url()), closed: item.isClosed() })),
      };
      await writeFile(`${this.paths.root}/preview-window-failure.json`, `${JSON.stringify(diagnostics, null, 2)}\n`, "utf8").catch(() => {});
      throw new Error("产品列表预览未在新页面打开，拒绝在编辑器中误判交互效果");
    }
    let previewCloseHandler;
    try {
      await previewPage.waitForLoadState("domcontentloaded").catch(() => {});
      if (previewPage.isClosed()) throw new Error("预览窗口在加载产品卡片前被关闭");
      if (!/\/phoenix\/pagebuilder\/preview(?:\?|$)/.test(previewPage.url())) {
        throw new Error(`预览窗口跳转到非预览路由：${sanitizeFrameUrl(previewPage.url())}`);
      }
      const previewClosed = new Promise((_, reject) => {
        previewCloseHandler = () => reject(new Error("预览窗口在加载产品卡片前被关闭"));
        previewPage.on("close", previewCloseHandler);
      });
      // The frame lookup can fail before Promise.race attaches a rejection
      // handler. Preserve the original failure if cleanup closes this tab.
      previewClosed.catch(() => {});
      const expectedPreviewPath = new URL(this.state.page.publicUrl).pathname;
      const resolvePreviewFrame = () => {
        return choosePreviewContentFrame(previewPage.frames(), expectedPreviewPath);
      };
      const previewReadDiagnostics = { polls: 0, lastFrameUrl: "", lastCardCount: null, lastError: "" };
      const readCurrentPreview = async () => {
        // The preview iframe can navigate/recreate after the shell loads.
        // Resolve it anew on every poll instead of retaining a Frame object
        // whose execution context may already have detached.
        previewReadDiagnostics.polls += 1;
        const currentFrame = resolvePreviewFrame();
        if (!currentFrame) {
          previewReadDiagnostics.lastFrameUrl = "<no-unique-preview-frame>";
          return false;
        }
        previewReadDiagnostics.lastFrameUrl = sanitizeFrameUrl(currentFrame.url());
        try {
          const result = await this.readLiveProductCards(currentFrame);
          previewReadDiagnostics.lastCardCount = result.cards.length;
          previewReadDiagnostics.lastError = "";
          return result;
        } catch (error) {
          previewReadDiagnostics.lastError = error.message;
          previewReadDiagnostics.lastCardCount = await currentFrame.locator("li.prodlist-site-block").count().catch(() => null);
          return false;
        }
      };
      await waitFor(() => resolvePreviewFrame(), cardWaitMs, "产品列表本站预览内容 frame", 250);
      let first = await Promise.race([
        waitFor(readCurrentPreview, cardWaitMs, "预览页产品卡片加载", 250).catch((error) => {
          throw new Error(`${error.message}；最近读取=${JSON.stringify(previewReadDiagnostics)}`);
        }),
        previewClosed,
      ]);
      if (this.mode.productScopeOnly === true) {
        const catalog = this.record().catalog;
        const expectedIds = catalog?.selected_category?.products?.map((product) => product.id) ?? [];
        const baselineIds = catalog?.products?.map((product) => product.id) ?? [];
        const expectedCount = Number(this.mode.productScopeExpectedCount);
        if (!Number.isInteger(expectedCount) || expectedCount < 1 || expectedCount !== expectedIds.length) {
          throw new Error(`预览分类测试数据不一致：配置预期 ${expectedCount} 个，后台“${catalog?.selected_category?.name ?? ""}”实际匹配 ${expectedIds.length} 个产品 ID`);
        }
        const evidence = assertExactCategoryResult(first.cards, expectedIds, baselineIds);
        const scopeEvidence = { category: catalog.selected_category.name, expected_count: expectedCount, ...evidence };
        this.record().result_checks.product_scope = {
          status: "passed",
          evidence: { ...this.record().result_checks.product_scope?.evidence, after_saved_preview: scopeEvidence },
        };
        this.record().result_checks.preview = {
          status: "passed",
          evidence: { url: previewPage.url(), open_source: previewOpenSource, product_count: first.cards.length, category: catalog.selected_category.name },
        };
        this.record().settings_reopened = true;
        this.record().settings_status = "succeeded";
        this.record().preview_verified = true;
        this.state.page.preview_verified = true;
        this.state.page.preview_url = previewPage.url();
        const scopeSetting = this.settingRecord(this.record(), "product_scope");
        scopeSetting.reopened = catalog.selected_category.name;
        scopeSetting.effect_reopened = { ...scopeSetting.effect_reopened, after_saved_preview: scopeEvidence };
        markProductScopeEffect(this.record(), scopeEvidence);
        await this.persist();
        return;
      }
      assertPageSize(first.cards, Number(this.mode.expectedPageSize ?? 5));
      assertAscendingProductNames(first.cards);
      if (!first.pagerVisible) throw new Error("预览页未显示分页控件");
      const nextSelector = ".layui-laypage-next:not(.layui-disabled), .el-pagination .btn-next:not(.is-disabled), .pagination .next:not(.disabled), [class*='pagination'] [aria-label*='Next']:not([disabled])";
      // Product cards can hydrate before the site pagination plugin finishes
      // initializing its controls. Wait for an enabled next-page control in
      // the same content frame rather than treating the visible-but-empty
      // pagination container as proof that interaction is ready.
      const next = await waitFor(async () => {
        const candidate = first.pagerScope?.locator(nextSelector).first();
        return await visible(candidate) ? candidate : false;
      }, Math.min(12000, this.config.timeouts.actionMs), "预览页可用的下一页按钮", 200).catch(async (error) => {
        const pagerDiagnostics = await first.pagerScope?.locator(".prodlist-site-pagination, .prodlist-laypage-normal, .layui-laypage, .el-pagination, .pagination, [class*='pagination']")
          .evaluateAll((nodes) => nodes.map((node) => ({
            tag: node.tagName,
            className: String(node.className ?? ""),
            id: node.id ?? "",
            text: (node.innerText ?? "").replace(/\s+/g, " ").trim(),
            html: node.outerHTML.slice(0, 4000),
            visible: (() => { const rect = node.getBoundingClientRect(); const style = getComputedStyle(node); return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"; })(),
          }))).catch(() => []);
        await writeFile(`${this.paths.root}/preview-pagination-failure.json`, `${JSON.stringify({
          frame_url: sanitizeFrameUrl(first.pagerScope?.url?.() ?? ""),
          card_count: first.cards.length,
          pager_visible: first.pagerVisible,
          pagination: pagerDiagnostics,
          reason: error.message,
        }, null, 2)}\n`, "utf8").catch(() => {});
        throw new Error(`预览页分页模式没有可用的下一页按钮：${error.message}`);
      });
      const firstIds = first.cards.map((card) => card.id).join(",");
      await next.click();
      await waitFor(async () => {
        const current = await readCurrentPreview().catch(() => null);
        return current && current.cards.map((card) => card.id).join(",") !== firstIds;
      }, this.config.timeouts.actionMs, "预览页产品翻页");
      const second = await readCurrentPreview();
      assertDistinctPages(first.cards, second.cards, Number(this.record().catalog?.products?.length) || first.cards.length + second.cards.length);
      assertAscendingProductNames([...first.cards, ...second.cards]);
      if (first.ratingVisible || second.ratingVisible) throw new Error("预览页关闭星级评价后仍渲染了评分");
      const expectedColor = hexToRgb(String(this.mode.targetColorHex ?? "#2458D3").toUpperCase()).replace(/\s/g, "").toLowerCase();
      if (![...first.colors, ...second.colors].some((color) => color.replace(/\s/g, "").toLowerCase() === expectedColor)) {
        throw new Error(`预览页产品 CTA 未渲染目标颜色 ${expectedColor}`);
      }
      const pageEvidence = {
        page_size: first.cards.length,
        first_page_ids: first.cards.map((card) => card.id),
        second_page_ids: second.cards.map((card) => card.id),
        total: Number(this.record().catalog?.products?.length) || first.cards.length + second.cards.length,
        pager_visible: first.pagerVisible,
        rating_visible: false,
        rendered_colors: [...new Set([...first.colors, ...second.colors])],
      };
      this.record().result_checks.page_size = { status: "passed", evidence: pageEvidence };
      this.record().result_checks.loading_pagination = { status: "passed", evidence: pageEvidence };
      this.record().result_checks.sort = { status: "passed", evidence: { names: [...first.cards, ...second.cards].map((item) => item.name), ids: [...first.cards, ...second.cards].map((item) => item.id) } };
      this.record().result_checks.display_field = { status: "passed", evidence: { rating_visible: false, preview_url: previewPage.url() } };
      this.record().result_checks.base_color = { status: "passed", evidence: { expected_color: expectedColor, rendered_colors: pageEvidence.rendered_colors } };
      this.record().result_checks.preview = { status: "passed", evidence: { url: previewPage.url(), open_source: previewOpenSource, product_count: first.cards.length } };
      this.record().result_checks.after_reopen = { status: "passed", evidence: { source: "saved-page-preview", page_size: first.cards.length, sort_verified_across_pages: true, rating_visible: false, rendered_colors: pageEvidence.rendered_colors, pager_visible: first.pagerVisible } };
      this.record().settings_reopened = true;
      for (const [key, check] of Object.entries({
        sort: "sort",
        loading: "loading_pagination",
        page_size: "page_size",
        display_content: "display_field",
        base_color: "base_color",
      })) {
        if (this.record().result_checks[check]?.status === "passed") this.settingRecord(this.record(), key).status = "succeeded";
      }
      for (const item of this.record().settings) {
        item.reopened = item.key === "product_scope" ? (this.mode.skipProductScope ? "skipped" : "全部产品")
          : item.key === "sort" ? "按照产品名称升序"
            : item.key === "loading" ? "分页"
              : item.key === "page_size" ? String(first.cards.length)
                : item.key === "display_content" ? `${this.mode.displayFieldLabel}: off`
                  : item.key === "base_color" ? pageEvidence.rendered_colors.join(" | ") : item.reopened;
        item.effect_reopened = { ...item.effect_reopened, after_saved_preview: true };
      }
      this.record().preview_verified = true;
      this.state.page.preview_verified = true;
      this.state.page.preview_url = previewPage.url();
      await this.persist();
    } catch (error) {
      await mkdir(this.paths.root, { recursive: true }).catch(() => {});
      const previewDiagnostics = {
        url: previewPage.url(),
        closed: previewPage.isClosed(),
        bodyText: normalize(await previewPage.locator("body").innerText().catch(() => "")).slice(0, 2000),
        frames: previewPage.frames().map((frame) => ({ url: sanitizeFrameUrl(frame.url()), bodyText: "", productCardCount: 0, visibleProductCardCount: 0 })),
        reason: error.message,
      };
      for (const [index, frame] of previewPage.frames().entries()) {
        const entry = previewDiagnostics.frames.find((item) => item.url === sanitizeFrameUrl(frame.url()));
        if (entry) {
          entry.bodyText = normalize(await frame.locator("body").innerText().catch(() => "")).slice(0, 1000);
          const cards = frame.locator("li.prodlist-site-block");
          entry.productCardCount = await cards.count().catch(() => 0);
          entry.visibleProductCardCount = await cards.evaluateAll((nodes) => nodes.filter((node) => {
            const style = getComputedStyle(node);
            const rect = node.getBoundingClientRect();
            return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
          }).length).catch(() => 0);
          await writeFile(`${this.paths.root}/preview-frame-${index}.html`, await frame.locator("body").innerHTML().catch(() => ""), "utf8").catch(() => {});
        }
      }
      await writeFile(`${this.paths.root}/preview-failure.html`, await previewPage.locator("body").innerHTML().catch(() => ""), "utf8").catch(() => {});
      await writeFile(`${this.paths.root}/preview-failure.json`, `${JSON.stringify(previewDiagnostics, null, 2)}\n`, "utf8").catch(() => {});
      await previewPage.screenshot({ path: `${this.paths.root}/preview-failure.png`, fullPage: false }).catch(() => {});
      if (previewPage !== this.editor.page) {
        await this.editor.page.screenshot({ path: `${this.paths.root}/preview-editor-failure.png`, fullPage: false }).catch(() => {});
      }
      this.record().result_checks.preview = { status: "failed", evidence: { url: previewPage.url(), reason: error.message } };
      await this.persist();
      throw error;
    } finally {
      if (previewCloseHandler) previewPage.off("close", previewCloseHandler);
      if (previewPage === this.editor.page) {
        await previewPage.goBack({ waitUntil: "domcontentloaded" }).catch(async () => { await previewPage.goto(originalUrl, { waitUntil: "domcontentloaded" }).catch(() => {}); });
      } else if (!previewPage.isClosed()) {
        await previewPage.close().catch(() => {});
      }
    }
  }

  async verifyProductListPreviewWithRetry() {
    const attempts = [];
    const maxAttempts = 6;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const startedAt = Date.now();
      try {
        await this.verifyProductListPreview({ cardWaitMs: Math.min(30000, this.config.timeouts.blockRenderMs) });
        attempts.push({ attempt, status: "passed", duration_ms: Date.now() - startedAt, checked_at: new Date().toISOString() });
        this.record().preview_attempts = attempts;
        await this.persist();
        return;
      } catch (error) {
        attempts.push({ attempt, status: "failed", duration_ms: Date.now() - startedAt, reason: error.message, checked_at: new Date().toISOString() });
        this.record().preview_attempts = attempts;
        await this.persist();
        // A missing/closed popup is a deterministic click-target failure, not
        // a transient rendering delay. Stop immediately so the run preserves
        // evidence instead of waiting through five identical 30-second
        // retries. Only content hydration/closing races are retried.
        const wrongRoute = /预览窗口跳转到非预览路由/.test(error.message);
        if (wrongRoute && attempt >= 2) throw error;
        const transient = wrongRoute || /预览\/公开页没有读取到可见产品卡片|预览窗口在加载产品卡片前被关闭/.test(error.message);
        if (attempt >= maxAttempts || !transient) throw error;
        await this.editor.page.waitForTimeout(wrongRoute ? 5000 : 30000);
      }
    }
  }

  async verifyProductListPublicPage() {
    const page = await this.editor.page.context().newPage();
    try {
      await page.goto(this.state.page.publicUrl, { waitUntil: "domcontentloaded" });
      const live = await this.readLiveProductCards(page);
      if (this.mode.productScopeOnly === true) {
        const catalog = this.record().catalog;
        const expectedIds = catalog?.selected_category?.products?.map((product) => product.id) ?? [];
        const baselineIds = catalog?.products?.map((product) => product.id) ?? [];
        const expectedCount = Number(this.mode.productScopeExpectedCount);
        if (!Number.isInteger(expectedCount) || expectedCount < 1 || expectedCount !== expectedIds.length) {
          throw new Error(`公开页分类测试数据不一致：配置预期 ${expectedCount} 个，后台“${catalog?.selected_category?.name ?? ""}”实际匹配 ${expectedIds.length} 个产品 ID`);
        }
        const evidence = assertExactCategoryResult(live.cards, expectedIds, baselineIds);
        const scopeEvidence = { category: catalog.selected_category.name, expected_count: expectedCount, ...evidence };
        this.record().result_checks.product_scope = {
          status: "passed",
          evidence: { ...this.record().result_checks.product_scope?.evidence, after_published: scopeEvidence },
        };
        this.record().result_checks.published = {
          status: "passed",
          evidence: { url: this.state.page.publicUrl, product_count: live.cards.length, ids: live.cards.map((item) => item.id), category: catalog.selected_category.name },
        };
        this.record().published_verified = true;
        this.state.page.published_verified = true;
        markProductScopeEffect(this.record(), scopeEvidence);
        await this.persist();
        return;
      }
      assertPageSize(live.cards, Number(this.mode.expectedPageSize ?? 5));
      assertAscendingProductNames(live.cards);
      if (!live.pagerVisible) throw new Error("公开页未展示分页控件");
      if (live.ratingVisible) throw new Error("公开页仍显示已关闭的星级评价");
      const expectedColor = hexToRgb(String(this.mode.targetColorHex ?? "#2458D3").toUpperCase()).replace(/\s/g, "").toLowerCase();
      if (!live.colors.some((color) => color.replace(/\s/g, "").toLowerCase() === expectedColor)) {
        throw new Error(`公开页产品 CTA 未渲染目标颜色 ${expectedColor}`);
      }
      this.record().result_checks.published = { status: "passed", evidence: { url: this.state.page.publicUrl, page_size: live.cards.length, ids: live.cards.map((item) => item.id), pager_visible: live.pagerVisible, rating_visible: live.ratingVisible, colors: live.colors } };
      await this.persist();
    } finally {
      await page.close().catch(() => {});
    }
  }

  async collectFlatProductSnapshot(expectedIds) {
    const expected = new Set(expectedIds);
    let last = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      last = await this.productListSnapshot();
      const actualIds = new Set(last.cards.map((item) => item.id));
      if ([...expected].every((id) => actualIds.has(id))) return last;
      const lastCard = last.block.locator("li.prodlist-site-block").last();
      await lastCard.scrollIntoViewIfNeeded().catch(() => {});
      await last.block.evaluate((element) => {
        const view = element.ownerDocument.defaultView;
        for (let node = element; node && node !== view?.document.body; node = node.parentElement) {
          if (node.scrollHeight > node.clientHeight + 20) node.scrollTop = node.scrollHeight;
        }
        view?.scrollTo(0, view.document.documentElement.scrollHeight);
      }).catch(() => {});
      await this.editor.page.waitForTimeout(500);
    }
    return last;
  }

  async setProductScope(panel, scopeLabel, record, category = null) {
    const row = await this.settingsRow(panel, "选择产品");
    return this.chooseDifferentProductScope(row, "选择产品", record, scopeLabel, category);
  }

  async saveSettings(panel) {
    const save = await firstVisible([
      panel.getByRole("button", { name: /^保存$/ }).first(),
      panel.getByText("保存", { exact: true }).first(),
      panel.locator("button, a").filter({ hasText: /^保存$/ }).first(),
    ]);
    if (!save) return "editor-apply";
    await save.click({ force: true });
    await this.editor.page.waitForTimeout(500);
    return "sidebar-save";
  }

  async ensureSettingsPanel() {
    try {
      return await this.settingsPanel({ timeoutMs: 150 });
    } catch (error) {
      if (/唯一匹配失败/.test(error.message)) throw error;
      await this.openProductListSidebarStrict();
      return this.settingsPanel();
    }
  }

  async closePanel(panel) {
    const close = await firstVisible([
      panel.getByRole("button", { name: /关闭|取消/ }).first(),
      panel.locator("[aria-label='关闭'], .el-dialog__close, .close, .icon-close").first(),
    ]);
    if (close) await close.click({ force: true }).catch(() => {});
  }

  async clickGeneratedResult() {
    // The committed 3.0 canvas has a stable product-list marker even when
    // wrapper discovery is delayed by iframe navigation. Prefer it over text
    // heuristics so a rendered product card is always the click target.
    for (const frame of [this.editor.page, ...this.editor.page.frames()]) {
      const nodes = frame.locator("[data-block-uuid='ai-productlist'], .ai-generated-block");
      for (let index = 0; index < await nodes.count().catch(() => 0); index += 1) {
        const candidate = nodes.nth(index);
        await candidate.scrollIntoViewIfNeeded().catch(() => {});
        if (!(await candidate.boundingBox().catch(() => null))) continue;
        await candidate.click({ force: true, position: { x: 20, y: 20 } }).catch(() => {});
        return true;
      }
    }
    // In the 4.0 editor the generated preview is rendered in a nested
    // GrapesJS frame and does not always carry the committed 3.0 wrapper
    // classes. Clicking a visible card/text in that frame is the same user
    // action as clicking the generated block and reliably opens its sidebar.
    const patterns = [/LY-[A-Z0-9-]+/i, /Inquire/i, /Add to Basket/i, /View Product/i];
    for (const scope of this.editor.contexts()) {
      for (const pattern of patterns) {
        const candidates = scope.getByText(pattern);
        for (let index = 0; index < await candidates.count().catch(() => 0); index += 1) {
          const candidate = candidates.nth(index);
          if (!(await visible(candidate))) continue;
          await candidate.scrollIntoViewIfNeeded().catch(() => {});
          await candidate.click({ force: true }).catch(() => {});
          return true;
        }
      }
    }
    // The preview can be rendered as a cross-document canvas without
    // accessible text nodes. In that case click the center of the visible AI
    // editor iframe; the current result occupies the canvas center.
    const aiFrame = this.base.aiFrame();
    if (aiFrame) {
      const frameElement = await aiFrame.frameElement().catch(() => null);
      const box = await frameElement?.boundingBox().catch(() => null);
      if (box && box.width > 0 && box.height > 0) {
        await this.editor.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        return true;
      }
    }
    await mkdir(this.paths.root, { recursive: true }).catch(() => {});
    for (const [index, context] of this.editor.contexts().entries()) {
      await writeFile(
        `${this.paths.root}/sidebar-context-${index}.html`,
        await context.locator("body").innerHTML().catch(() => ""),
        "utf8",
      ).catch(() => {});
    }
    return false;
  }

  async openProductListSidebar() {
    // Do not use page-wide “设置”/gjs toolbar selectors here: those open the
    // editor's generic style drawer (“请选择页面上的元素”) instead of the
    // selected product-list block's floating sliders control.
    const selector = ".ld-toolbar .icon-tool-setups";
    // Current 3.0 builds open the product-list drawer immediately when the
    // block is clicked. Treat that as the primary path; the floating toolbar
    // gear below is only a legacy fallback. This also prevents a stale global
    // toolbar or page-level settings drawer from being selected.
    const directPanel = await waitFor(async () => {
      try {
        return await this.settingsPanel();
      } catch {
        return false;
      }
    }, 1500, "产品列表直接设置面板", 100).catch(() => false);
    if (directPanel) return true;
    // Keep block selection active; Escape clears it. The floating controls are
    // body-level siblings, linked to the selected block by its wrapper id.
    // Cross-frame canvas nodes sometimes ignore a Locator click even though
    // the element is visible. Reconcile the committed block's page-space
    // bounding box and dispatch a native mouse click at its center.
    for (const match of await this.blockMatches({ canvasOnly: true })) {
      const block = await this.productBlockLocator(match.wrapper);
      const box = await block.boundingBox().catch(() => null);
      if (!box || box.width <= 0 || box.height <= 0) continue;
      // The editor renders the AI block mask/toolbar only after pointer hover.
      // A forced click can dispatch to the card but leave the module
      // unselected, so reveal the real block affordance before clicking it.
      await match.wrapper.scrollIntoViewIfNeeded().catch(() => {});
      await match.wrapper.hover({ position: { x: Math.min(40, box.width / 2), y: Math.min(40, box.height / 2) }, timeout: 3000 }).catch(() => {});
      // Product-list settings are expected to open from the selected block in
      // the page editor. Try that user action first; the full-screen editor is
      // only a legacy fallback and must not pre-empt the regular sidebar.
      await block.click({ position: { x: Math.min(80, box.width / 2), y: Math.min(80, box.height / 2) }, timeout: 2500 }).catch(() => {});
      if (await waitFor(async () => {
        try { return Boolean(await this.settingsPanel()); } catch { return false; }
      }, 1800, "点击产品列表区块打开设置侧栏", 100).catch(() => false)) return true;
      const fullscreen = await this.floatingBlockControl(match, "ai-block-fullscreen-edit");
      if (await waitFor(async () => visible(fullscreen), 1500, "AI 区块全屏编辑入口显示", 100).catch(() => false)) {
        // Product-list controls live in the block editor opened from the
        // selected block toolbar, not in the parent pagebuilder style drawer.
        await fullscreen.click({ timeout: 3000 }).catch(() => {});
        const enteredBlockEditor = await waitFor(async () => {
          for (const scope of this.editor.contexts()) {
            const bodyText = normalize(await scope.locator("body").innerText().catch(() => ""));
            if (/编辑区块/.test(bodyText)) return true;
          }
          return false;
        }, this.config.timeouts.actionMs, "产品列表区块编辑器打开", 150).catch(() => false);
        if (enteredBlockEditor) {
          this.record().block_editor_opened = true;
          try { return Boolean(await this.settingsPanel()); } catch { /* select the block inside the editor below */ }
          // The full-screen editor chrome and the actual product-list canvas
          // are hosted in different frames. Search every frame for the unique
          // rendered product block instead of assuming it is a child of the
          // frame whose body contains “编辑区块”.
          const editorBlocks = [];
          const embeddedEditorBlocks = [];
          for (const scope of this.editor.contexts()) {
            const blocks = scope.locator("[data-block-uuid='ai-productlist']").filter({ has: scope.locator("li.prodlist-site-block") });
            for (let index = 0; index < await blocks.count().catch(() => 0); index += 1) {
              const candidate = blocks.nth(index);
              if (!(await visible(candidate))) continue;
              editorBlocks.push(candidate);
              if (scope.url?.() === "about:blank") embeddedEditorBlocks.push(candidate);
            }
          }
          const selectableBlocks = embeddedEditorBlocks.length ? embeddedEditorBlocks : editorBlocks;
          if (selectableBlocks.length !== 1) {
            throw new Error(`全屏编辑器中产品列表区块唯一匹配失败：${selectableBlocks.length} 个`);
          }
          const editorBlock = selectableBlocks[0];
          await editorBlock.scrollIntoViewIfNeeded().catch(() => {});
          await editorBlock.click({ position: { x: 30, y: 30 }, timeout: 2500 }).catch(() => {});
          if (await waitFor(async () => {
            try { return Boolean(await this.settingsPanel()); } catch { return false; }
          }, this.config.timeouts.actionMs, "产品列表区块设置侧栏", 150).catch(() => false)) return true;
          // Some editor builds reveal the block toolbar after selection but
          // require an explicit settings/gear click to open the properties
          // drawer. Limit the click to the full-screen editor chrome.
          for (const scope of this.editor.contexts()) {
            const settingsButton = await firstVisible([
              scope.locator(".block-setting-container .setting-icon-container").first(),
              scope.locator(".block-setting-container .icon-a-editor-containersettings").first(),
              scope.locator("[aria-label*='设置'], [title*='设置']").first(),
            ]);
            if (!settingsButton) continue;
            await settingsButton.click({ timeout: 2000 }).catch(() => {});
            if (await waitFor(async () => {
              try { return Boolean(await this.settingsPanel()); } catch { return false; }
            }, this.config.timeouts.actionMs, "产品列表区块设置侧栏", 150).catch(() => false)) return true;
          }
        }
      }
      await block.hover({ position: { x: Math.min(40, box.width / 2), y: Math.min(40, box.height / 2) }, timeout: 2000 }).catch(() => {});
      const mask = match.frame.locator(".ai-block-mask").first();
      if (await waitFor(async () => visible(mask), 1200, "产品列表区块遮罩显示", 100).catch(() => false)) {
        await mask.click({ timeout: 2000 }).catch(() => {});
      } else {
        await block.click({ position: { x: box.width / 2, y: Math.min(120, box.height / 2) }, timeout: 2000 }).catch(() => {});
      }
      if (await waitFor(async () => {
        try { return Boolean(await this.settingsPanel()); } catch { return false; }
      }, 1500, "产品列表区块坐标选中", 100).catch(() => false)) return true;
    }
    // The generated preview's floating black sliders control is rendered by
    // the AI editor (not the 3.0 canvas). It appears only after the result is
    // clicked; clicking it opens the product-list properties sidebar.
    for (const scope of this.editor.contexts()) {
      const candidates = scope.locator(`${selector}, .block-setting-container .setting-icon-container i, .block-setting-container .setting-icon-container span, .block-setting-container .setting-icon-container, .block-setting-container .icon-a-editor-containersettings`);
      for (let index = 0; index < await candidates.count().catch(() => 0); index += 1) {
        const candidate = candidates.nth(index);
        if (!(await visible(candidate))) continue;
        await candidate.click({ force: true }).catch(() => {});
        const opened = await waitFor(async () => {
          for (const context of this.editor.contexts()) {
            if (await context.locator(".modules-setting-container .el-drawer.open, .el-drawer.open .style-setting-container").count().catch(() => 0)) return true;
          }
          return false;
        }, 2500, "产品列表设置面板打开", 100).catch(() => false);
        if (opened) return true;
        await candidate.click({ force: true }).catch(() => {});
        if (await waitFor(async () => {
          for (const context of this.editor.contexts()) {
            if (await context.locator(".modules-setting-container .el-drawer.open, .el-drawer.open .style-setting-container").count().catch(() => 0)) return true;
          }
          return false;
        }, 1500, "产品列表设置面板重试打开", 100).catch(() => false)) return true;
      }
    }
    await mkdir(this.paths.root, { recursive: true }).catch(() => {});
    const diagnostics = [];
    for (const [index, scope] of this.editor.contexts().entries()) {
      const block = scope.locator("[data-block-uuid='ai-productlist']").first();
      const drawer = scope.locator(".el-drawer.open, .modules-setting-container, .right-setting-panel, .backstage-right-panel");
      diagnostics.push({
        index,
        url: scope.url?.() ?? "",
        blockCount: await scope.locator("[data-block-uuid='ai-productlist']").count().catch(() => 0),
        blockVisible: await visible(block),
        blockBox: await block.boundingBox().catch(() => null),
        maskVisible: await visible(scope.locator(".ai-block-mask").first()),
        floatingToolbarVisible: await visible(scope.locator(".ai-block-floating-toolbar").first()),
        drawerCount: await drawer.count().catch(() => 0),
        drawerText: normalize((await drawer.allInnerTexts().catch(() => [])).join(" ")).slice(0, 500),
      });
    }
    await writeFile(`${this.paths.root}/sidebar-open-failure.json`, `${JSON.stringify(diagnostics, null, 2)}\n`, "utf8").catch(() => {});
    // Do not ask the vision model to guess a global toolbar coordinate here.
    // If the block-selection event did not expose a product-list control, a
    // visual guess can open unrelated operation-history/settings UI. Midscene
    // remains enabled for the six in-panel settings, where the search scope
    // is unambiguous; sidebar discovery fails safely instead.
    return false;
  }

  async resolveProductCanvas({ fullScreen = false } = {}) {
    const frames = this.editor.page.frames();
    const blockEditorFrames = [];
    for (const frame of frames) {
      if (!/blockEditorUI/i.test(frame.url())) continue;
      if (await visible(frame.getByText("编辑区块", { exact: true }).first())) blockEditorFrames.push(frame);
    }
    if (fullScreen && blockEditorFrames.length !== 1) {
      throw new Error(`全屏区块编辑器 frame 唯一匹配失败：${blockEditorFrames.length} 个`);
    }
    const candidates = [];
    for (const frame of frames) {
      if (!fullScreen && !isPagebuilderCanvasUrl(frame.url())) continue;
      if (/\/phoenix\/pagebuilder\/layout(?:\?|$)/.test(frame.url())) continue;
      if (fullScreen && !isFrameWithin(frame, blockEditorFrames[0])) continue;
      const blocks = frame.locator("[data-block-uuid='ai-productlist']");
      for (let index = 0; index < await blocks.count().catch(() => 0); index += 1) {
        const block = blocks.nth(index);
        if (!(await block.locator("li.prodlist-site-block").count().catch(() => 0))) continue;
        const box = await block.boundingBox().catch(() => null);
        const wrapper = block.locator("xpath=ancestor::div[contains(@class,'siteblocks-setting-wrap')][1]");
        const candidate = {
          frame,
          block,
          wrapper: await visible(wrapper) ? wrapper : block,
          visible: Boolean(box && box.width > 0 && box.height > 0) && await visible(block),
          hasProductCards: true,
          identity: {
            block_uuid: await block.getAttribute("data-block-uuid").catch(() => "ai-productlist"),
            element_id: await block.getAttribute("id").catch(() => ""),
            wrapper_id: await wrapper.getAttribute("id").catch(() => ""),
          },
        };
        candidates.push(candidate);
      }
    }
    return chooseProductCanvasCandidate(candidates, { fullScreen });
  }

  async captureFrameDiagnostics(stage, reason = "") {
    await mkdir(this.paths.root, { recursive: true }).catch(() => {});
    const frames = this.editor.page.frames();
    const tree = [];
    for (const frame of frames) {
      const blocks = frame.locator("[data-block-uuid='ai-productlist']");
      const sidebars = frame.locator(".el-drawer.open, .block-setting-panel, .backstage-setting-panel, .siteblocks-setting-panel, .right-setting-panel, .backstage-right-panel");
      const bodyText = normalize(await frame.locator("body").innerText().catch(() => ""));
      tree.push({
        ancestry: frameAncestry(frame),
        productBlockCount: await blocks.count().catch(() => 0),
        visibleProductBlockCount: await blocks.evaluateAll((nodes) => nodes.filter((node) => {
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== "hidden";
        }).length).catch(() => 0),
        sidebarCount: await sidebars.count().catch(() => 0),
        productListSidebarTextPresent: /产品列表/.test(bodyText),
        requiredSidebarLabelsPresent: /产品排序/.test(bodyText) && /加载方式/.test(bodyText) && /每页(?:显示|展示)数量/.test(bodyText),
        blockEditorHeadingPresent: bodyText.includes("编辑区块"),
      });
    }
    const file = `${this.paths.root}/iframe-${stage}.json`;
    await writeFile(file, `${JSON.stringify({ stage, reason, captured_at: new Date().toISOString(), frames: tree }, null, 2)}\n`, "utf8").catch(() => {});
    await this.editor.page.screenshot({ path: `${this.paths.root}/iframe-${stage}.png`, fullPage: false }).catch(() => {});
    const record = this.record();
    record.frame_diagnostics ??= [];
    record.frame_diagnostics.push({ stage, file, frame_count: tree.length, captured_at: new Date().toISOString() });
  }

  async clickProductBlock(candidate, step) {
    const started = Date.now();
    try {
      const box = await candidate.block.boundingBox().catch(() => null);
      if (!box || box.width <= 0 || box.height <= 0 || !(await visible(candidate.block))) {
        throw new Error(`${step}: 目标产品列表区块不可见或 frame 已失效`);
      }
      await candidate.block.scrollIntoViewIfNeeded({ timeout: 2500 });
      const cards = candidate.block.locator("li.prodlist-site-block");
      let selectedCard = null;
      for (let index = 0; index < await cards.count().catch(() => 0); index += 1) {
        const card = cards.nth(index);
        if (await visible(card)) { selectedCard = card; break; }
      }
      if (!selectedCard) throw new Error(`${step}: 唯一产品列表区块内没有可见产品卡片，拒绝点画布空白处`);
      // The 3.0 canvas does not mount the per-block toolbar until the pointer
      // enters the selected block. The strict path previously skipped this
      // hover (the older path already performed it), so the subsequent click
      // could appear to succeed while no toolbar/sidebar was ever created.
      const hoverTarget = candidate.wrapper ?? candidate.block;
      await hoverTarget.hover({ position: { x: 24, y: 24 }, timeout: 2500 }).catch(() => {});
      const mask = candidate.frame.locator(".ai-block-mask");
      const fullscreenControl = await this.floatingBlockControl(candidate, "ai-block-fullscreen-edit");
      await waitFor(async () => {
        if (await visible(fullscreenControl)) return true;
        for (let index = 0; index < await mask.count().catch(() => 0); index += 1) {
          if (await visible(mask.nth(index))) return true;
        }
        return false;
      }, 900, `${step}区块工具条显示`, 100).catch(() => false);
      let visibleMask = null;
      for (let index = 0; index < await mask.count().catch(() => 0); index += 1) {
        const possibleMask = mask.nth(index);
        if (await visible(possibleMask)) { visibleMask = possibleMask; break; }
      }
      const safeTargets = [
        selectedCard.locator(".prodlist-site-block-image img, .prodlist-site-block-img img, .prodlist-site-block-photo img, img").first(),
        selectedCard.locator(".prodlist-site-block-image, .prodlist-site-block-img, .prodlist-site-block-photo").first(),
        selectedCard,
      ];
      let clicked = false;
      let targetEvidence = null;
      if (visibleMask) {
        const maskBox = await visibleMask.boundingBox().catch(() => null);
        if (maskBox && maskBox.width > 0 && maskBox.height > 0) {
          await visibleMask.click({ force: true, position: { x: Math.min(20, maskBox.width / 2), y: Math.min(20, maskBox.height / 2) }, timeout: 2500 }).catch(async () => {
            const fresh = await visibleMask.boundingBox().catch(() => null);
            if (!fresh) throw new Error(`${step}: 区块遮罩在点击前失效`);
            await this.editor.page.mouse.click(fresh.x + fresh.width / 2, fresh.y + fresh.height / 2);
          });
          targetEvidence = { tag: "ai-block-mask", className: await visibleMask.getAttribute("class").catch(() => ""), id: await visibleMask.getAttribute("id").catch(() => "") };
          clicked = true;
        }
      }
      for (const target of safeTargets) {
        if (clicked) break;
        if (!(await visible(target))) continue;
        const targetBox = await target.boundingBox().catch(() => null);
        if (!targetBox || targetBox.width <= 0 || targetBox.height <= 0) continue;
        await target.scrollIntoViewIfNeeded().catch(() => {});
        // Click a real product image/card inside the uniquely resolved block.
        // A click at the block wrapper's geometric center often lands between
        // grid columns or on whitespace in cross-origin nested canvases and
        // therefore fails to select the AI block. Avoid title/CTA anchors so
        // this interaction cannot navigate to a product detail page.
        await target.click({ force: true, position: { x: Math.min(20, targetBox.width / 2), y: Math.min(20, targetBox.height / 2) }, timeout: 2500 }).catch(async () => {
          const fresh = await target.boundingBox().catch(() => null);
          if (!fresh) throw new Error(`${step}: 产品卡片图像定位在点击前失效`);
          await this.editor.page.mouse.click(fresh.x + fresh.width / 2, fresh.y + fresh.height / 2);
        });
        targetEvidence = await target.evaluate((element) => ({
          tag: element.tagName.toLowerCase(),
          className: typeof element.className === "string" ? element.className : "",
          id: element.id || "",
          text: (element.innerText || element.getAttribute("alt") || "").replace(/\s+/g, " ").trim().slice(0, 120),
        })).catch(() => null);
        clicked = true;
        break;
      }
      if (!clicked) throw new Error(`${step}: 产品卡片中没有可点击的图像/容器`);
      candidate.lastHitStack = targetEvidence;
    } catch (error) {
      await this.captureFrameDiagnostics(`${step}-click-failed`, error.message);
      throw error;
    }
    const record = this.record();
    record.frame_steps ??= [];
    record.frame_steps.push({ step, frame_url: sanitizeFrameUrl(candidate.frame.url()), identity: candidate.identity, hit_stack: candidate.lastHitStack ?? [], duration_ms: Date.now() - started });
  }

  async waitForProductListPanel(timeoutMs, label) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try { return await this.settingsPanel({ timeoutMs: 50 }); }
      catch (error) {
        if (/唯一匹配失败/.test(error.message)) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`${label}等待超时`);
  }

  async openProductListSidebarStrict() {
    const sidebarStartedAt = Date.now();
    try {
      await this.settingsPanel({ timeoutMs: 150 });
      this.record().frame_steps ??= [];
      this.record().frame_steps.push({ step: "product-list-sidebar-already-open", duration_ms: Date.now() - sidebarStartedAt });
      return true;
    } catch (error) {
      if (/唯一匹配失败/.test(error.message)) {
        await this.captureFrameDiagnostics("ambiguous-sidebar", error.message);
        throw error;
      }
      // No matching panel yet: resolve the block and open its settings.
    }
    let candidate;
    try {
      candidate = await this.resolveProductCanvas();
    } catch (error) {
      await this.captureFrameDiagnostics("canvas-resolve-failed", error.message);
      throw error;
    }
    await this.clickProductBlock(candidate, "pagebuilder-block-select");
    try {
      await this.waitForProductListPanel(2500, "产品列表设置侧栏出现");
      this.record().frame_steps.push({ step: "product-list-sidebar-open", frame_url: sanitizeFrameUrl(this.activeSettingsFrame?.url?.() ?? ""), duration_ms: Date.now() - sidebarStartedAt });
      return true;
    } catch (error) {
      if (/唯一匹配失败/.test(error.message)) {
        await this.captureFrameDiagnostics("ambiguous-sidebar-after-select", error.message);
        throw error;
      }
      // Use only this block's explicit full-screen affordance below.
    }
    const fullscreen = await this.floatingBlockControl(candidate, "ai-block-fullscreen-edit");
    if (!(await visible(fullscreen))) {
      await this.captureFrameDiagnostics("sidebar-not-open", "点击唯一产品列表区块后没有侧栏或其绑定的全屏编辑入口");
      throw new Error("点击唯一产品列表区块后未出现设置侧栏，且未发现该区块绑定的全屏编辑入口");
    }
    await fullscreen.click({ timeout: 2500 });
    this.record().block_editor_opened = true;
    try {
      // The editor chrome can appear while its nested canvas is still blocked
      // by “编辑器正在加载，请稍候”.  Do not treat the heading (or the
      // background 3.0 canvas) as readiness; wait for the unique product block
      // inside the blockEditorUI frame tree itself.
      const editorCandidate = await waitFor(async () => {
        const editorFrames = [];
        for (const frame of this.editor.page.frames()) {
          if (/blockEditorUI/i.test(frame.url()) && await visible(frame.getByText("编辑区块", { exact: true }).first())) editorFrames.push(frame);
        }
        if (editorFrames.length !== 1) return false;
        try {
          const candidate = await this.resolveProductCanvas({ fullScreen: true });
          return isFrameWithin(candidate.frame, editorFrames[0]) ? candidate : false;
        } catch {
          return false;
        }
      }, this.config.timeouts.blockRenderMs, "全屏区块编辑器产品画布就绪", 200);
      // Re-resolve after frame navigation; never keep locators from the 3.0 canvas.
      const currentEditorCandidate = await this.resolveProductCanvas({ fullScreen: true });
      await this.clickProductBlock(currentEditorCandidate, "fullscreen-editor-block-select");
      await this.waitForProductListPanel(3000, "全屏编辑器产品列表侧栏出现");
      this.record().frame_steps.push({ step: "fullscreen-product-list-sidebar-open", frame_url: sanitizeFrameUrl(this.activeSettingsFrame?.url?.() ?? ""), duration_ms: Date.now() - sidebarStartedAt });
      return true;
    } catch (error) {
      await this.captureFrameDiagnostics("fullscreen-sidebar-failed", error.message);
      throw error;
    }
  }

  async configureSettings(record) {
    try {
      // Page-list dropdowns can remain mounted after history insertion. Close
      // that global overlay before selecting the generated block; otherwise a
      // visual fallback click may land on the page selector instead of the
      // block's own controls.
      await this.editor.dismissPageMenu?.().catch(() => {});
      // The freshly generated result lives in the AI editor iframe until the
      // final dialog apply completes. Locate it across all frames so the
      // click really selects the result that owns the settings sidebar.
      // Settings are validated on the committed 3.0 canvas block. The
      // temporary AI editor has a generic GrapesJS style drawer and does not
      // expose the product-data controls we need to verify.
      await this.openProductListSidebarStrict();
      let panel = await this.settingsPanel();
      record.frame_steps ??= [];
      record.frame_steps.push({
        step: "product-list-sidebar-resolved",
        frame_url: sanitizeFrameUrl(this.activeSettingsFrame?.url?.() ?? ""),
        duration_ms: 0,
        required_labels: ["产品列表", "产品排序", "加载方式", "每页显示数量"],
      });
      record.settings_opened = true;
      record.settings_status = "running";
      await this.persist();
      const previousCatalog = this.record().catalog;
      const previousCatalogMatchesTarget = !this.mode.productScopeCategoryName
        || previousCatalog?.selected_category?.name === this.mode.productScopeCategoryName;
      const catalog = previousCatalog?.captured_at && previousCatalog?.products?.length && previousCatalogMatchesTarget
        ? previousCatalog
        : await this.readBackendProductCatalog({ includeCategoryFilter: !this.mode.skipProductScope });
      const baselineIds = catalog.products.map((product) => product.id);
      let blockingReason = "";
      const scopeSetting = this.settingRecord(record, "product_scope");
      if (this.mode.productScopeOnly === true) {
        const targetCategory = String(this.mode.productScopeCategoryName ?? "").trim();
        if (!targetCategory || catalog.selected_category?.name !== targetCategory) {
          throw new Error(`后台产品分类数据未确认目标分类“${targetCategory || "(empty)"}”`);
        }
        const result = await this.setProductScope(panel, "指定分类", record, catalog.selected_category);
        Object.assign(scopeSetting, result);
        // This embedded block editor keeps a stale data snapshot until its
        // top-level “应用” commits the configuration. Do not mistake those
        // pre-commit cards for the category result; the hard assertion runs
        // in verifyCommittedSettings() immediately after the commit.
        scopeSetting.effect_status = "pending";
        scopeSetting.effect_after = {
          category: targetCategory,
          expected_count: this.mode.productScopeExpectedCount ?? null,
          category_selection: result.category_selection,
          validation_deferred_until: "block-editor-apply",
          checkbox_evidence: this.paths.root ? `${this.paths.root}/product-scope-category-reopened.json` : "",
        };
        scopeSetting.effect_reopened = { after_apply: false, after_saved_preview: false };
        record.result_checks.product_scope = { status: "pending", evidence: scopeSetting.effect_after };
        for (const key of ["sort", "loading", "page_size", "display_content", "base_color"]) {
          const item = this.settingRecord(record, key);
          item.status = "skipped";
          item.effect_status = "skipped";
          item.effect_failure_reason = "本轮使用 productScopeOnly，仅验证产品数据分类设置";
        }
        await this.persist();
      } else if (this.mode.skipProductScope) {
        const reason = "本轮按要求跳过产品分类设置项";
        Object.assign(scopeSetting, { status: "skipped", selected: "skipped", after: "skipped", effect_status: "skipped", effect_failure_reason: reason });
        record.result_checks.product_scope = { status: "skipped", evidence: { reason } };
      } else if (catalog.selected_category) {
        if (record.category_phase?.status !== "passed") {
          record.category_phase = { status: "running", category: catalog.selected_category.name, started_at: new Date().toISOString() };
          await this.persist();
          const result = await this.setProductScope(panel, "指定分类", record, catalog.selected_category);
          Object.assign(scopeSetting, result);
          await this.commitSettingsEditor(record, panel);
          // The block canvas only hydrates the chosen data after Apply.
          // Save/reopen/preview the category before restoring all products
          // for the separate five-card pagination checks on this same page.
          const previousScopeOnly = this.mode.productScopeOnly;
          const previousExpectedCount = this.mode.productScopeExpectedCount;
          const previousCategoryName = this.mode.productScopeCategoryName;
          try {
            this.mode.productScopeOnly = true;
            this.mode.productScopeCategoryName = catalog.selected_category.name;
            this.mode.productScopeExpectedCount = catalog.selected_category.products.length;
            await this.verifyCommittedSettings(record);
            await this.editor.savePage();
            this.state.page.saved = true;
            await this.persist();
            await this.verifyProductListPreviewWithRetry();
            record.category_phase = {
              ...record.category_phase,
              status: "passed",
              evidence: record.result_checks.product_scope.evidence.after_saved_preview,
              completed_at: new Date().toISOString(),
            };
          } finally {
            this.mode.productScopeOnly = previousScopeOnly;
            this.mode.productScopeExpectedCount = previousExpectedCount;
            this.mode.productScopeCategoryName = previousCategoryName;
            await this.persist();
          }
        }
        this.state.page.saved = false;
        this.state.page.preview_verified = false;
        record.preview_verified = false;
        record.result_checks.preview = { status: "pending", evidence: null };
        record.settings_status = "running";
        await this.persist();
        // Preview rebuilt the editor frame tree. Resolve the block/side panel
        // afresh before restoring the final all-product scope.
        await this.openProductListSidebarStrict();
        panel = await this.settingsPanel();
        const restored = await this.setProductScope(panel, "全部产品", record, null);
        scopeSetting.selected = "全部产品";
        scopeSetting.after = restored.after;
        scopeSetting.effect_reopened = { ...scopeSetting.effect_reopened, restored_scope: "全部产品", restored_result_pending: true };
      } else {
        blockingReason = `${catalog.failure_reason}（后台 ${baselineIds.length} 条产品在可选分类中均返回同一结果集）`;
        Object.assign(scopeSetting, {
          status: "blocked",
          effect_status: "blocked",
          effect_failure_reason: blockingReason,
        });
        record.result_checks.product_scope = { status: "blocked", evidence: { reason: blockingReason, categories: catalog.categories } };
      }
      await this.persist();

      if (this.mode.productScopeOnly !== true) {
        // Set options in the transient AI editor. This preview can remain stale
        // until the top-level Apply commits the generated block, so result-level
        // assertions run immediately after that commit.
        panel = await this.ensureSettingsPanel();
        const sortResult = await this.chooseDifferentDropdown(panel, "sort", "产品排序", record, this.mode.productSortLabel);
        Object.assign(this.settingRecord(record, "sort"), sortResult);
        await this.persist();

      panel = await this.ensureSettingsPanel();
      const loadingBefore = await this.readRow(await this.settingsRow(panel, "加载方式"));
      // The canvas inside the block editor does not execute pagination-mode
      // changes until the top-level Apply. Validate the final, configured
      // pagination mode in the real preview instead of treating this static
      // editing canvas as a live renderer. Flat mode is not the final mode in
      // this regression and is explicitly reported as not separately tested.
      record.result_checks.loading_flat = {
        status: "skipped",
        evidence: { reason: "本轮最终配置为分页；平铺模式不作为最终状态，避免在静态编辑画布误判渲染行为" },
      };
      panel = await this.ensureSettingsPanel();
      const pageSizeResult = await this.changeSlider(panel, "page_size", "每页展示数量", record);
      Object.assign(this.settingRecord(record, "page_size"), pageSizeResult);
      await this.persist();
      panel = await this.ensureSettingsPanel();
      await this.chooseDifferentDropdown(panel, "loading", "加载方式", record, "分页");
      this.settingRecord(record, "loading").selected = "分页";
      this.settingRecord(record, "loading").after = "分页";
      this.settingRecord(record, "loading").effect_status = "pending";
      await this.persist();

      panel = await this.ensureSettingsPanel();
      const displayResult = await this.toggleDisplayContent(panel, "display_content", "展示内容", record);
      Object.assign(this.settingRecord(record, "display_content"), displayResult);
      this.settingRecord(record, "display_content").effect_status = "pending";
      await this.persist();

      panel = await this.ensureSettingsPanel();
      const colorResult = await this.chooseColor(panel, "base_color", "基础配色", record);
      Object.assign(this.settingRecord(record, "base_color"), colorResult);
      await this.persist();
      }

      panel = await this.ensureSettingsPanel();
      await this.commitSettingsEditor(record, panel);
      record.settings_status = blockingReason ? "partial" : "configured";
      record.failure_reason = "";
      record.settings_failure_reason = "";
      await this.persist();
      if (blockingReason) record.settings_failure_reason = blockingReason;
      await this.persist();
    } catch (error) {
      record.settings_status = "failed";
      record.settings_failure_reason = error.message;
      await mkdir(this.paths.root, { recursive: true }).catch(() => {});
      record.screenshot = `${this.paths.root}/settings-failure.png`;
      await this.editor.page.screenshot({ path: record.screenshot, fullPage: false }).catch(() => {});
      await this.persist();
      throw error;
    }
  }

  async commitSettingsEditor(record, panel) {
      const settingsCommitMode = await this.saveSettings(panel);
      record.settings_commit_mode = settingsCommitMode;
      if (record.block_editor_opened) {
        let committed = false;
        for (const scope of this.editor.contexts()) {
          const header = scope.locator(".header-container").filter({ hasText: "编辑区块" }).first();
          if (!(await visible(header))) continue;
          const apply = header.getByRole("button", { name: "应用", exact: true }).first();
          if (!(await visible(apply))) continue;
          await apply.click({ force: true });
          committed = await waitFor(async () => !(await visible(header)), this.config.timeouts.blockRenderMs, "区块设置应用返回页面", 150).catch(() => false);
          break;
        }
        if (!committed) throw new Error("区块侧栏设置已调整，但全屏编辑器“应用”未确认，停止页面保存");
        record.block_editor_applied = true;
        record.settings_saved = true;
      } else {
        if (settingsCommitMode !== "sidebar-save") {
          throw new Error("产品列表侧栏无独立保存按钮，且当前不在可点击“应用”的区块编辑器中，拒绝误标保存成功");
        }
        record.settings_saved = true;
        await this.closePanel(panel);
      }
      await this.persist();
  }

  async verifyCommittedSettings(record) {
    const catalog = record.catalog;
    const baselineIds = catalog.products.map((product) => product.id);
    let snapshot = await waitFor(() => this.productListSnapshot().catch(() => false), this.config.timeouts.blockRenderMs, "已应用产品列表卡片");
    if (this.mode.productScopeOnly === true) {
      const targetCategory = String(this.mode.productScopeCategoryName ?? "").trim();
      if (!targetCategory || catalog?.selected_category?.name !== targetCategory) {
        throw new Error(`已应用设置中未确认目标产品分类“${targetCategory || "(empty)"}”`);
      }
      record.result_checks.product_scope = {
        status: "pending",
        evidence: {
          ...record.result_checks.product_scope?.evidence,
          after_apply: {
            category: targetCategory,
            validation_deferred_until: "saved-preview",
            editor_canvas_product_ids: snapshot.cards.map((product) => product.id),
            editor_canvas_count: snapshot.cards.length,
            note: "编辑器画布可能仍渲染完整产品集合；分类过滤以保存后预览/公开页实际渲染结果为准",
          },
        },
      };
      const scopeSetting = this.settingRecord(record, "product_scope");
      scopeSetting.status = "succeeded";
      scopeSetting.effect_status = "pending";
      scopeSetting.effect_after = record.result_checks.product_scope.evidence.after_apply;
      scopeSetting.effect_reopened = { ...scopeSetting.effect_reopened, after_apply: { committed: true, result_validation_pending: true } };
      // Applying the block editor is not the same as re-opening its settings
      // and reading the value back. Leave this unset until an actual UI read
      // after save; preview is still the authoritative result-level check.
      scopeSetting.reopened = "";
      scopeSetting.effect_reopened = {
        ...scopeSetting.effect_reopened,
        after_apply: { committed: true, result_validation_pending: true, category_ui_reread: false },
      };
      record.settings_reopened = false;
      record.settings_status = "partial";
      record.settings_skip_reason = "编辑器画布结果延迟验证；保存后预览将执行分类 ID 和数量硬断言";
      await this.persist();
      return record.settings_status;
    }
    assertPageSize(snapshot.cards, Number(this.mode.expectedPageSize ?? 5));
    if (snapshot.meta.pageSize !== Number(this.mode.expectedPageSize ?? 5)) {
      throw new Error(`应用后每页数量配置不为 5：${snapshot.meta.pageSize}`);
    }
    assertAscendingProductNames(snapshot.cards);
    if (!snapshot.pager.visible) throw new Error("应用后分页模式没有真实页码控件");
    const firstPage = snapshot;
    const pageEvidence = {
      page_size: firstPage.cards.length,
      total: firstPage.meta.total,
      first_page_ids: firstPage.cards.map((product) => product.id),
      pager_visible: firstPage.pager.visible,
    };
    record.result_checks.page_size = { status: "passed", evidence: pageEvidence };
    record.result_checks.loading_pagination = { status: "pending", evidence: { ...pageEvidence, interaction_checked_on: "preview" } };
    this.settingRecord(record, "page_size").effect_status = "passed";
    this.settingRecord(record, "page_size").effect_after = pageEvidence;
    this.settingRecord(record, "loading").effect_after = pageEvidence;
    this.settingRecord(record, "loading").effect_status = "passed";
    snapshot = await this.productListSnapshot();
    await this.verifySortResult(record, snapshot);
    await this.verifyRatingHidden(record, snapshot);
    const beforeColor = this.settingRecord(record, "base_color").effect_before?.rendered_colors?.[0];
    if (!beforeColor) throw new Error("缺少配色修改前的 CTA 渲染颜色证据");
    await this.verifyRenderedColor(record, beforeColor, snapshot);

    const panel = null;
    const finalSnapshot = await this.productListSnapshot();
    assertPageSize(finalSnapshot.cards, Number(this.mode.expectedPageSize ?? 5));
    if (!finalSnapshot.pager.visible) throw new Error("恢复分页后页码控件没有出现");
    record.settings_reopened = true;
    record.result_checks.after_reopen = {
      status: "pending",
      evidence: {
        note: "等待保存后预览/公开页核对设置效果",
        ids: finalSnapshot.cards.map((product) => product.id),
        count: finalSnapshot.cards.length,
        page_size: finalSnapshot.meta.pageSize,
        rating_visible: finalSnapshot.rating_visible,
        colors: finalSnapshot.colors,
        pager_visible: finalSnapshot.pager.visible,
      },
    };
    for (const item of record.settings) {
      item.reopened = item.key === "base_color"
        ? finalSnapshot.colors.join(" | ")
        : item.key === "display_content"
          ? `${this.mode.displayFieldLabel}: ${finalSnapshot.rating_visible ? "on" : "off"}`
          : item.key === "page_size"
            ? String(finalSnapshot.meta.pageSize)
            : item.key === "loading"
              ? "分页"
              : item.after;
      item.effect_reopened = { ...item.effect_reopened, after_apply: true };
    }
    const categorySkipped = record.result_checks.product_scope.status === "skipped";
    record.settings_status = categorySkipped ? "partial" : "succeeded";
    if (categorySkipped) record.settings_skip_reason = record.result_checks.product_scope.evidence.reason;
    await this.persist();
    return record.settings_status;
  }

  async recoverGeneratedResult(record) {
    const { frame, card } = await this.reopenProductListHistory(record);
    const beforeMatches = await this.blockMatches({ canvasOnly: true });
    if (beforeMatches.length !== 0) throw new Error(`历史插入前页面已有 ${beforeMatches.length} 个产品列表区块，拒绝重复添加`);
    const scopes = () => [frame, ...frame.childFrames()];
    const visibleControl = async (factory, enabled = false) => {
      for (const scope of scopes()) {
        const control = factory(scope);
        if (!(await visible(control))) continue;
        if (enabled && !(await control.isEnabled().catch(() => false))) continue;
        return { scope, control };
      }
      return null;
    };
    const insert = await firstVisible([
      card.locator(this.config.selectors.aiHistoryInsertSelector).first(),
      card.getByRole("button", { name: /插入|应用模块/ }).first(),
      card.getByText(/插入|应用模块/).first(),
    ]);
    if (!insert) throw new Error("产品列表历史记录未找到插入按钮");
    try {
      await insert.click({ timeout: this.config.timeouts.actionMs });
    } catch {
      // The card's listener can be attached to an inner Vue target while the
      // visible button is covered by its transition layer. Retry only that
      // same, uniquely matched history-record control.
      await insert.click({ force: true });
    }
    const next = await waitFor(async () => {
      const module = await visibleControl((scope) => scope.getByText("应用模块", { exact: true }).first(), true)
        ?? await visibleControl((scope) => scope.locator("button").filter({ hasText: /^应用模块$/ }).first(), true);
      if (module) return { mode: "module", ...module };
      const apply = await visibleControl((scope) => scope.locator(this.config.selectors.aiApplySelector).filter({ hasText: /^应用$/ }).first(), true);
      return apply ? { mode: "apply", ...apply } : false;
    }, this.config.timeouts.blockRenderMs, "产品列表历史插入后可用操作", 200);
    if (next.mode === "module") {
      await next.control.click();
    }
    const applyTarget = next.mode === "apply"
      ? { scope: next.scope, control: next.control }
      : await waitFor(
        () => visibleControl((scope) => scope.locator(this.config.selectors.aiApplySelector).filter({ hasText: /^应用$/ }).first(), true),
        this.config.timeouts.actionMs,
        "产品列表历史应用按钮",
        150,
      );
    const apply = applyTarget.control;
    await this.base.waitForAiControlReady(applyTarget.scope, apply, "产品列表历史应用按钮");
    // Apply the selected history module into the 3.0 page first. Product-list
    // data settings belong to the committed block's sidebar; the temporary
    // AI result preview has no reliable, persisted product-data drawer.
    const saveResponse = this.editor.page.waitForResponse(
      (response) => response.request().method() === "POST" && response.url().includes("/phoenix2/composite/editor/v1/newEditor/savePage"),
      { timeout: this.config.timeouts.blockRenderMs },
    ).catch(() => null);
    await apply.click();
    const [response, committed] = await Promise.all([
      saveResponse,
      waitFor(async () => {
        const matches = await this.blockMatches({ canvasOnly: true });
        return matches.length === 1 ? matches : false;
      }, this.config.timeouts.blockRenderMs, "产品列表历史应用后的 3.0 区块提交", 200).catch(() => false),
    ]);
    if (response && !response.ok()) throw new Error(`产品列表历史应用保存接口返回 HTTP ${response.status()}`);
    await mkdir(this.paths.root, { recursive: true }).catch(() => {});
    const afterApplyDiagnostics = [];
    for (const [index, scope] of this.editor.contexts().entries()) {
      const body = await scope.locator("body").innerHTML().catch(() => "");
      const evidence = await scope.locator("[data-block-uuid='ai-productlist'], .ai-generated-block").evaluateAll((nodes) => nodes.map((node) => ({
        cls: String(node.className ?? ""),
        cards: node.querySelectorAll("li.prodlist-site-block").length,
        text: (node.innerText ?? "").slice(0, 180),
      }))).catch(() => []);
      afterApplyDiagnostics.push({ index, url: scope.url?.() ?? "", evidence });
      await writeFile(`${this.paths.root}/after-apply-context-${index}.html`, body, "utf8").catch(() => {});
    }
    await writeFile(`${this.paths.root}/after-apply-diagnostics.json`, `${JSON.stringify({ responseStatus: response?.status() ?? null, contexts: afterApplyDiagnostics }, null, 2)}\n`, "utf8").catch(() => {});
    await this.editor.page.screenshot({ path: `${this.paths.root}/after-apply.png`, fullPage: false }).catch(() => {});
    if (!committed) {
      const diagnostic = {
        source: "history",
        history_marker: record.history_marker,
        selected_control: { mode: next.mode, frame_url: sanitizeFrameUrl(applyTarget.scope.url?.() ?? ""), text: normalize(await apply.innerText().catch(() => "")) },
        response_status: response?.status() ?? null,
        committed_matches: await this.blockMatches({ canvasOnly: true }).then((matches) => matches.length).catch(() => null),
        contexts: afterApplyDiagnostics.map(({ index, url, evidence }) => ({ index, url: sanitizeFrameUrl(url), evidence })),
      };
      await writeFile(`${this.paths.root}/history-apply-failure.json`, `${JSON.stringify(diagnostic, null, 2)}\n`, "utf8").catch(() => {});
      throw new Error(`产品列表历史应用后画布无区块（操作层=${sanitizeFrameUrl(applyTarget.scope.url?.() ?? "")}；保存请求=${response ? response.status() : "未触发"}），拒绝标记应用成功`);
    }
    markTypeApplied(this.state, record);
    await this.persist();
    const closeTarget = await visibleControl((scope) => scope.locator(".close-icon-container").first());
    const close = closeTarget?.control ?? frame.locator(".close-icon-container").first();
    if (await visible(close)) await close.click({ force: true });
    await this.base.dismissAiExitPrompt();
    await this.editor.page.waitForTimeout(this.mode.applyIntervalMs);
    await this.configureSettings(record);
    await this.verifyCommittedSettings(record);
  }

  historyCards(frame) {
    return frame.locator(`${this.config.selectors.aiHistoryCardSelector}, .ai-generation-card, [data-history-id]`);
  }

  async openHistoryPanel(frame, trigger) {
    const cards = this.historyCards(frame);
    const isHistoryView = async () => {
      const count = await cards.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        if (await visible(cards.nth(index))) return true;
      }
      return false;
    };
    await trigger.click({ force: true }).catch(async () => trigger.evaluate((element) => element.click()));
    if (await waitFor(isHistoryView, 1200, "生成记录面板切换", 100).catch(() => false)) return true;
    // Some builds attach the Vue listener to the native target rather than
    // the Playwright click path. Dispatch a trusted-looking bubbling event
    // and require the view state to change before scanning records.
    await trigger.evaluate((element) => {
      element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
      element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
      element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    }).catch(() => {});
    return waitFor(isHistoryView, this.config.timeouts.actionMs, "生成记录面板切换", 100).catch(() => false);
  }

  async reopenProductListHistory(record) {
    const deadline = Date.now() + this.config.timeouts.blockRenderMs;
    let lastReason = "";
    while (Date.now() < deadline) {
      let frame = await this.base.openAiDialog();
      await waitFor(async () => {
        const current = this.base.aiFrame();
        return current && await visible(current.locator(this.config.selectors.aiHistoryTriggerSelector).first()) ? current : false;
      }, this.config.timeouts.actionMs, "AI 生成记录入口加载").then((current) => { if (current) frame = current; }).catch(() => {});
      const trigger = frame.locator(this.config.selectors.aiHistoryTriggerSelector).first();
      if (!(await visible(trigger))) {
        lastReason = "未找到生成记录入口";
        await this.editor.page.waitForTimeout(500);
        continue;
      }
      const cards = this.historyCards(frame);
      const historyVisible = async () => {
        for (let index = 0, count = await cards.count().catch(() => 0); index < count; index += 1) {
          if (await visible(cards.nth(index))) return true;
        }
        return false;
      };
      if (!(await historyVisible()) && !(await this.openHistoryPanel(frame, trigger))) {
        lastReason = "点击生成记录后仍停留在生成表单";
        const body = await frame.locator("body").innerHTML().catch(() => "");
        await mkdir(this.paths.root, { recursive: true }).catch(() => {});
        await writeFile(`${this.paths.root}/history-panel-not-open-${Date.now()}.html`, body, "utf8").catch(() => {});
        const close = frame.locator(".close-icon-container").first();
        if (await visible(close)) await close.click({ force: true }).catch(() => {});
        await this.editor.page.waitForTimeout(500);
        continue;
      }
      const historyLoaded = await waitFor(historyVisible, this.config.timeouts.actionMs, "产品列表生成记录列表").catch(() => false);
      if (!historyLoaded) {
        lastReason = "生成记录入口已触发，但未出现可见记录卡片";
        const close = frame.locator(".close-icon-container").first();
        if (await visible(close)) await close.click({ force: true }).catch(() => {});
        await this.editor.page.waitForTimeout(500);
        continue;
      }

      let matches = [];
      let count = 0;
      // History exposes only a virtual/infinite slice of the newest records.
      // Scan the visible slice, then advance its own scroll container while
      // keeping the dialog open; reopening resets the list to the newest page.
      for (let slice = 0; slice < 40; slice += 1) {
        count = await cards.count().catch(() => 0);
        matches = [];
        for (let index = 0; index < count; index += 1) {
          const candidate = cards.nth(index);
          if (!(await visible(candidate))) continue;
          const text = normalize(await candidate.innerText().catch(() => ""));
          const markerMatches = [record.history_marker, record.prompt, record.original_prompt]
            .filter(Boolean)
            .some((marker) => text.includes(String(marker).slice(0, 80)));
          if (markerMatches) matches.push(candidate);
        }
        if (matches.length || count === 0) break;
        const scrollState = await cards.first().evaluate((node) => {
          const ancestors = [];
          for (let current = node.parentElement; current && current !== document.body; current = current.parentElement) {
            const style = getComputedStyle(current);
            if (current.scrollHeight > current.clientHeight + 8 && /(auto|scroll)/.test(`${style.overflowY} ${style.overflow}`)) {
              ancestors.push({ node: current, before: current.scrollTop, max: current.scrollHeight - current.clientHeight });
            }
          }
          const target = ancestors[0] ?? (node.parentElement?.scrollHeight > node.parentElement?.clientHeight + 8
            ? { node: node.parentElement, before: node.parentElement.scrollTop, max: node.parentElement.scrollHeight - node.parentElement.clientHeight }
            : null);
          if (!target || target.max <= 0 || target.before >= target.max - 2) return { moved: false, containers: ancestors.map(({ node: item, before, max }) => ({ className: String(item.className ?? ""), before, max })) };
          target.node.scrollTop = target.max;
          target.node.dispatchEvent(new Event("scroll", { bubbles: true }));
          return { moved: true, className: String(target.node.className ?? ""), before: target.before, after: target.node.scrollTop, max: target.node.scrollHeight - target.node.clientHeight, containers: ancestors.map(({ node: item, before, max }) => ({ className: String(item.className ?? ""), before, max })) };
        }).catch(() => ({ moved: false, containers: [] }));
        if (!scrollState.moved) {
          this.record().history_scan = { slices_scanned: slice + 1, last_count: count, scroll_state: scrollState };
          break;
        }
        await this.editor.page.waitForTimeout(450);
        this.record().history_scan = { slices_scanned: slice + 1, last_count: count, scroll_state: scrollState };
      }
      if (count === 0) {
        const body = await frame.locator("body").innerHTML().catch(() => "");
        await mkdir(this.paths.root, { recursive: true }).catch(() => {});
        await writeFile(`${this.paths.root}/history-attempt-${Date.now()}.html`, body, "utf8").catch(() => {});
      }
      if (matches.length === 0) {
        const candidates = [];
        for (let index = 0; index < count; index += 1) {
          const candidate = cards.nth(index);
          candidates.push({
            visible: await visible(candidate),
            text: normalize(await candidate.innerText().catch(() => "")).slice(0, 500),
            id: await candidate.getAttribute("data-id").catch(() => ""),
            className: await candidate.getAttribute("class").catch(() => ""),
          });
        }
        const controls = await frame.locator(".ai-block-dialog button, .ai-block-dialog a, .ai-block-dialog [role='button']").evaluateAll((nodes) => nodes
          .filter((node) => {
            const style = getComputedStyle(node);
            const rect = node.getBoundingClientRect();
            return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
          })
          .map((node) => ({
            text: (node.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 100),
            aria: node.getAttribute("aria-label") ?? "",
            title: node.getAttribute("title") ?? "",
            className: String(node.className ?? ""),
          }))).catch(() => []);
        await mkdir(this.paths.root, { recursive: true }).catch(() => {});
        await writeFile(`${this.paths.root}/history-no-match-${Date.now()}.json`, `${JSON.stringify({ count, candidates, controls, targetMarker: record.history_marker }, null, 2)}\n`, "utf8").catch(() => {});
        await this.editor.page.screenshot({ path: `${this.paths.root}/history-no-match-${Date.now()}.png` }).catch(() => {});
      }
      if (matches.length > 1) {
        const candidateEvidence = [];
        for (let index = 0; index < count; index += 1) {
          const candidate = cards.nth(index);
          candidateEvidence.push({ text: normalize(await candidate.innerText().catch(() => "")), id: await candidate.getAttribute("data-id").catch(() => "") });
        }
        await writeFile(`${this.paths.root}/history-candidates.json`, `${JSON.stringify(candidateEvidence, null, 2)}\n`, "utf8").catch(() => {});
        throw new Error(`产品列表生成记录匹配到 ${matches.length} 条，拒绝不确定插入`);
      }
      if (matches.length === 0 && count === 1) {
        const only = cards.first();
        const onlyText = normalize(await only.innerText().catch(() => ""));
        if (onlyText && (!record.type || onlyText.includes(record.type))) matches.push(only);
      }
      if (matches.length === 1) {
        const card = matches[0];
        const cardText = normalize(await card.innerText().catch(() => ""));
        if (/生成失败|失败，点数将自动退还/.test(cardText) || (await card.getAttribute("class").catch(() => "")).includes("is-failed")) {
          throw new Error(`产品列表生成失败：${cardText.slice(-300)}`);
        }
        const insert = await firstVisible([
          card.locator(this.config.selectors.aiHistoryInsertSelector).first(),
          card.getByRole("button", { name: /插入|应用模块/ }).first(),
          card.getByText(/插入|应用模块/).first(),
        ]);
        if (insert) return { frame, card, insert };
        lastReason = "目标生成记录仍未出现插入按钮";
      } else {
        lastReason = count ? `生成记录未唯一匹配（当前 ${count} 条）` : "生成记录列表为空";
      }
      const close = frame.locator(".close-icon-container").first();
      if (await visible(close)) await close.click({ force: true }).catch(() => {});
      await this.editor.page.waitForTimeout(Math.min(1000, this.config.timeouts.actionMs));
    }
    const debug = [];
    for (const scope of this.editor.contexts()) {
      const body = await scope.locator("body").innerHTML().catch(() => "");
      if (body) debug.push(`<!-- ${scope.url?.() ?? "frame"} -->\n${body}`);
    }
    await mkdir(this.paths.root, { recursive: true }).catch(() => {});
    await writeFile(`${this.paths.root}/history-failure.html`, debug.join("\n"), "utf8").catch(() => {});
    throw new Error(`产品列表历史生成记录等待超时${lastReason ? `：${lastReason}` : ""}`);
  }

  async generateRecordOnly(record) {
    if (record.history_source_run_id || record.application_source === "history") {
      throw new Error("当前记录来自历史复用状态，不能进入本轮重新生成分支");
    }
    await this.base.generateAndApply(record);
  }

  async run(options = {}) {
    const startedAt = Date.now();
    try {
      return await this.runInternal(options);
    } finally {
      if (this.state?.type) {
        const record = this.state.type;
        const duration = Date.now() - startedAt;
        record.run_attempts = Number(record.run_attempts ?? 0) + 1;
        record.last_run_started_at = new Date(startedAt).toISOString();
        record.last_run_duration_ms = duration;
        record.total_run_duration_ms = Number(record.total_run_duration_ms ?? 0) + duration;
        record.last_run_completed_at = new Date().toISOString();
        await this.persist().catch(() => {});
      }
    }
  }

  async runInternal({ resume = false } = {}) {
    const init = await this.initialize({ resume });
    const record = this.record();
    // The state file can outlive a browser session in which the final apply
    // looked successful but the committed page did not retain the block. On
    // a settings-only resume, reconcile that claim against the current 3.0
    // canvas before touching settings. Reinsert only from the existing
    // generation record when the canvas has zero matching blocks; duplicates
    // or a saved page with a missing block remain a hard stop.
    if (resume && record.apply_status === "applied" && record.settings_status !== "succeeded") {
      const committed = await waitFor(async () => {
        const matches = await this.blockMatches({ canvasOnly: true });
        return matches.length ? matches : false;
      }, this.config.timeouts.blockRenderMs, "恢复时已保存产品列表区块加载").catch(() => []);
      if (committed.length > 1) {
        throw new Error(`恢复时产品列表区块匹配到 ${committed.length} 个，拒绝继续以免重复插入`);
      }
      if (committed.length === 0) {
        const safeHistoryRestore = this.mode.productScopeOnly === true
          && record.application_source === "history"
          && record.generation_status === "succeeded"
          && !this.state.page.published_verified
          && this.state.page.name.endsWith(this.runId)
          && record.history_marker;
        if (this.state.page.published_verified) {
          throw new Error("状态显示产品列表已应用，但已保存页面中未找到区块；停止自动修复，请人工检查");
        }
        if (this.state.page.saved && !safeHistoryRestore) {
          throw new Error("状态显示产品列表已应用，但已保存页面中未找到区块；停止自动修复，请人工检查");
        }
        if (this.state.page.saved && safeHistoryRestore) {
          // A history-sourced block on this unique, unpublished run page can
          // be restored without regenerating or spending points. The saved
          // canvas was verified empty before clearing the stale applied flag.
          record.recovery_log ??= [];
          record.recovery_log.push({
            action: "reinsert-from-existing-history-record",
            reason: "saved run-owned page reopened without the previously applied block",
            checked_at: new Date().toISOString(),
            page_name: this.state.page.name,
            history_marker: record.history_marker,
          });
          this.state.page.saved = false;
          this.state.page.editor_verified = false;
          this.state.page.types = (this.state.page.types ?? []).filter((type) => type !== record.type);
          record.settings_status = "failed";
          record.settings_failure_reason = "保存后重开未找到区块；已确认页面未发布，将从现有生成记录恢复，不重新生成";
        }
        record.apply_status = "pending";
        record.recovery_required = false;
        this.state.page.types = (this.state.page.types ?? []).filter((type) => type !== record.type);
        await this.persist();
      }
    }
    const recoverableSettingsFailure =
      record.recovery_required &&
      record.generation_status === "succeeded" &&
      record.apply_status === "applied" &&
      record.settings_status === "failed";
    const safeToResumeUnappliedHistory =
      record.generation_status === "succeeded" &&
      record.apply_status === "pending" &&
      !this.state.page.saved &&
      !this.state.page.published_verified;
    if (record.recovery_required && !recoverableSettingsFailure && !safeToResumeUnappliedHistory) {
      throw new Error("产品列表生成或设置状态不确定，请人工检查后再恢复");
    }
    if (resume && this.mode.productScopeOnly === true) {
      const scopeAction = productScopeResumeAction(this.state, {
        categoryName: this.mode.productScopeCategoryName,
        expectedCount: Number(this.mode.productScopeExpectedCount),
      });
      if (scopeAction === "reapply-scope-and-revalidate") {
        record.recovery_log ??= [];
        record.recovery_log.push({
          action: scopeAction,
          reason: "saved preview did not prove that the selected category controls the rendered product IDs/count",
          checked_at: new Date().toISOString(),
          page_name: this.state.page.name,
          category: this.mode.productScopeCategoryName,
          expected_count: Number(this.mode.productScopeExpectedCount),
          previous_preview_failure: record.result_checks.preview?.evidence?.reason ?? "",
        });
        this.state.page.saved = false;
        this.state.page.preview_verified = false;
        record.preview_verified = false;
        record.settings_status = "failed";
        record.settings_failure_reason = "分类设置此前未通过预览产品 ID/数量断言；从已有区块重新应用分类设置，不重新生成";
        record.result_checks.preview = { status: "pending", evidence: { prior_failure: record.result_checks.preview?.evidence ?? null, retry: "reapply-scope" } };
        record.result_checks.product_scope = { status: "pending", evidence: { prior_failure: record.result_checks.product_scope?.evidence ?? null, category: this.mode.productScopeCategoryName, expected_count: Number(this.mode.productScopeExpectedCount) } };
        await this.persist();
      }
    }
    if (resume && this.state.page.saved && this.state.page.preview_verified && this.state.page.published_verified) {
      if (this.mode.productScopeOnly === true && record.result_checks.product_scope?.status === "passed") {
        markProductScopeEffect(record, record.result_checks.product_scope.evidence?.after_published);
      }
      for (const [key, check] of Object.entries({
        sort: "sort",
        loading: "loading_pagination",
        page_size: "page_size",
        display_content: "display_field",
        base_color: "base_color",
      })) {
        if (record.result_checks[check]?.status === "passed") this.settingRecord(record, key).status = "succeeded";
      }
      await this.persist();
      return this.state;
    }
    if (record.apply_status !== "applied") {
      try {
        // New runs always invoke AI generation and apply that newly generated
        // result. Existing history insertion is reserved for runs explicitly
        // seeded from a successful source record.
        if (record.generation_status === "pending") await this.generateRecordOnly(record);
        if (record.generation_status === "succeeded" && record.apply_status !== "applied") {
          await this.recoverGeneratedResult(record);
        }
      } catch (error) {
        record.failure_reason = error.message;
        record.recovery_required = !(record.generation_status === "succeeded" && record.apply_status === "pending" && !this.state.page.saved && !this.state.page.published_verified);
        await this.persist();
        throw error;
      }
    } else if (["configured", "partial"].includes(record.settings_status) && !this.state.page.saved) {
      try {
        await this.verifyCommittedSettings(record);
      } catch (error) {
        record.settings_status = "failed";
        record.settings_failure_reason = error.message;
        record.failure_reason = error.message;
        await this.persist();
        throw error;
      }
    } else if (["configured", "partial"].includes(record.settings_status) && this.state.page.saved) {
      // A resumed editor canvas can hydrate all product records even when the
      // saved page's rendered preview honors pagination. Once the page is
      // saved, use preview/public output as the result-level source of truth.
      // Rechecking its editor-only card count can falsely report 9 instead of
      // the configured five-card page size.
    } else if (record.settings_status !== "succeeded") {
      // The block was already committed in a previous attempt. Resume only
      // the settings verification; never regenerate or insert another block.
      try {
        await this.configureSettings(record);
        await this.verifyCommittedSettings(record);
      } catch (error) {
        record.settings_status = "failed";
        record.settings_failure_reason = error.message;
        record.failure_reason = error.message;
        await this.persist();
        throw error;
      }
    }
    if (!["succeeded", "partial"].includes(record.settings_status)) throw new Error("产品列表设置未完成，拒绝继续保存页面");
    record.editor_verified = await this.verifyEditorBlock();
    this.state.page.editor_verified = record.editor_verified;
    if (!this.state.page.saved) { await this.editor.savePage(); this.state.page.saved = true; await this.persist(); }
    if (!this.record().result_checks.preview || this.record().result_checks.preview.status !== "passed") {
      await this.verifyProductListPreviewWithRetry();
    }
    if (!this.state.page.published_verified) {
      this.state.page.publish_status = "running"; await this.persist();
      await this.editor.publishSite(); this.state.page.publish_status = "accepted"; await this.persist();
      await this.base.verifyPublished();
    }
    if (!this.record().result_checks.published || this.record().result_checks.published.status !== "passed") {
      await this.verifyProductListPublicPage();
    }
    return this.state;
  }

  async cleanup() {
    await this.initialize({ resume: false });
    if (this.state.page.cleanup_status === "completed") return this.state;
    const matches = await this.blockMatches({ canvasOnly: true });
    if (matches.length > 1) throw new Error(`产品列表清理匹配数量=${matches.length}，拒绝删除`);
    if (matches.length === 1) {
      const identity = this.record().block_identity;
      const result = await this.editor.deleteAiBlock({ identity, apply: true });
      if (!result.applied) throw new Error("产品列表区块删除未确认");
      await this.editor.savePage();
    }
    await this.editor.deleteCustomPage(this.state.page.name, { apply: true });
    this.state.page.cleanup_status = "completed";
    await this.persist();
    return this.state;
  }
}
