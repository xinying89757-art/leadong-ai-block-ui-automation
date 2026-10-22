import { mkdir, writeFile } from "node:fs/promises";
import { AiBlockAutomation } from "./ai-runner.mjs";
import { markTypeApplied } from "./ai-state.mjs";
import {
  assertNavigationState,
  createNavigationState,
  navigationDescriptor,
  navigationPaths,
  navigationResumeAction,
  readNavigationJson,
  writeNavigationJson,
} from "./ai-navigation-state.mjs";

async function waitFor(check, timeoutMs, label, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`${label}等待超时${lastError ? `：${lastError.message}` : ""}`);
}

async function visible(locator) { return Boolean(locator) && locator.isVisible().catch(() => false); }

async function firstVisible(locators) {
  for (const locator of locators) if (await visible(locator)) return locator;
  return null;
}

async function firstPresent(locators) {
  for (const locator of locators) if (locator && await locator.count().catch(() => 0)) return locator;
  return null;
}

function navigationBlockLocator(frame, selectors) {
  return frame.locator(
    `.block-container[class*='block-settingId-ai-copilot'], div.siteblocks-setting-wrap, ${selectors.aiGeneratedBlockSelector}`,
  ).filter({
    has: frame.locator(`section[class*='block-settingId-ai-copilot'], ${selectors.aiGeneratedBlockSelector}, .block-settingId-ai-copilot`),
  });
}

export function navigationPage(config) { return navigationDescriptor(config); }

export function selectNavigationPages(pages, currentPageName, count = 2) {
  const seen = new Set();
  const result = [];
  for (const page of pages) {
    const name = String(page.name ?? "").trim();
    if (!name || name === currentPageName || seen.has(name) || page.visible === false || page.system === true) continue;
    seen.add(name);
    result.push({ name, path: page.path ?? "", publicUrl: page.publicUrl ?? "" });
    if (result.length === count) break;
  }
  if (result.length !== count) throw new Error(`导航可选自定义页面不足 ${count} 张`);
  return result;
}

