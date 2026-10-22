import { AiBlockAutomation } from "./ai-runner.mjs";
import { markTypeApplied } from "./ai-state.mjs";
import { committedAiSnapshot, waitForAiCommit } from "./ai-canvas-commit.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import {
  assertProductFilterState,
  createProductFilterState,
  productFilterDescriptor,
  productFilterPaths,
  productFilterResumeAction,
  readProductFilterJson,
  writeProductFilterJson,
} from "./ai-product-filter-state.mjs";

async function waitFor(check, timeoutMs, label, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`${label}等待超时${lastError ? `：${lastError.message}` : ""}`);
}

async function visible(locator) { return Boolean(locator) && locator.isVisible().catch(() => false); }

async function firstVisible(locators) {
  for (const locator of locators) if (await visible(locator)) return locator;
  return null;
}

function productBlockLocator(frame, selectors) {
  return frame.locator(
    `.block-container[class*='block-settingId-ai-copilot'], div.siteblocks-setting-wrap, ${selectors.aiGeneratedBlockSelector}`,
  ).filter({
    has: frame.locator(`section[class*='block-settingId-ai-copilot'], ${selectors.aiGeneratedBlockSelector}, .block-settingId-ai-copilot`),
  });
}

async function productBlockCountInFrame(frame, selectors) {
  // The committed page canvas may strip the AI-specific wrapper class while
  // retaining the rendered filter placeholder. Count the outermost matching
  // node so nested block/container wrappers are not counted twice.
  const candidates = frame.locator(
    `.block-container, .siteblocks-setting-wrap, .ai-generated-block, ${selectors.aiGeneratedBlockSelector}`,
  );
  return candidates.evaluateAll((nodes) => {
    const matching = nodes.filter((node) => /Please select filter fields|properties panel|product filter/i.test(node.textContent || ""));
    return matching.filter((node) => !matching.some((parent) => parent !== node && parent.contains(node))).length;
  }).catch(() => 0);
}

export function productFilterSettingsDecision(checked) {
  return checked ? "already-checked" : "click";
}

export function filterFieldListReady({ fieldCount, loadingNumber = 0, loadingMaskVisible = false }) {
  return Number.isInteger(fieldCount) && fieldCount > 0 && Number(loadingNumber) === 0 && !loadingMaskVisible;
}

export function configuredFilterEvidence(nodes) {
  return nodes.length === 1 && nodes[0].visibleControls > 0 && Boolean(nodes[0].text?.trim()) &&
    !/Please select filter fields|properties panel|请选择筛选字段/i.test(nodes[0].text);
}

export async function filterDisplayEvidence(frames, { includeTemporary = false } = {}) {
  const matches = [];
  for (const frame of frames) {
    let temporary = false;
    for (let ancestor = frame; ancestor; ancestor = ancestor.parentFrame?.()) {
      if (ancestor.url?.().includes('/blockEditorUI/')) temporary = true;
    }
    if (temporary && !includeTemporary) continue;
    const nodes = await frame.locator('.block_productFilter:visible').evaluateAll(elements => elements.map(element => ({
      text: (element.innerText || '').slice(0, 500),
      visibleControls: [...element.querySelectorAll('input:not([type="hidden"]),select,button,[role="checkbox"]')]
        .filter(control => control.getClientRects().length && getComputedStyle(control).visibility !== 'hidden').length,
    }))).catch(() => []);
    matches.push(...nodes);
  }
  return { passed: configuredFilterEvidence(matches), count: matches.length, nodes: matches };
}

export async function filterFieldSelectionEvidence(panel) {
  const fields = await panel.locator("label.el-checkbox").evaluateAll((labels) => labels
    .map((label) => {
      const name = (label.innerText || "").replace(/\s+/g, " ").trim();
      const input = label.querySelector('input[type="checkbox"]');
      const visible = !!label.getClientRects().length && getComputedStyle(label).visibility !== "hidden";
      return { name, checked: Boolean(input?.checked) || label.classList.contains("is-checked"), visible };
    })
    .filter((field) => field.visible && field.name && field.name !== "全选"));
  const available = fields.map((field) => field.name);
  const selected = fields.filter((field) => field.checked).map((field) => field.name);
  return { available, selected, passed: available.length > 0 && selected.length === available.length };
}

export function productFilterPage(config) {
  return productFilterDescriptor(config);
}

export class AiProductFilterAutomation {
  constructor(editor, config, runId) {
    this.editor = editor;
    this.config = config;
    this.mode = config.ai.productFilterRegression;
    this.runId = runId;
    this.paths = productFilterPaths(config, runId);
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
    const store = {
      load: async () => readProductFilterJson(this.paths.state),
      save: async (value) => writeProductFilterJson(this.paths.state, value),
    };
    this.base = new AiBlockAutomation(editor, scopedConfig, store);
    this.base.beforeFinalApply = async ({ frame, record }) => {
      record.application_baseline = await this.canvasSnapshot();
      record.block_count_before = record.application_baseline.count;
      await this.persist();
      await this.configureFilterBeforeApply(frame, record);
    };
    this.base.confirmApplicationCommit = async ({ record }) => this.confirmApplicationCommit(record);
    this.base.verifyEditorType = async () => this.verifyEditorBlock();
    this.base.checkpointAppliedType = async (record) => this.checkpointAppliedType(record);
  }

  record() { return this.state.types[0]; }

  async persist() { await writeProductFilterJson(this.paths.state, this.state); }

  async canvasSnapshot() {
    return committedAiSnapshot(this.editor.page.frames(), { ownedBlankPage: true });
  }

  async confirmApplicationCommit(record) {
    if (!record.application_baseline) throw new Error("应用前缺少编辑器基线，拒绝确认产品筛选区块");
    const result = await waitForAiCommit(() => this.canvasSnapshot(), record.application_baseline, {
      timeoutMs: this.config.timeouts.blockRenderMs,
      stableMs: 1500,
    });
    record.application_commit_confirmed = true;
    record.committed_block_id = result.addedId;
    record.block_count_after = result.count;
    await this.persist();
    return result;
  }

  async initialize({ resume = false } = {}) {
    const existing = await readProductFilterJson(this.paths.state);
    if (existing) {
      this.state = assertProductFilterState(existing, this.config, this.runId);
    } else {
      if (resume) throw new Error(`运行 ${this.runId} 没有产品筛选状态，无法恢复`);
      this.state = createProductFilterState(this.config, this.runId);
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
    } else {
      await this.editor.openCustomPage(this.state.page.name);
    }
    if (resume) {
      let action = productFilterResumeAction(this.state, true);
      if (action === "done") return action;
      if (action === "verify-page") {
        const snapshot = await this.canvasSnapshot();
        if (snapshot.count === 0 && !this.state.page.saved &&
            (!this.record().application_attempted || this.record().application_commit_confirmed)) {
          // A previous attempt produced a transient result but no page-level
          // save checkpoint. The re-opened page is empty, so replay the
          // already-generated history record without another generation.
          this.record().previous_application_attempts ??= [];
          this.record().previous_application_attempts.push({
            committed_block_id: this.record().committed_block_id || "",
            application_acknowledged: this.record().application_acknowledged === true,
            result_page_empty_after_reopen: true,
            checked_at: new Date().toISOString(),
          });
          this.record().application_commit_confirmed = false;
          this.record().committed_block_id = "";
          this.record().block_count_after = null;
          action = "recover-generated-result";
          this.record().apply_status = "pending";
          this.record().recovery_required = false;
          await this.persist();
          return action;
        }
        if (snapshot.count !== 1 || !snapshot.ready) {
          throw new Error(`产品筛选应用状态不确定：编辑器中检测到 ${snapshot.count} 个可见区块，拒绝重复插入`);
        }
        this.record().committed_block_id ??= snapshot.ids[0] || "";
        const count = await this.editorBlockCount();
        if (count !== 1) throw new Error(`产品筛选已应用但编辑器中匹配到 ${count} 个区块，请人工检查`);
        this.record().editor_verified = true;
      }
      return action;
    }
    return this.state;
  }

  async editorBlockCount() {
    let count = 0;
    for (const frame of this.editor.canvasContexts()) {
      count = Math.max(count, await frame.locator(".block_productFilter:visible").count().catch(() => 0));
    }
    return count;
  }

  async verifyEditorBlock() {
    const count = await waitFor(() => this.editorBlockCount(), this.config.timeouts.blockRenderMs, "产品筛选编辑器区块");
    this.record().filter_settings.block_match_count = count;
    const evidence = await filterDisplayEvidence(this.editor.canvasContexts());
    this.record().editor_verified = count === 1 && evidence.passed;
    this.record().filter_settings.editor_display_verified = evidence.passed;
    await this.persist();
    return this.record().editor_verified;
  }

  async checkpointAppliedType(record) {
    const settings = record.filter_settings;
    const save = await this.editor.savePage();
    settings.page_save_evidence = save.evidence;
    await this.persist();
    await this.editor.openCustomPage(this.state.page.name);
    const evidence = await waitFor(async () => {
      const count = await this.editorBlockCount();
      const display = await filterDisplayEvidence(this.editor.canvasContexts());
      return count === 1 && display.passed ? { count, display } : false;
    }, this.config.timeouts.blockRenderMs, "产品筛选保存后重新进入页面校验");
    settings.persisted_display_verified = evidence.display.passed;
    record.editor_verified = true;
    this.state.page.saved = true;
    await this.persist();
  }