export class AiNavigationAutomation {
  constructor(editor, config, runId) {
    this.editor = editor;
    this.config = config;
    this.mode = config.ai.navigationRegression;
    this.runId = runId;
    this.paths = navigationPaths(config, runId);
    this.state = null;
    const scopedConfig = {
      ...config,
      ai: {
        ...config.ai,
        types: [this.mode.type],
        blocksPerPage: 1,
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
    this.base = new AiBlockAutomation(editor, scopedConfig, {
      load: async () => readNavigationJson(this.paths.state),
      save: async (value) => writeNavigationJson(this.paths.state, value),
    });
    // The result must be clicked before the final AI “应用”. Navigation
    // settings themselves are edited after the block is committed to the 3.0
    // canvas (select block -> 全屏编辑 -> settings drawer).
    this.base.beforeFinalApply = async ({ frame, record }) => this.prepareNavigationResult(frame, record);
    this.base.afterFinalApply = async ({ record }) => this.configureNavigationAfterApply(record);
    this.base.verifyEditorType = async () => this.verifyEditorBlock();
  }

  record() { return this.state.types[0]; }
  async persist() { await writeNavigationJson(this.paths.state, this.state); }

  async initialize({ resume = false } = {}) {
    const existing = await readNavigationJson(this.paths.state);
    if (existing) this.state = assertNavigationState(existing, this.config, this.runId);
    else {
      if (resume) throw new Error(`运行 ${this.runId} 没有导航状态，无法恢复`);
      this.state = createNavigationState(this.config, this.runId);
      await this.persist();
    }
    this.base.state = this.state;
    this.base.page = this.state.page;
    const exists = await this.editor.customPageExists(this.state.page.name);
    if (!exists) {
      if (existing && (this.state.page.types.length > 0 || this.record().generation_status !== "pending")) {
        throw new Error(`测试页 ${this.state.page.name} 已不存在，拒绝重复生成或扣点`);
      }
      await this.editor.createCustomPage(this.state.page);
    } else await this.editor.openCustomPage(this.state.page.name);
    if (!resume) return this.state;
    let action = navigationResumeAction(this.state, true);
    if (action === "verify-page") {
      const count = await this.editorBlockCount();
      if (count === 0 && !this.state.page.saved && this.record().generation_status === "succeeded") {
        // The nested AI editor was applied, but the top-level 3.0 page was
        // never saved before the browser closed. Reinsert the existing
        // generated record instead of paying for another generation.
        this.record().apply_status = "pending";
        this.record().navigation_settings.save_status = "pending";
        this.record().navigation_settings.add_status = "pending";
        this.record().editor_verified = false;
        this.record().recovery_required = false;
        await this.persist();
        action = "recover-generated-result";
      } else if (count !== 1) {
        throw new Error(`导航已应用但编辑器中匹配到 ${count} 个区块，请人工检查`);
      } else this.record().editor_verified = true;
    }
    return action;
  }

  async editorBlockCount() {
    let count = 0;
    // Only inspect the 3.0 canvas.  The temporary 4.0 AI result iframe also
    // contains a phoenix2-block-wrap and must not make an unapplied result
    // look like a committed page block.
    for (const frame of this.editor.canvasContexts()) {
      const outer = await frame.locator(".siteblocks-setting-wrap:has(.ai-navigation)").count().catch(() => 0);
      const inner = outer ? 0 : await frame.locator(".ai-generated-block:has(.ai-navigation)").count().catch(() => 0);
      count = Math.max(count, outer || inner);
    }
    return count;
  }

  async verifyEditorBlock() {
    const count = await waitFor(() => this.editorBlockCount(), this.config.timeouts.blockRenderMs, "导航编辑器区块");
    this.record().editor_verified = count === 1;
    await this.persist();
    return count === 1;
  }

  async generatedBlock(frame) {
    return waitFor(async () => {
      const candidates = this.editor.page.frames().filter((candidate) => candidate === frame || candidate.parentFrame() === frame);
      for (const resultFrame of candidates) {
        const wrappers = resultFrame.locator("body > div.phoenix2-block-wrap");
        const count = await wrappers.count().catch(() => 0);
        if (count === 1) {
          const wrapper = wrappers.first();
          const target = wrapper.locator(".ai-navigation").first();
          return { frame: resultFrame, wrapper, target: await visible(target) ? target : wrapper };
        }
        for (let index = 0; index < count; index += 1) {
          const wrapper = wrappers.nth(index);
          const text = await wrapper.innerText().catch(() => "");
          if (/navigation|menu|contact|solar/i.test(text)) {
            const target = wrapper.locator(".ai-navigation").first();
            return { frame: resultFrame, wrapper, target: await visible(target) ? target : wrapper };
          }
        }
      }
      return false;
    }, this.config.timeouts.blockRenderMs, "导航生成区块");
  }

  async settingButton(frame) {
    const configured = frame.locator(this.config.selectors.aiBlockSettingsButtonSelector);
    return firstVisible([
      configured,
      frame.getByRole("button", { name: /设置/ }).first(),
      frame.getByLabel(/设置/).first(),
      frame.getByTitle(/设置/).first(),
    ]);
  }

  async settingsPanel() {
    return waitFor(async () => {
      for (const scope of this.editor.contexts()) {
        const texts = scope.getByText(/编辑导航/, { exact: true });
        if (await visible(texts.first())) return texts.first().locator("xpath=ancestor::*[.//*[normalize-space()='编辑导航']][1]");
      }
      return false;
    }, this.config.timeouts.actionMs, "导航设置侧边栏");
  }

  async navigationDialog() {
    return waitFor(async () => {
      for (const scope of this.editor.contexts()) {
        const candidates = [
          scope.getByRole("dialog", { name: "管理导航" }).first(),
          scope.locator(".layui-layer:visible, .el-dialog:visible, [role='dialog']:visible"),
        ];
        for (const candidate of candidates) {
          const count = await candidate.count().catch(() => 0);
          for (let index = 0; index < count; index += 1) {
            const item = candidate.nth(index);
            const text = await item.innerText().catch(() => "");
            // Element UI renders “站内页面” as a select value, which is not
            // always included in innerText. The named dialog and its Save
            // button are stable evidence that the editor is ready.
            if (await visible(item) && /管理导航/.test(text) && /保存/.test(text)) return item;
          }
        }
      }
      return false;
    }, this.config.timeouts.actionMs, "编辑导航弹窗");
  }

  async pageCandidates(dialog) {
    const labels = dialog.locator(".lead-nav-container.left .el-checkbox-group label.el-checkbox");
    const count = await labels.count().catch(() => 0);
    const pages = [];
    for (let index = 0; index < count; index += 1) {
      const label = labels.nth(index);
      if (!(await visible(label))) continue;
      if (!(await label.locator("input[type='checkbox']").count().catch(() => 0))) continue;
      const name = (await label.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
      if (!name || /全选|站内页面/.test(name)) continue;
      const input = label.locator("input[type='checkbox']").first();
      if (await input.isDisabled().catch(() => false)) continue;
      const path = await label.getAttribute("pageurl").catch(() => "") || await label.getAttribute("data-pageurl").catch(() => "");
      pages.push({ label, input, name, path, publicUrl: path });
    }
    if (pages.length === 0) {
      const inputs = dialog.locator("input[type='checkbox']");
      const inputCount = await inputs.count().catch(() => 0);
      for (let index = 0; index < inputCount; index += 1) {
        const input = inputs.nth(index);
        const row = input.locator("xpath=ancestor::*[self::li or contains(@class,'checkbox') or contains(@class,'page')][1]");
        if (!(await visible(row))) continue;
        if (await input.isDisabled().catch(() => false)) continue;
        const name = (await row.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
        if (!name || /全选|站内页面/.test(name)) continue;
        const path = await row.getAttribute("pageurl").catch(() => "") || await row.getAttribute("data-pageurl").catch(() => "") || "";
        pages.push({ label: row, input, name, path, publicUrl: path });
      }
    }
    return pages;
  }

  async applyNavigationDialog(dialog, settings) {
    const candidates = await waitFor(async () => {
      const loaded = await this.pageCandidates(dialog);
      try {
        selectNavigationPages(loaded.map((item) => ({ name: item.name, path: item.path, publicUrl: item.publicUrl })), this.state.page.name, this.mode.selectPageCount);
        return loaded;
      } catch { return false; }
    }, this.config.timeouts.blockRenderMs, "导航自定义页面列表加载");
    const selected = selectNavigationPages(
      candidates.map((item) => ({ name: item.name, path: item.path, publicUrl: item.publicUrl })),
      this.state.page.name,
      this.mode.selectPageCount,
    );
    const selectedNames = new Set(selected.map((item) => item.name));
    for (const item of candidates) {
      const shouldBeChecked = selectedNames.has(item.name);
      const isChecked = await item.input.isChecked().catch(() => false);
      if (shouldBeChecked !== isChecked) await item.label.click({ force: true });
    }
    await waitFor(async () => {
      for (const item of candidates) {
        const expected = selectedNames.has(item.name);
        if ((await item.input.isChecked().catch(() => false)) !== expected) return false;
      }
      return true;
    }, this.config.timeouts.actionMs, "导航页面勾选状态");
    const checked = [];
    for (const item of candidates) if (await item.input.isChecked().catch(() => false)) checked.push(item);
    if (checked.length !== this.mode.selectPageCount) {
      await mkdir(this.paths.root, { recursive: true }).catch(() => {});
      await writeFile(`${this.paths.root}/navigation-selection-failure.html`, await dialog.evaluate((element) => element.outerHTML).catch(() => ""), "utf8").catch(() => {});
      await this.editor.page.screenshot({ path: `${this.paths.root}/navigation-selection-failure.png`, fullPage: false }).catch(() => {});
      throw new Error(`导航已选择数量不是 ${this.mode.selectPageCount}`);
    }
    settings.selected_pages = selected;
    settings.selected_count = selected.length;
    settings.add_status = "running";
    const add = dialog.locator(".lead-checkbox-url-footer").getByRole("button", { name: "添加", exact: true }).first();
    if (!(await visible(add))) throw new Error("编辑导航弹窗中未找到页面列表下方的“添加”按钮");
    await waitFor(async () => (await dialog.locator(".lead-checkbox-url-footer").innerText().catch(() => "")).includes(`已选择：${this.mode.selectPageCount}个`), this.config.timeouts.actionMs, "导航已选择数量");
    await add.click({ force: true });
    await waitFor(async () => {
      const text = await dialog.locator(".lead-nav-drag-container").innerText().catch(() => "");
      return selected.every((page) => text.includes(page.name));
    }, this.config.timeouts.actionMs, "导航选项添加到编辑区");
    settings.add_status = "succeeded";
    await this.persist();
    const save = await firstVisible([
      dialog.getByRole("button", { name: "保存", exact: true }).last(),
      dialog.getByText("保存", { exact: true }).last(),
    ]);
    if (!save) throw new Error("编辑导航弹窗中未找到“保存”按钮");
    await save.click({ force: true });
    await waitFor(async () => !(await visible(dialog)) || /保存成功/.test(await dialog.innerText().catch(() => "")), this.config.timeouts.actionMs, "导航配置保存");
    settings.save_status = "succeeded";
    settings.applied_at = new Date().toISOString();
    settings.failure_reason = "";
    await this.persist();
  }

  async prepareNavigationResult(frame, record) {
    const settings = record.navigation_settings;
    settings.selection_status = "running";
    settings.failure_reason = "";
    await this.persist();
    try {
      const match = await this.generatedBlock(frame);
      await match.wrapper.scrollIntoViewIfNeeded().catch(() => {});
      // Required by the UI: click the generated result before the final AI
      // “应用”. Navigation settings are edited after it is committed to 3.0.
      // Select the wrapper, not only the inner navigation node.  GrapesJS
      // listens for the wrapper component-selection event; an inner-node
      // click can look successful while leaving the final 应用 disabled.
      await match.wrapper.click({ force: true, position: { x: 100, y: 80 } });
      settings.selection_status = "succeeded";
      await this.persist();
    } catch (error) {
      settings.failure_reason = error.message;
      await mkdir(this.paths.root, { recursive: true });
      await this.editor.page.screenshot({ path: `${this.paths.root}/navigation-preapply-failure.png`, fullPage: false }).catch(() => {});
      await writeFile(`${this.paths.root}/navigation-frame.html`, await frame.locator("body").innerHTML().catch(() => ""), "utf8").catch(() => {});
      await this.persist();
      throw error;
    }
  }

  // Kept below for reference while calibrating older builds; new runs use
  // prepareNavigationResult followed by configureNavigationAfterApply.
  async legacyConfigureNavigationBeforeApply(frame, record) {
    const settings = record.navigation_settings;
    settings.selection_status = "running";
    settings.toolbar_status = "pending";
    settings.panel_status = "pending";
    settings.edit_navigation_status = "pending";
    settings.add_status = "pending";
    settings.save_status = "pending";
    settings.failure_reason = "";
    await this.persist();
    try {
      const match = await this.generatedBlock(frame);
      await match.wrapper.scrollIntoViewIfNeeded().catch(() => {});
      await match.target.click({ force: true });
      settings.selection_status = "succeeded";
      await this.persist();
      let gear = await waitFor(async () => firstPresent([
        match.wrapper.locator(".mask_container_Setting_settingBtn").first(),
        match.wrapper.locator("[title='设置'], [aria-label='设置']").first(),
        match.frame.locator(this.config.selectors.aiBlockSettingsButtonSelector).first(),
      ]), 3000, "导航区块 toolbar 设置按钮").catch(() => null);
      if (!gear) {
        // Navigation placeholders often listen on the canvas body rather than
        // the text node. Retry with the block center before giving up.
        const box = await match.wrapper.boundingBox().catch(() => null);
        if (box) await match.wrapper.click({ force: true, position: { x: Math.max(1, box.width / 2), y: Math.max(1, box.height / 2) } }).catch(() => {});
        gear = await waitFor(async () => firstPresent([
          match.wrapper.locator(".mask_container_Setting_settingBtn").first(),
          match.wrapper.locator("[title='设置'], [aria-label='设置']").first(),
          match.frame.locator(this.config.selectors.aiBlockSettingsButtonSelector).first(),
        ]), this.config.timeouts.actionMs, "导航区块 toolbar 设置按钮");
      }
      await gear.click({ force: true }).catch(async () => { await gear.evaluate((element) => element.click()); });
      settings.toolbar_status = "succeeded";
      await this.persist();
      const panel = await this.settingsPanel();
      settings.panel_status = "succeeded";
      const edit = await firstVisible([
        panel.getByText("编辑导航", { exact: true }).first(),
        panel.getByRole("button", { name: "编辑导航", exact: true }).first(),
      ]);
      if (!edit) throw new Error("导航设置面板中未找到“编辑导航”");
      await edit.click({ force: true });
      settings.edit_navigation_status = "succeeded";
      const dialog = await this.navigationDialog();
      const candidates = await this.pageCandidates(dialog);
      const selected = selectNavigationPages(candidates.map((item) => ({ name: item.name, path: item.path, publicUrl: item.publicUrl })), this.state.page.name, this.mode.selectPageCount);
      const selectedNames = new Set(selected.map((item) => item.name));
      for (const item of candidates) {
        if (!selectedNames.has(item.name)) continue;
        if (!(await item.input.isChecked().catch(() => false))) await item.label.click({ force: true });
      }
      const selectedCountText = await dialog.innerText();
      if (!new RegExp(`已选择\\s*[：:]?\\s*${this.mode.selectPageCount}\\s*个`).test(selectedCountText.replace(/\s+/g, ""))) {
        const checked = [];
        for (const item of candidates) if (await item.input.isChecked().catch(() => false)) checked.push(item);
        if (checked.length !== this.mode.selectPageCount) throw new Error(`导航已选择数量不是 ${this.mode.selectPageCount}`);
      }
      settings.selected_pages = selected;
      settings.selected_count = selected.length;
      settings.add_status = "running";
      const add = await firstVisible([
        dialog.getByRole("button", { name: "添加", exact: true }).first(),
        dialog.getByText("添加", { exact: true }).first(),
      ]);
      if (!add) throw new Error("编辑导航弹窗中未找到“添加”按钮");
      await add.click({ force: true });
      settings.add_status = "succeeded";
      await this.persist();
      const save = await firstVisible([
        dialog.getByRole("button", { name: "保存", exact: true }).last(),
        dialog.getByText("保存", { exact: true }).last(),
      ]);
      if (!save) throw new Error("编辑导航弹窗中未找到“保存”按钮");
      await save.click({ force: true });
      await waitFor(async () => !(await visible(dialog)) || /保存成功/.test(await dialog.innerText().catch(() => "")), this.config.timeouts.actionMs, "导航配置保存");
      settings.save_status = "succeeded";
      settings.applied_at = new Date().toISOString();
      settings.failure_reason = "";
      await writeFile(`${this.paths.root}/navigation-settings.html`, await dialog.evaluate((element) => element.outerHTML).catch(() => ""), "utf8").catch(() => {});
      await this.editor.page.screenshot({ path: `${this.paths.root}/navigation-settings.png`, fullPage: false }).catch(() => {});
      await this.persist();
    } catch (error) {
      settings.save_status = "failed";
      settings.failure_reason = error.message;
      await mkdir(this.paths.root, { recursive: true });
      await this.editor.page.screenshot({ path: `${this.paths.root}/navigation-failure.png`, fullPage: false }).catch(() => {});
      await writeFile(`${this.paths.root}/navigation-frame.html`, await frame.locator("body").innerHTML().catch(() => ""), "utf8").catch(() => {});
      for (const [index, child] of this.editor.page.frames().entries()) {
        if (child === frame) continue;
        await writeFile(`${this.paths.root}/navigation-frame-${index}.html`, await child.locator("body").innerHTML().catch(() => ""), "utf8").catch(() => {});
      }
      await this.persist();
      throw error;
    }
  }

  async configureNavigationAfterApply(record = this.record()) {
    const settings = record.navigation_settings;
    if (settings.save_status === "succeeded") return;
    const canvasMatch = await waitFor(async () => {
      for (const frame of this.editor.canvasContexts()) {
        if (record.committed_block_id) {
          const wrapper = frame.locator(`[id=${JSON.stringify(record.committed_block_id)}]`);
          const count = await wrapper.count().catch(() => 0);
          if (count > 1) throw new Error('已应用导航区块 ID 匹配不唯一');
          if (count === 1 && await visible(wrapper)) {
            const block = wrapper.locator('.ai-navigation').first();
            return { frame, block: await visible(block) ? block : wrapper, wrapper };
          }
          continue;
        }
        // The committed block can be wrapped by a generic AI container and
        // the navigation class may be rendered one nested level below the
        // section. Prefer a wrapper that explicitly contains .ai-navigation,
        // then fall back to the last AI wrapper (navigation is the last block
        // added on page 003).
        const specific = this.editor.aiBlockWrappers(frame).filter({ has: frame.locator(".ai-navigation") });
        const specificCount = await specific.count().catch(() => 0);
        for (let index = specificCount - 1; index >= 0; index -= 1) {
          const wrapper = specific.nth(index);
          if (!(await visible(wrapper))) continue;
          const block = wrapper.locator(".ai-navigation").first();
          return { frame, block: (await visible(block)) ? block : wrapper, wrapper };
        }
        const wrappers = this.editor.aiBlockWrappers(frame);
        const count = await wrappers.count().catch(() => 0);
        if (count > 0) {
          const wrapper = wrappers.nth(count - 1);
          if (await visible(wrapper)) {
            const block = wrapper.locator(".ai-navigation").first();
            return { frame, block: (await visible(block)) ? block : wrapper, wrapper };
          }
        }
      }
      return false;
    }, this.config.timeouts.blockRenderMs, "已应用导航区块");
    await (canvasMatch.wrapper ?? canvasMatch.block).click({ force: true, position: { x: 100, y: 80 } });
    // In the current 3.0 editor a selected navigation block opens the
    // properties drawer directly. There is no intermediate gear/full-screen
    // toolbar in this path, so check for the drawer before trying legacy
    // toolbar selectors. If the inner node did not select the component,
    // retry once on its enclosing block wrapper.
    let directPanel = await waitFor(() => this.settingsPanel(), this.config.timeouts.actionMs, "导航设置侧边栏").catch(() => null);
    if (!directPanel) {
      const wrapper = canvasMatch.frame.locator(
        ".siteblocks-setting-wrap:has(.ai-navigation), .block-container[class*='block-settingId-ai-copilot']:has(.ai-navigation)",
      ).first();
      if (await visible(wrapper)) {
        await wrapper.click({ force: true, position: { x: 100, y: 80 } }).catch(() => {});
        directPanel = await waitFor(() => this.settingsPanel(), this.config.timeouts.actionMs, "导航设置侧边栏").catch(() => null);
      }
    }
    if (directPanel) {
      settings.toolbar_status = "succeeded";
      settings.panel_status = "succeeded";
      await this.persist();
      const directEdit = await firstVisible([
        directPanel.getByText("编辑导航", { exact: true }).first(),
        directPanel.getByRole("button", { name: "编辑导航", exact: true }).first(),
      ]);
      if (!directEdit) throw new Error("导航设置面板中未找到“编辑导航”");
      await directEdit.click({ force: true });
      settings.edit_navigation_status = "succeeded";
      await this.applyNavigationDialog(await this.navigationDialog(), settings);
      return;
    }
    // Some editor builds expose the navigation settings directly on the 3.0
    // block toolbar (the same gear used by 产品筛选). Prefer that route when
    // available; it avoids entering the 4.0 full-screen editor altogether.
    const directGear = await waitFor(async () => firstVisible([
      canvasMatch.block.locator(".mask_container_Setting_settingBtn:visible").first(),
      canvasMatch.frame.locator(".mask_container_Setting_settingBtn:visible").first(),
    ]), 1500, "导航区块 toolbar 设置按钮").catch(() => null);
    if (directGear) {
      settings.toolbar_status = "succeeded";
      await directGear.click({ force: true });
      const directPanel = await this.settingsPanel();
      settings.panel_status = "succeeded";
      const directEdit = await firstVisible([
        directPanel.getByText("编辑导航", { exact: true }).first(),
        directPanel.getByRole("button", { name: "编辑导航", exact: true }).first(),
      ]);
      if (!directEdit) throw new Error("导航设置面板中未找到“编辑导航”");
      await directEdit.click({ force: true });
      settings.edit_navigation_status = "succeeded";
      await this.applyNavigationDialog(await this.navigationDialog(), settings);
      return;
    }
    const toolbar = await waitFor(async () => firstVisible([
      canvasMatch.frame.locator("a.ai-block-fullscreen-edit:visible").first(),
      canvasMatch.frame.locator(".ai-block-fullscreen-edit:visible").first(),
    ]), this.config.timeouts.actionMs, "导航区块 toolbar");
    settings.toolbar_status = "succeeded";
    await toolbar.click({ force: true });

    // Full-screen edit opens a nested canvas. Clicking the actual navigation
    // block opens its right-hand settings drawer directly in this build; no
    // toolbar gear or floating sliders click is required.
    await waitFor(async () => {
      for (const candidate of this.editor.page.frames()) {
        const wrapper = candidate.locator("body > div.phoenix2-block-wrap").filter({ has: candidate.locator(".ai-navigation") }).first();
        if (await wrapper.count().catch(() => 0)) {
          const navigation = wrapper.locator(".ai-navigation .nav-empty, .ai-navigation").first();
          await navigation.click({ force: true });
          return true;
        }
      }
      return false;
    }, this.config.timeouts.actionMs, "导航全屏编辑区块选中");

    const aiFrame = await waitFor(async () => {
      for (const candidate of this.editor.page.frames()) {
        if (!(await candidate.locator(".block-setting-container").count().catch(() => 0))) continue;
        return candidate;
      }
      return false;
    }, this.config.timeouts.blockRenderMs, "导航全屏编辑器");
    const panel = await waitFor(async () => {
      const scopes = [aiFrame, ...this.editor.contexts().filter((scope) => scope !== aiFrame)];
      for (const scope of scopes) {
        const found = await firstVisible([
          scope.locator(".modules-setting-container .el-drawer:visible").filter({ hasText: /数据源|编辑导航/ }).first(),
          scope.locator(".modules-setting-container:visible").filter({ hasText: /数据源|编辑导航/ }).first(),
          scope.locator(".modules-setting-container .el-overlay:visible").filter({ hasText: /数据源|编辑导航/ }).first(),
          scope.getByText("编辑导航", { exact: true }).first().locator("xpath=ancestor::*[.//*[normalize-space()='数据源']][1]"),
        ]);
        if (found) return found;
      }
      return false;
    }, this.config.timeouts.actionMs, "导航设置侧边栏");
    settings.panel_status = "succeeded";
    await this.persist();
    const edit = await firstVisible([
      panel.getByText("编辑导航", { exact: true }).first(),
      panel.getByRole("button", { name: "编辑导航", exact: true }).first(),
    ]);
    if (!edit) throw new Error("导航设置面板中未找到“编辑导航”");
    await edit.click({ force: true });
    settings.edit_navigation_status = "succeeded";
    const dialog = await this.navigationDialog();
    const candidates = await waitFor(async () => {
      const loaded = await this.pageCandidates(dialog);
      try {
        selectNavigationPages(loaded.map((item) => ({ name: item.name, path: item.path, publicUrl: item.publicUrl })), this.state.page.name, this.mode.selectPageCount);
        return loaded;
      } catch { return false; }
    }, this.config.timeouts.blockRenderMs, "导航自定义页面列表加载");
    const selected = selectNavigationPages(
      candidates.map((item) => ({ name: item.name, path: item.path, publicUrl: item.publicUrl })),
      this.state.page.name,
      this.mode.selectPageCount,
    );
    const selectedNames = new Set(selected.map((item) => item.name));
    for (const item of candidates) {
      const shouldBeChecked = selectedNames.has(item.name);
      const isChecked = await item.input.isChecked().catch(() => false);
      if (shouldBeChecked !== isChecked) await item.label.click({ force: true });
    }
    await waitFor(async () => {
      for (const item of candidates) {
        const expected = selectedNames.has(item.name);
        if ((await item.input.isChecked().catch(() => false)) !== expected) return false;
      }
      return true;
    }, this.config.timeouts.actionMs, "导航页面勾选状态");
    const checked = [];
    for (const item of candidates) if (await item.input.isChecked().catch(() => false)) checked.push(item);
    if (checked.length !== this.mode.selectPageCount) {
      await mkdir(this.paths.root, { recursive: true }).catch(() => {});
      await writeFile(`${this.paths.root}/navigation-selection-failure-after.html`, await dialog.evaluate((element) => element.outerHTML).catch(() => ""), "utf8").catch(() => {});
      await this.editor.page.screenshot({ path: `${this.paths.root}/navigation-selection-failure-after.png`, fullPage: false }).catch(() => {});
      throw new Error(`导航已选择数量不是 ${this.mode.selectPageCount}`);
    }
    settings.selected_pages = selected;
    settings.selected_count = selected.length;
    settings.add_status = "running";
    // The button below the page list is mandatory. Save without Add drops the
    // checked pages in this dialog.
    const add = dialog.locator(".lead-checkbox-url-footer").getByRole("button", { name: "添加", exact: true }).first();
    if (!(await visible(add))) throw new Error("编辑导航弹窗中未找到页面列表下方的“添加”按钮");
    await waitFor(async () => (await dialog.locator(".lead-checkbox-url-footer").innerText().catch(() => "")).includes(`已选择：${this.mode.selectPageCount}个`), this.config.timeouts.actionMs, "导航已选择数量");
    await add.click({ force: true });
    await waitFor(async () => {
      const text = await dialog.locator(".lead-nav-drag-container").innerText().catch(() => "");
      return selected.every((page) => text.includes(page.name));
    }, this.config.timeouts.actionMs, "导航选项添加到编辑区");
    settings.add_status = "succeeded";
    await this.persist();
    const save = await firstVisible([
      dialog.getByRole("button", { name: "保存", exact: true }).last(),
      dialog.getByText("保存", { exact: true }).last(),
    ]);
    if (!save) throw new Error("编辑导航弹窗中未找到“保存”按钮");
    await save.click({ force: true });
    await waitFor(async () => !(await visible(dialog)) || /保存成功/.test(await dialog.innerText().catch(() => "")), this.config.timeouts.actionMs, "导航配置保存");
    settings.save_status = "succeeded";
    settings.applied_at = new Date().toISOString();
    settings.failure_reason = "";
    const apply = aiFrame.locator(this.config.selectors.aiApplySelector).filter({ hasText: /^应用$/ }).first();
    if (await visible(apply)) {
      await this.base.waitForAiControlReady(aiFrame, apply, "AI 应用按钮(导航设置)");
      await apply.click({ force: true });
    }
    await this.editor.page.waitForTimeout(1000);
    await this.editor.page.screenshot({ path: `${this.paths.root}/navigation-settings.png`, fullPage: false }).catch(() => {});
    await this.persist();
  }

  async recoverGeneratedResult(record) {
    const frame = await this.base.openAiDialog();
    const history = frame.locator("button.ai-history-trigger").first();
    if (await visible(history)) await history.evaluate((element) => element.click());
    const promptNeedle = (record.polished_prompt || record.prompt || "").trim().slice(0, 80);
    const card = await waitFor(async () => {
      const cards = frame.locator(this.config.selectors.aiHistoryCardSelector);
      const count = await cards.count().catch(() => 0);
      const typeMatches = [];
      for (let index = 0; index < count; index += 1) {
        const candidate = cards.nth(index);
        const text = await candidate.innerText().catch(() => "");
        if (!text.includes(record.type)) continue;
        typeMatches.push({ candidate, text });
        if (promptNeedle && !text.includes(promptNeedle)) continue;
        const insert = candidate.locator("button.ai-history-insert").first();
        if (await insert.isEnabled().catch(() => false)) return candidate;
      }
      // Prompt polishing changes the text stored in the history card. If the
      // polished prompt was not persisted (for example after a transient
      // polish failure), fall back only when the type has a unique history
      // card; never guess among multiple navigation records.
      if (typeMatches.length === 1) {
        const insert = typeMatches[0].candidate.locator("button.ai-history-insert").first();
        if (await insert.isEnabled().catch(() => false)) return typeMatches[0].candidate;
      }
      return false;
    }, this.config.timeouts.blockRenderMs, "导航历史生成记录");
    const insert = await firstVisible([card.locator("button.ai-history-insert").first(), card.getByText(/插入|应用模块/).first()]);
    if (!insert) throw new Error("未找到可恢复的导航生成记录");
    // A forced click can hit the history card while its list overlay is
    // transitioning, leaving the list open and the final Apply disabled.
    // Wait for the insert request to finish and the history layer to close.
    await insert.click();
    await waitFor(async () => {
      const stillInHistory = await visible(frame.locator(this.config.selectors.aiHistoryCardSelector).first());
      const applyButton = frame.locator(this.config.selectors.aiApplySelector).filter({ hasText: /^应用$/ }).first();
      return !stillInHistory && await visible(applyButton) && await applyButton.isEnabled().catch(() => false);
    }, this.config.timeouts.blockRenderMs, "导航历史结果插入完成");
    await this.prepareNavigationResult(frame, record);
    const apply = frame.locator(this.config.selectors.aiApplySelector).filter({ hasText: /^应用$/ }).first();
    if (!(await visible(apply))) throw new Error("恢复导航生成结果后未找到 4.0“应用”按钮");
    // In history recovery the drawer layer can sit above the button even
    // after Vue has enabled it.  Check enabled state and use a forced click;
    // the normal generation path still uses the stricter hit-test guard.
    await waitFor(async () => await visible(apply) && await apply.isEnabled().catch(() => false), this.config.timeouts.blockRenderMs, "AI 应用按钮");
    await apply.click({ force: true });
    await waitFor(async () => {
      for (const canvas of this.editor.canvasContexts()) {
        if (await canvas.locator(this.config.selectors.aiGeneratedBlockSelector).count().catch(() => 0)) return true;
      }
      return false;
    }, this.config.timeouts.blockRenderMs, "3.0 AI 区块提交").catch(() => this.editor.page.waitForTimeout(3000));
    await this.configureNavigationAfterApply(record);
    const close = frame.locator(".close-icon-container").first();
    if (await visible(close)) await close.click({ force: true });
    await this.editor.page.waitForTimeout(this.base.aiConfig.applyIntervalMs);
    if (!this.state.page.types.includes(record.type)) markTypeApplied(this.state, record);
    else record.apply_status = "applied";
    record.editor_verified = await this.verifyEditorBlock();
    await this.persist();
  }

  async verifyPublicNavigation() {
    const target = this.state.page.publicUrl;
    const page = await this.editor.page.context().newPage();
    const results = [];
    try {
      await page.goto(target, { waitUntil: "domcontentloaded" });
      for (const selected of this.record().navigation_settings.selected_pages) {
        // The navigation picker exposes page names and IDs but not paths.
        // Resolve each URL from the published navigation link itself.
        const link = page.getByRole("navigation").getByRole("link", { name: selected.name, exact: true }).first();
        await link.waitFor({ state: "visible", timeout: this.mode.publishTimeoutMs }).catch(() => {
          throw new Error(`公开导航中未找到页面链接：${selected.name}`);
        });
        const href = await link.getAttribute("href");
        if (!href || href.startsWith("javascript:")) throw new Error(`公开导航链接无效：${selected.name}`);
        const resolved = new URL(href, target);
        if (resolved.host !== new URL(this.config.publicBaseUrl).host) throw new Error(`导航链接跳往其他站点：${selected.name}`);
        if (selected.path && selected.path !== resolved.pathname) throw new Error(`导航链接路径与记录不符：${selected.name}`);
        selected.path = resolved.pathname;
        selected.publicUrl = resolved.toString();
        await link.click({ force: true });
        await page.waitForURL((url) => url.pathname === resolved.pathname, { timeout: this.mode.publishTimeoutMs });
        results.push({ name: selected.name, expectedPath: resolved.pathname, href, verified: true });
        await page.goto(target, { waitUntil: "domcontentloaded" });
      }
      this.state.page.public_navigation_verified = results.length === this.mode.selectPageCount;
      this.state.page.public_link_results = results;
      this.record().failure_reason = "";
      this.record().recovery_required = false;
      await this.persist();
      if (!this.state.page.public_navigation_verified) throw new Error("公开导航链接校验数量不符");
    } finally { await page.close(); }
  }

  async run({ resume = false } = {}) {
    const initResult = await this.initialize({ resume });
    const record = this.record();
    if (record.apply_status !== "applied") {
      try {
        if (resume && initResult === "recover-generated-result") await this.recoverGeneratedResult(record);
        else await this.base.generateAndApply(record);
      } catch (error) {
        record.failure_reason = error.message;
        record.recovery_required = record.generation_status === "succeeded";
        await mkdir(this.paths.root, { recursive: true });
        await this.editor.page.screenshot({ path: `${this.paths.root}/navigation-run-failure.png`, fullPage: false }).catch(() => {});
        for (const [index, frame] of this.editor.page.frames().entries()) {
          await writeFile(`${this.paths.root}/navigation-run-frame-${index}.html`, await frame.locator("body").innerHTML().catch(() => ""), "utf8").catch(() => {});
        }
        await this.persist();
        throw error;
      }
    }
    if (record.apply_status === "applied" && record.navigation_settings.save_status !== "succeeded") {
      try {
        const committedCount = await this.editorBlockCount().catch(() => 0);
        if (committedCount === 0 && record.generation_status === "succeeded") {
          // A previous run may have clicked the 4.0 Apply button before the
          // 3.0 canvas finished committing. Recover from the existing history
          // card; do not generate again or spend another request.
          await this.recoverGeneratedResult(record);
        } else {
          await this.configureNavigationAfterApply(record);
        }
      } catch (error) {
        record.failure_reason = error.message;
        record.recovery_required = true;
        record.navigation_settings.failure_reason = error.message;
        await mkdir(this.paths.root, { recursive: true });
        await this.editor.page.screenshot({ path: `${this.paths.root}/navigation-after-apply-failure.png`, fullPage: false }).catch(() => {});
        for (const [index, frame] of this.editor.page.frames().entries()) {
          await writeFile(`${this.paths.root}/navigation-after-apply-frame-${index}.html`, await frame.locator("body").innerHTML().catch(() => ""), "utf8").catch(() => {});
        }
        await this.persist();
        throw error;
      }
    }
    this.state.page.editor_verified = record.editor_verified === true;
    if (!this.state.page.editor_verified) throw new Error("导航区块编辑器校验失败");
    if (!this.state.page.saved) { await this.editor.savePage(); this.state.page.saved = true; await this.persist(); }
    if (!this.state.page.preview_verified) await this.base.verifyPreview(1);
    if (!this.state.page.published_verified) {
      this.state.page.publish_status = "running";
      await this.persist();
      await this.editor.publishSite();
      this.state.page.publish_status = "accepted";
      await this.persist();
      await this.base.verifyPublished();
    }
    if (!this.state.page.public_navigation_verified) await this.verifyPublicNavigation();
    return this.state;
  }

  async cleanup() {
    if (!this.state) await this.initialize({ resume: false });
    if (this.state.page.cleanup_status === "completed") return this.state;
    if (!(await this.editor.customPageExists(this.state.page.name))) throw new Error(`找不到导航测试页 ${this.state.page.name}`);
    await this.editor.openCustomPage(this.state.page.name);
    const count = await this.editorBlockCount();
    if (count > 1) throw new Error(`导航清理匹配数量=${count}，拒绝删除`);
    if (count === 1) {
      const result = await this.editor.deleteAiBlock({ apply: true });
      if (!result.applied) throw new Error("导航区块删除未确认");
      await this.editor.savePage();
    }
    await this.editor.deleteCustomPage(this.state.page.name, { apply: true });
    this.state.page.cleanup_status = "completed";
    await this.persist();
    return this.state;
  }
}