  async generatedBlock(frame) {
    // “应用模块” opens the generated result in the 4.0 GrapesJS canvas. It
    // is not in the 3.0 page canvas yet, so searching editor.findAiBlockWrappers
    // here will always time out. The result canvas is a child iframe of the AI
    // frame; select the product-filter wrapper by its rendered placeholder.
    return waitFor(async () => {
      // History insertion can render the 4.0 result in a grandchild iframe;
      // limiting the search to one parent level falsely reports that the
      // product-filter block was not inserted.
      const candidates = this.editor.page.frames().filter((candidate) => {
        let current = candidate;
        while (current) {
          if (current === frame) return true;
          current = current.parentFrame();
        }
        return false;
      });
      for (const resultFrame of candidates) {
        const components = resultFrame.locator('.block_productFilter:visible');
        const componentCount = await components.count().catch(() => 0);
        if (componentCount > 1) throw new Error('产品筛选生成组件匹配不唯一，拒绝点击');
        if (componentCount === 1) return { frame: resultFrame, wrapper: components.first(), kind: 'filter-component' };
        const wrappers = resultFrame.locator("body > div.phoenix2-block-wrap");
        const count = await wrappers.count().catch(() => 0);
        for (let index = 0; index < count; index += 1) {
          const wrapper = wrappers.nth(index);
          const text = await wrapper.innerText().catch(() => "");
          if (/Please select filter fields|properties panel/i.test(text)) {
            return { frame: resultFrame, wrapper };
          }
        }
        // An empty GrapesJS wrapper appears before history insertion finishes.
        // Never accept it merely because there is only one wrapper: it is a
        // layout component, not the product-filter component's settings target.
      }
      return false;
    }, this.config.timeouts.blockRenderMs, "产品筛选生成区块");
  }

  async settingButton(frame) {
    const configured = frame.locator(this.config.selectors.aiBlockSettingsButtonSelector);
    const semantic = [
      frame.getByRole("button", { name: /设置/ }).first(),
      frame.getByLabel(/设置/).first(),
      frame.getByTitle(/设置/).first(),
    ];
    return firstVisible([configured, ...semantic]);
  }

  async settingsPanel({ timeoutMs = this.config.timeouts.actionMs, frame = null } = {}) {
    const selectors = this.config.selectors.aiFilterSettingsPanelSelector;
    return waitFor(async () => {
      const scopes = frame ? this.editor.page.frames().filter(candidate => {
        for (let ancestor = candidate; ancestor; ancestor = ancestor.parentFrame()) if (ancestor === frame) return true;
        return false;
      }) : this.editor.contexts();
      for (const scope of scopes) {
        // Element-Plus drawers in the full-screen block editor toggle the
        // parent overlay's display style and do not always add an `open`
        // class. Keep configured legacy selectors, but also inspect live
        // drawer/dialog nodes and require visible “全选” content.
        const candidates = [
          scope.locator(".product-filter-setting:visible"),
          scope.locator(selectors),
          scope.locator(".modules-setting-container .el-drawer"),
          scope.locator(".phoenix-block-drawer-container .el-drawer"),
          scope.locator("[role='dialog']"),
        ];
        for (const panels of candidates) {
          const count = await panels.count().catch(() => 0);
          for (let index = 0; index < count; index += 1) {
            const panel = panels.nth(index);
            if (await visible(panel) && (await panel.innerText().catch(() => "")).includes("全选")) return panel;
          }
        }
        const all = scope.getByText("全选", { exact: true });
        if (await visible(all.first())) {
          const candidate = all.first().locator("xpath=ancestor::*[.//input[@type='checkbox']][1]");
          if (await visible(candidate)) return candidate;
        }
      }
      return false;
    }, timeoutMs, "产品筛选设置侧边栏");
  }

  async checkboxFor(panel) {
    const label = panel.getByText("全选", { exact: true }).first();
    // The text is rendered inside Element-Plus' <label class="el-checkbox">.
    // The nearest ancestor containing an input is the whole field-list
    // container, not the checkbox control itself; clicking that container is
    // a no-op in the live editor. Keep the label as the primary row/control.
    const row = await visible(label)
      ? label.locator("xpath=ancestor::label[.//input[@type='checkbox'] or .//*[@role='checkbox']][1]")
      : panel;
    // Element-Plus keeps the native input visually hidden and exposes the
    // clickable label/inner span. Do not require the input itself to be
    // visible; isChecked() still reads its real state.
    const candidates = [
      row.locator("input[type='checkbox']").first(),
      row.getByRole("checkbox").first(),
      panel.locator(this.config.selectors.aiFilterSelectAllSelector).first(),
    ];
    let checkbox = null;
    for (const candidate of candidates) {
      if (await candidate.count().catch(() => 0)) { checkbox = candidate; break; }
    }
    if (!checkbox) throw new Error("产品筛选设置面板中未找到“全选”复选框");
    return { checkbox, label, row };
  }

  async filterFieldsPanel(frame, fallback) {
    const scopes = [frame, ...this.editor.page.frames().filter((candidate) => candidate !== frame)];
    const diagnostics = [];
    for (const scope of scopes) {
      let url = "";
      try { url = new URL(scope.url()).pathname; } catch {}
      const bodyText = await scope.locator("body").innerText().catch(() => "");
      const bodyLabels = await scope.locator("label.el-checkbox").count().catch(() => 0);
      const candidates = scope.locator(".product-filter-setting");
      const count = await candidates.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const candidate = candidates.nth(index);
        const labels = candidate.locator("label.el-checkbox");
        const text = await candidate.innerText().catch(() => "");
        const labelCount = await labels.count().catch(() => 0);
        diagnostics.push({ url, root: ".product-filter-setting", labelCount, hasHeading: text.includes("选择筛选字段") });
        if (text.includes("选择筛选字段") && labelCount > 1) {
          this.lastFieldPanelDiagnostics = diagnostics;
          return candidate;
        }
      }
      diagnostics.push({ url, root: "body", labelCount: bodyLabels, hasHeading: bodyText.includes("选择筛选字段") });
    }
    this.lastFieldPanelDiagnostics = diagnostics;
    return fallback;
  }

  async filterFieldListStatus(panel) {
    const root = panel.locator(".product-filter-setting").first();
    const rootExists = await root.count().catch(() => 0);
    const scope = rootExists ? root : panel;
    const evidence = await filterFieldSelectionEvidence(scope);
    const rawLoadingNumber = rootExists ? await root.getAttribute("loading-number").catch(() => "0") : "0";
    const loadingNumber = rawLoadingNumber === null || rawLoadingNumber === "" ? 0 : Number(rawLoadingNumber);
    const loadingMaskVisible = await scope.locator(".el-loading-mask:visible, [aria-busy='true']:visible").count().catch(() => 0) > 0;
    return { fieldCount: evidence.available.length, available: evidence.available, selected: evidence.selected,
      loadingNumber: Number.isFinite(loadingNumber) ? loadingNumber : 1, loadingMaskVisible };
  }

  async checked(checkbox) {
    const checked = await checkbox.isChecked().catch(() => null);
    if (checked !== null) return checked;
    const aria = await checkbox.getAttribute("aria-checked").catch(() => null);
    if (aria !== null) return aria === "true";
    const className = await checkbox.getAttribute("class").catch(() => "");
    return /checked|is-checked|active|selected/.test(className ?? "");
  }

  async configureFilterBeforeApply(frame, record) {
    const settings = record.filter_settings;
    settings.selection_status = "running";
    settings.toolbar_status = "pending";
    settings.panel_status = "pending";
    settings.select_all_status = "pending";
    settings.apply_status = "pending";
    settings.failure_reason = "";
    await this.persist();
    try {
      const match = await this.generatedBlock(frame);
      await match.wrapper.scrollIntoViewIfNeeded().catch(() => {});
      // A normal click is important here: the editor listens for the
      // GrapesJS component-selection event and only then renders its toolbar.
      await match.wrapper.click();
      await waitFor(async () => {
        const className = await match.wrapper.getAttribute("class").catch(() => "");
        return /gjs-selected|hover_component/.test(className ?? "");
      }, 1000, "产品筛选生成区块选中").catch(() => {});
      settings.selection_status = "succeeded";
      await this.persist();

      // In the current 4.0 block editor, selecting the generated block can
      // open the properties drawer directly.  Do this check before looking
      // for the legacy gear: the floating toolbar is rendered in a sibling
      // overlay and is not always exposed through match.frame.
      let directPanel = await this.settingsPanel({ timeoutMs: 1500, frame }).catch(() => null);
      if (directPanel) {
        settings.toolbar_status = "succeeded";
        settings.panel_status = "succeeded";
        await this.persist();
      }

      let panel = directPanel;
      if (!panel) {
        // Prefer the full-screen block toolbar's settings item. A generic
        // page toolbar can be visible at the same time but does not open the
        // product-filter drawer.
        const gearSelectors = [
          // Selecting the native filter component exposes this compact
          // component toolbar, not the outer block's layout toolbar.
          ".ld-component-toolbar-item.icon-tool-setups",
          ".block-setting-toolbar-item:has(.icon-tool-setups)",
          ".block-setting-toolbar-item .icon-tool-setups",
          ".ld-toolbar .icon-tool-setups",
          ".block-setting-container .setting-icon-container",
          ".block-setting-container .icon-a-editor-containersettings",
        ];
        const gearDeadline = Date.now() + this.config.timeouts.actionMs;
        for (let attempt = 0; attempt < 3 && !panel && Date.now() < gearDeadline; attempt += 1) {
          const gears = [];
          const resultScopes = this.editor.page.frames().filter(candidate => {
            for (let current = candidate; current; current = current.parentFrame()) if (current === frame) return true;
            return false;
          });
          for (const scope of resultScopes) {
            for (const selector of gearSelectors) gears.push(scope.locator(`${selector}:visible`).first());
          }
          const gear = await firstVisible(gears);
          if (!gear) {
            await this.editor.page.waitForTimeout(300);
            continue;
          }
          await gear.click({ timeout: 5000 }).catch(async () => {
            await gear.evaluate(element => (element.closest('.block-setting-toolbar-item') || element).click()).catch(() => {});
          });
          panel = await this.settingsPanel({ timeoutMs: 3000, frame }).catch(() => null);
          if (!panel) {
            await gear.evaluate(element => (element.closest('.block-setting-toolbar-item') || element).click()).catch(() => {});
            panel = await this.settingsPanel({ timeoutMs: 3000, frame }).catch(() => null);
          }
          if (!panel) await this.editor.page.waitForTimeout(300);
        }
      }
      if (!panel) throw new Error("产品筛选设置侧边栏等待超时");
      settings.toolbar_status = "succeeded";
      await this.persist();
      settings.panel_status = "succeeded";
      const { checkbox, label, row } = await this.checkboxFor(panel);
      await writeFile(`${this.paths.root}/select-all-before.html`, await panel.evaluate((element) => element.outerHTML).catch(() => ""), "utf8").catch(() => {});
      let isChecked = await this.checked(checkbox);
      settings.select_all_status = productFilterSettingsDecision(isChecked);
      let fieldPanel = await this.filterFieldsPanel(frame, panel);
      settings.fields_load_status = "running";
      await this.persist();
      let loadStatus;
      try {
        loadStatus = await waitFor(async () => {
          fieldPanel = await this.filterFieldsPanel(frame, panel);
          const status = await this.filterFieldListStatus(fieldPanel);
          settings.field_panel_diagnostics = this.lastFieldPanelDiagnostics;
          settings.available_fields = status.available;
          settings.selected_fields = status.selected;
          settings.fields_loading_number = status.loadingNumber;
          settings.fields_loading_mask_visible = status.loadingMaskVisible;
          return filterFieldListReady(status) ? status : false;
        }, this.mode.fieldsLoadTimeoutMs, "产品筛选字段列表加载", 500);
      } catch {
        settings.fields_load_status = "failed";
        settings.fields_verified = false;
        settings.failure_reason = `筛选字段列表未加载完成（当前 ${settings.available_fields.length} 项，加载状态 ${settings.fields_loading_number}）`;
        await this.editor.page.screenshot({ path: `${this.paths.root}/fields-not-ready.png`, fullPage: false }).catch(() => {});
        await this.persist();
        throw new Error(settings.failure_reason);
      }
      settings.fields_load_status = "succeeded";
      settings.available_fields = loadStatus.available;
      await this.persist();
      if (!isChecked) {
        // Use the visible “全选” control first. The native input is hidden in
        // Element-Plus and forcing it can update the child rows without
        // producing the same toolbar interaction as a real user click.
        const clickTarget = await visible(label) ? label : row;
        try {
          await clickTarget.click({ force: true });
        } catch {
          await clickTarget.evaluate((element) => element.click());
        }
        // Older builds sometimes attach the handler to the native input only;
        // fall back to a forced check only when the visible click did not
        // change the checkbox state.
        if (!(await this.checked(checkbox))) {
          await checkbox.check({ force: true }).catch(async () => {
            await checkbox.evaluate((element) => element.click());
          });
        }
        await waitFor(async () => this.checked(checkbox), this.config.timeouts.actionMs, "产品筛选“全选”勾选");
        isChecked = true;
      }
      const rowClass = await row.getAttribute("class").catch(() => "");
      if (!isChecked) {
        throw new Error("产品筛选“全选”状态无法确认");
      }
      settings.select_all_checked = true;
      settings.select_all_status = "succeeded";
      let fieldEvidence = await filterFieldSelectionEvidence(fieldPanel);
      settings.field_panel_diagnostics = this.lastFieldPanelDiagnostics;
      await this.persist();
      if (!fieldEvidence.passed) throw new Error(`产品筛选“全选”后已选字段 ${fieldEvidence.selected.length}/${fieldEvidence.available.length}`);
      settings.available_fields = fieldEvidence.available;
      settings.selected_fields = fieldEvidence.selected;
      settings.fields_verified = true;
      await writeFile(`${this.paths.root}/select-all-after.html`, await panel.evaluate((element) => element.outerHTML).catch(() => ""), "utf8").catch(() => {});
      await this.editor.page.screenshot({ path: `${this.paths.root}/select-all-checked.png`, fullPage: false }).catch(() => {});
      await this.persist();

      const apply = await firstVisible([
        panel.getByRole("button", { name: "应用", exact: true }).first(),
        panel.getByText("应用", { exact: true }).first(),
        panel.locator(this.config.selectors.aiFilterApplySelector).first(),
      ]);
      if (apply) {
        await apply.click({ force: true });
        await waitFor(async () => {
          if (!(await visible(panel))) return true;
          const text = await panel.innerText().catch(() => "");
          return /保存成功|应用成功/.test(text);
        }, this.config.timeouts.actionMs, "产品筛选设置应用");
      }
      const resultFrames = () => this.editor.page.frames().filter((candidate) => {
        for (let parent = candidate; parent; parent = parent.parentFrame()) if (parent === frame) return true;
        return false;
      });
      const previewEvidence = async () => filterDisplayEvidence(resultFrames(), { includeTemporary: true });
      let configured = await waitFor(async () => {
        const evidence = await previewEvidence();
        return evidence.passed ? evidence : false;
      }, 5000, "产品筛选生成结果配置确认").catch(() => false);
      if (!configured) {
        // Some editor builds keep the visible master checkbox checked while
        // the field selections have not reached the component model yet.
        // A single UI off/on cycle resends the selection events.
        await label.click({ force: true });
        await waitFor(async () => !(await this.checked(checkbox)), this.config.timeouts.actionMs, "产品筛选取消全选");
        await waitFor(async () => !(await filterFieldSelectionEvidence(fieldPanel)).selected.length,
          this.config.timeouts.actionMs, "产品筛选字段清空").catch(() => {});
        await label.click({ force: true });
        await waitFor(async () => this.checked(checkbox), this.config.timeouts.actionMs, "产品筛选重新全选");
        fieldEvidence = await filterFieldSelectionEvidence(fieldPanel);
        if (!fieldEvidence.passed) throw new Error("产品筛选重新全选后仍有字段未选中");
        settings.selected_fields = fieldEvidence.selected;
        configured = await waitFor(async () => {
          const evidence = await previewEvidence();
          return evidence.passed ? evidence : false;
        }, this.config.timeouts.blockRenderMs, "产品筛选重新全选后生成结果").catch(() => false);
      }
      if (!configured) throw new Error("全选状态已勾选，但生成结果仍显示筛选占位内容");
      settings.generated_display_verified = true;
      settings.apply_status = "succeeded";
      settings.applied_at = new Date().toISOString();
      await this.persist();
    } catch (error) {
      settings.apply_status = "failed";
      settings.failure_reason = error.message;
      // Keep a headed-run artifact when toolbar discovery fails; this makes
      // selector calibration reproducible without guessing from a stale
      // screenshot.
      try {
        await mkdir(this.paths.root, { recursive: true });
        await this.editor.page.screenshot({ path: `${this.paths.root}/toolbar-failure.png`, fullPage: false });
        await writeFile(`${this.paths.root}/toolbar-failure.html`, await frame.locator("body").innerHTML(), "utf8");
      } catch {
        // Diagnostics must never mask the original automation failure.
      }
      await this.persist();
      throw error;
    }
  }

  async recoverGeneratedResult(record) {
    const before = await this.canvasSnapshot();
    if (before.count > 1 || !before.ready) {
      throw new Error(`恢复前页面状态不明确：检测到 ${before.count} 个区块，拒绝重复插入`);
    }
    if (before.count === 1) {
      record.committed_block_id ??= before.ids[0] || "";
      if (await this.verifyEditorBlock()) {
        markTypeApplied(this.state, record);
        record.application_commit_confirmed = true;
        record.recovery_required = false;
        await this.persist();
        await this.checkpointAppliedType(record);
        return;
      }
      throw new Error("页面已有区块但产品筛选展示校验未通过，拒绝重复插入");
    }
    const frame = await this.base.openAiDialog();
    // A previous failed recovery can leave the MoliAI points drawer open on
    // top of the history list. Close transient drawers before clicking the
    // product-filter history card.
    for (const scope of [frame, ...this.editor.page.frames()]) {
      const pointsPanel = scope.locator(".ai-settings-panel:visible").first();
      const pointsToggle = scope.locator("button.ai-settings-trigger").first();
      if (await visible(pointsPanel) && await pointsToggle.count().catch(() => 0)) {
        await pointsToggle.click({ force: true }).catch(() => pointsToggle.evaluate((element) => element.click()));
      }
    }
    await this.editor.page.waitForTimeout(300);
    const history = frame.locator("button.ai-history-trigger").first();
    const existingCards = frame.locator(this.config.selectors.aiHistoryCardSelector);
    const cardsAlreadyVisible = await existingCards.filter({ hasText: record.type }).first().isVisible().catch(() => false);
    if (await visible(history) && !cardsAlreadyVisible) {
      // Vue's history trigger is occasionally covered by the drawer layer;
      // dispatching its native click keeps the interaction identical to a
      // headed user click and avoids silently doing nothing.
      await history.evaluate((element) => element.click());
    }
    const promptNeedle = (record.polished_prompt || record.prompt || "").trim().slice(0, 80);
    let card;
    try {
      card = await waitFor(async () => {
      const cards = frame.locator(this.config.selectors.aiHistoryCardSelector);
      const count = await cards.count().catch(() => 0);
      const candidates = [];
      for (let index = 0; index < count; index += 1) {
        const candidate = cards.nth(index);
        const text = await candidate.innerText().catch(() => "");
        if (!text.includes(record.type)) continue;
        if (promptNeedle && text.includes(promptNeedle)) candidates.push(candidate);
      }
      if (!candidates.length) {
        for (let index = 0; index < count; index += 1) {
          const candidate = cards.nth(index);
          const text = await candidate.innerText().catch(() => "");
          if (text.includes(record.type)) candidates.push(candidate);
        }
      }
      return candidates[0] ?? false;
      }, this.config.timeouts.blockRenderMs, "产品筛选历史生成记录");
    } catch (error) {
      await mkdir(this.paths.root, { recursive: true }).catch(() => {});
      for (const [index, scope] of this.editor.page.frames().entries()) {
        await writeFile(`${this.paths.root}/history-debug-${index}.html`, await scope.locator("body").innerHTML().catch(() => ""), "utf8").catch(() => {});
      }
      await this.editor.page.screenshot({ path: `${this.paths.root}/history-debug.png`, fullPage: false }).catch(() => {});
      throw error;
    }
    const insert = await firstVisible([
      card.locator("button.ai-history-insert").first(),
      card.getByText(/插入|应用模块/).first(),
    ]);
    if (!insert) throw new Error("未找到可恢复的产品筛选生成记录");
    try { await insert.click(); } catch { await insert.click({ force: true }); }
    await this.editor.page.waitForTimeout(500);
    if (await visible(frame.locator(this.config.selectors.aiHistoryCardSelector).first())) {
      await insert.evaluate((element) => element.click()).catch(() => {});
    }
    await waitFor(async () => !(await visible(frame.locator(this.config.selectors.aiHistoryCardSelector).first())), this.config.timeouts.actionMs, "产品筛选历史结果插入").catch(() => {});
    await this.configureFilterBeforeApply(frame, record);
    const apply = frame.locator(this.config.selectors.aiApplySelector).filter({ hasText: /^应用$/ }).first();
    if (!(await visible(apply))) throw new Error("恢复产品筛选生成结果后未找到 4.0“应用”按钮");
    await this.base.waitForAiControlReady(frame, apply, "恢复产品筛选 4.0 应用按钮");
    record.application_baseline = before;
    record.block_count_before = before.count;
    const saveResponse = this.editor.page.waitForResponse(
      (response) => response.request().method() === "POST" && response.url().includes("/phoenix2/composite/editor/v1/newEditor/savePage"),
      { timeout: this.config.timeouts.blockRenderMs },
    ).catch(() => null);
    record.application_attempted = true;
    record.application_attempted_at = new Date().toISOString();
    await this.persist();
    await apply.click();
    const [response] = await Promise.all([saveResponse, this.confirmApplicationCommit(record)]);
    record.application_acknowledged = response?.ok() === true;
    record.application_http_status = response?.status() ?? null;
    if (response && !response.ok()) throw new Error(`产品筛选应用保存接口返回 HTTP ${response.status()}`);
    const close = frame.locator(".close-icon-container").first();
    if (await visible(close)) await close.click({ force: true });
    await this.base.dismissAiExitPrompt().catch(() => {});
    await this.editor.page.waitForTimeout(this.base.aiConfig.applyIntervalMs);
    markTypeApplied(this.state, record);
    record.application_commit_confirmed = true;
    // The AI modal's internal save response is not the page-level save. Save
    // the owning page, reopen it, then verify the exact committed block ID
    // before recording a durable application.
    const pageSave = await this.editor.savePage();
    record.filter_settings.page_save_evidence = pageSave.evidence;
    record.filter_settings.checkpoint_saved = true;
    record.filter_settings.checkpoint_saved_at = new Date().toISOString();
    await this.persist();
    await this.editor.openCustomPage(this.state.page.name);
    const persisted = await waitFor(async () => {
      const snapshot = await this.canvasSnapshot();
      return snapshot.count === 1 && snapshot.ready && snapshot.ids.includes(record.committed_block_id)
        ? snapshot : false;
    }, this.config.timeouts.blockRenderMs, "产品筛选页面保存后重新进入验证");
    record.filter_settings.persisted_block_id = persisted.ids[0];
    record.filter_settings.persisted_display_verified = await this.verifyEditorBlock();
    record.editor_verified = record.filter_settings.persisted_display_verified;
    record.verified_at = new Date().toISOString();
    record.recovery_required = false;
    await this.persist();
    if (!record.editor_verified) throw new Error("恢复产品筛选后编辑器展示校验失败");
    await this.checkpointAppliedType(record);
  }

  async run({ resume = false } = {}) {
    const initResult = await this.initialize({ resume });
    const record = this.record();
    if (record.apply_status !== "applied") {
      try {
        if (resume && initResult === "recover-generated-result") {
          await this.recoverGeneratedResult(record);
        } else {
          await this.base.generateAndApply(record);
        }
      } catch (error) {
        record.failure_reason = error.message;
        record.recovery_required = record.generation_status === "succeeded";
        await this.persist();
        throw error;
      }
    }
    this.state.page.editor_verified = record.editor_verified === true;
    if (!this.state.page.editor_verified) throw new Error("产品筛选区块编辑器校验失败");
    if (!this.state.page.saved) {
      await this.editor.savePage();
      this.state.page.saved = true;
      await this.persist();
    }
    if (!this.state.page.preview_verified) await this.base.verifyPreview(1);
    if (!this.state.page.published_verified) {
      if (this.state.page.publish_status === "running") throw new Error("产品筛选发布状态不确定，请先检查公开页");
      this.state.page.publish_status = "running";
      await this.persist();
      await this.editor.publishSite();
      this.state.page.publish_status = "accepted";
      await this.persist();
      await this.base.verifyPublished();
    }
    if (record.failure_reason) {
      record.previous_failures ??= [];
      record.previous_failures.push({ reason: record.failure_reason, cleared_at: new Date().toISOString() });
      record.failure_reason = "";
    }
    record.recovery_required = false;
    this.state.page.failure_reason = "";
    await this.persist();
    return this.state;
  }

  async cleanup() {
    // Cleanup is an explicit destructive command. Open the fixed page without
    // applying resume-time “must find exactly one block” verification; a
    // previous cleanup may already have removed the block before failing on
    // the page-list icon.
    if (!this.state) await this.initialize({ resume: false });
    if (this.state.page.cleanup_status === "completed") return this.state;
    if (!(await this.editor.customPageExists(this.state.page.name))) throw new Error(`找不到产品筛选测试页 ${this.state.page.name}`);
    await this.editor.openCustomPage(this.state.page.name);
    const count = await this.editorBlockCount();
    if (count > 1) throw new Error(`产品筛选清理匹配数量=${count}，拒绝删除`);
    if (count === 1) {
      const result = await this.editor.deleteAiBlock({ apply: true });
      if (!result.applied) throw new Error("产品筛选区块删除未确认");
      await this.editor.savePage();
    }
    // A previous cleanup can have removed the block successfully and failed
    // only while clicking the hidden page-list delete icon. In that explicit
    // cleanup context, zero blocks is an already-clean state; continue with
    // page deletion instead of leaving the orphan test page behind.
    await this.editor.deleteCustomPage(this.state.page.name, { apply: true });
    this.state.page.cleanup_status = "completed";
    await this.persist();
    return this.state;
  }
}
