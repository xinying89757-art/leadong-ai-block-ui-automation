import { AiBlockAutomation } from "./ai-runner.mjs";
import { AiProductFilterAutomation, filterDisplayEvidence } from "./ai-product-filter-runner.mjs";
import { AiNavigationAutomation } from "./ai-navigation-runner.mjs";
import { ensureSpecialTypeState, markTypeApplied } from "./ai-state.mjs";
import { mkdir } from "node:fs/promises";
import { isSafetyFailure, isGlobalSafetyFailure } from "./ai-regression-state.mjs";
import { committedAiSnapshot, waitForAiCommit, isTemporaryAiFrame } from './ai-canvas-commit.mjs';

const PRODUCT_FILTER = "产品筛选";
const NAVIGATION = "导航";

export function specialHandlerKind(type) {
  if (type === PRODUCT_FILTER) return "product-filter";
  if (type === NAVIGATION) return "navigation";
  return "standard";
}

export function mergeAiBlockCounts(current, ...counts) {
  return Math.max(current, ...counts);
}

export function canContinueTypeFailure(record, error) {
  if (isSafetyFailure(error.message)) return false;
  if (record.apply_status === "applied" &&
      (record.application_acknowledged || record.block_count_after === record.block_count_before + 1) &&
      (record.application_commit_confirmed || /应用后未在编辑器中检测到/.test(error.message))) return true;
  return record.apply_status !== 'applied' && !record.application_attempted && !isGlobalSafetyFailure(error.message);
}

export class AiPagedAutomation extends AiBlockAutomation {
  constructor(editor, config, store, pageNumber = 1) {
    super(editor, config, store, pageNumber);
    this.filterHandler = null;
    this.navigationHandler = null;
  }

  bindHandlers() {
    const runId = this.config.ai.runId || `page-${this.pageNumber}`;
    const bind = (handler, type) => {
      handler.state = this.state;
      handler.base.state = this.state;
      handler.base.page = this.page;
      handler.persist = async () => this.persist();
      handler.record = () => this.state.types.find((record) => record.type === type);
      return handler;
    };
    if (this.state.types.some((record) => record.type === PRODUCT_FILTER)) {
      this.filterHandler = bind(new AiProductFilterAutomation(this.editor, this.config, runId), PRODUCT_FILTER);
    }
    if (this.state.types.some((record) => record.type === NAVIGATION)) {
      this.navigationHandler = bind(new AiNavigationAutomation(this.editor, this.config, runId), NAVIGATION);
    }
  }

  async initialize(options = {}) {
    const state = await super.initialize(options);
    for (const record of state.types) ensureSpecialTypeState(record);
    this.bindHandlers();

    // A previous process can have completed the nested AI editor action but
    // exited before the top-level 3.0 page was persisted. In that case the
    // state says several types are applied while the reopened canvas contains
    // only a subset (most commonly the navigation block). Recover the missing
    // results from AI history instead of charging a second generation.
    if (options.resume) await this.recoverMissingAppliedRecords();

    if (options.resume && this.navigationHandler) {
      const record = this.navigationHandler.record();
      if (record.generation_status === "succeeded" && record.apply_status !== "applied" && record.recovery_required) {
        await this.recoverStandardGeneratedResult(record);
        record.recovery_required = false;
        record.failure_reason = "";
        await this.persist();
      } else if (record.apply_status === "applied" && record.navigation_settings.save_status !== "succeeded") {
        // The 4.0 Apply action can succeed before the 3.0 page is saved. On
        // the next process the generated block is therefore absent from the
        // reopened canvas; recover the existing history result instead of
        // looking for a non-existent block or generating a duplicate.
        const committedCount = await this.navigationHandler.editorBlockCount().catch(() => 0);
        if (committedCount === 0 && !this.state.page.saved && record.generation_status === "succeeded") {
          record.apply_status = "pending";
          record.recovery_required = false;
          record.navigation_settings.failure_reason = "";
          await this.persist();
          await this.recoverStandardGeneratedResult(record);
        } else {
          await this.navigationHandler.configureNavigationAfterApply(record);
        }
        record.recovery_required = false;
        record.failure_reason = "";
        await this.persist();
      }
    }
    if (options.resume && this.filterHandler) {
      const record = this.filterHandler.record();
      if (record.generation_status === "succeeded" && record.apply_status !== "applied" && record.recovery_required) {
        await this.recoverStandardGeneratedResult(record);
        record.recovery_required = false;
        record.failure_reason = "";
        await this.persist();
      }
    }
    return state;
  }

  async historyRecord(frame, record) {
    const history = frame.locator(this.config.selectors.aiHistoryTriggerSelector).first();
    const existingCards = frame.locator(this.config.selectors.aiHistoryCardSelector);
    const alreadyOpen = await existingCards.filter({ hasText: record.type }).first().isVisible().catch(() => false);
    if (await history.isVisible().catch(() => false) && !alreadyOpen) {
      await history.evaluate((element) => element.click()).catch(() => history.click({ force: true }));
    }
    const promptNeedle = String(record.generation_prompt || record.polished_prompt || record.prompt || "").trim().slice(0, 80);
    const timeout = this.config.timeouts.blockRenderMs;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const cards = frame.locator(this.config.selectors.aiHistoryCardSelector);
      const matches = [];
      const count = await cards.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const card = cards.nth(index);
        const text = await card.innerText().catch(() => "");
        if (!text.includes(record.type)) continue;
        const insertCandidates = [
          card.getByRole("button", { name: /插入/ }).first(),
          card.locator(this.config.selectors.aiHistoryInsertSelector).first(),
          card.getByText(/插入/).first(),
        ];
        let insert = null;
        for (const candidate of insertCandidates) {
          if (candidate && await candidate.isVisible().catch(() => false)) { insert = candidate; break; }
        }
        if (!insert) continue;
        const id = await card.getAttribute('data-id').catch(() => '') || await card.getAttribute('data-record-id').catch(() => '') || '';
        matches.push({ card, text, insert, id });
      }
      const exact = matches.filter(item => record.generation_record_id ? item.id === record.generation_record_id
        : promptNeedle && item.text.includes(promptNeedle));
      if (exact.length === 1) return exact[0];
      if (exact.length > 1) throw new Error(`历史生成记录匹配不唯一：${record.type}，拒绝猜测目标`);
      await this.editor.page.waitForTimeout(250);
    }
    throw new Error(`未找到可恢复的 AI 历史生成记录：${record.type}`);
  }

  async recoverStandardGeneratedResult(record) {
    record.application_baseline = await this.canvasSnapshot();
    record.block_count_before = record.application_baseline.count;
    const frame = await this.openAiDialog();
    const history = await this.historyRecord(frame, record);
    try {
      await history.insert.click();
    } catch {
      await history.insert.click({ force: true });
    }
    // The history drawer is a Vue overlay. Some builds leave the first click
    // on the card while the list is animating; a native click retry mirrors a
    // headed user's second click and prevents a silent no-op.
    await this.editor.page.waitForTimeout(500);
    const scopes = [frame, ...frame.childFrames()];
    const firstVisibleControl = async (factory) => {
      for (const scope of scopes) {
        const control = factory(scope);
        if (await control.isVisible().catch(() => false)) return control;
      }
      return null;
    };
    const next = await (async () => {
      const deadline = Date.now() + this.config.timeouts.blockRenderMs;
      while (Date.now() < deadline) {
        const moduleControl = await firstVisibleControl((scope) => scope.getByText("应用模块", { exact: true }).first());
        if (moduleControl && await moduleControl.isEnabled().catch(() => true)) return { mode: "module", control: moduleControl };
        const moduleButton = await firstVisibleControl((scope) => scope.locator("button").filter({ hasText: "应用模块" }).first());
        if (moduleButton && await moduleButton.isEnabled().catch(() => true)) return { mode: "module", control: moduleButton };
        const apply = await firstVisibleControl((scope) => scope.locator(this.config.selectors.aiApplySelector).filter({ hasText: /^应用$/ }).first());
        if (apply && await apply.isEnabled().catch(() => false)) return { mode: "final", control: apply };
        await this.editor.page.waitForTimeout(250);
      }
      await mkdir(this.config.paths.artifactsDir, { recursive: true }).catch(() => {});
      await this.editor.page.screenshot({ path: `${this.config.paths.artifactsDir}/ai-history-recovery-${record.type}.png`, fullPage: false }).catch(() => {});
      throw new Error(`历史记录插入后未出现应用控件：${record.type}`);
    })();
    if (next.mode === "module") {
      await next.control.click({ force: true });
    }
    const finalApply = next.mode === "final"
      ? next.control
      : await firstVisibleControl((scope) => scope.locator(this.config.selectors.aiApplySelector).filter({ hasText: /^应用$/ }).first());
    if (!finalApply) throw new Error(`历史记录应用模块后未找到最终应用按钮：${record.type}`);
    await this.beforeFinalApply({ frame, record });
    await this.waitForAiControlReady(frame, finalApply, `AI 历史记录应用按钮(${record.type})`);
    const saveResponse = this.editor.page.waitForResponse(
      (response) => response.request().method() === "POST" && response.url().includes("/phoenix2/composite/editor/v1/newEditor/savePage"),
      { timeout: this.config.timeouts.blockRenderMs },
    ).catch(() => null);
    record.application_attempted = true;
    await this.persist();
    await finalApply.click({ force: true });
    const [response] = await Promise.all([saveResponse, this.confirmApplicationCommit({ record })]);
    record.application_acknowledged = response?.ok() === true;
    if (response && !response.ok()) throw new Error(`历史区块应用保存接口返回 HTTP ${response.status()}`);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await mkdir(this.config.paths.artifactsDir, { recursive: true }).catch(() => {});
    await this.editor.page.screenshot({ path: `${this.config.paths.artifactsDir}/ai-history-after-apply-${record.type}.png`, fullPage: false }).catch(() => {});
    await this.afterFinalApply({ frame, record });
    await this.closeAiResult();
    await this.editor.page.waitForTimeout(this.aiConfig.applyIntervalMs);
    markTypeApplied(this.state, record);
    record.recovery_source = "history";
    record.editor_verified = await this.verifyEditorType(record.type);
    record.verified_at = new Date().toISOString();
    await this.persist();
    if (record.editor_verified) {
      await this.checkpointAppliedType(record);
      this.state.page.type_failures = (this.state.page.type_failures || []).filter(item => item.type !== record.type);
      record.previous_failures ??= [];
      if (record.failure_reason) record.previous_failures.push({ reason: record.failure_reason, recovered_at: record.verified_at });
      record.failure_reason = '';
      record.recovery_required = false;
      await this.persist();
    }
    // Keep the applied/history evidence for a safe resume even when the
    // canvas selector is temporarily stale. The page-level editor count,
    // preview and public rendering checks below remain the hard assertions.
  }

  async recoverMissingAppliedRecords() {
    if (this.state.page.saved && this.state.page.preview_verified && this.state.page.published_verified) return;
    const snapshot = await this.canvasSnapshot();
    const uncertain = this.state.types.filter(record => record.application_attempted || record.apply_status === 'applied');
    // Old counts are not identities. Never assign the first N wrappers to
    // the first N configured types; quarantine legacy ambiguity instead.
    for (const record of uncertain) {
      if (!record.committed_block_id) {
        throw new Error(`应用状态不确定：${record.type} 缺少稳定区块 ID；保留旧页面，最终重试使用新测试页`);
      }
      if (!snapshot.ids.includes(record.committed_block_id)) {
        throw new Error(`应用状态不确定：${record.type} 已记录区块不在当前正文；保留页面并隔离重试`);
      }
      record.recovery_required = false;
    }
    const applied = this.state.types.filter((record) => record.apply_status === "applied");
    // A known count/selector failure is not proof that an applied block is
    // absent. Never rebuild that page by guessing which wrappers are missing.
    if (applied.some((record) => record.business_failure && !record.editor_verified)) return;
    const generatedPending = this.state.types.filter((record) => record.generation_status === "succeeded" && record.apply_status !== "applied");
    if (!applied.length && !generatedPending.length) return;
    const committed = await this.editorAiBlockCount();
    if (generatedPending.length === 0 && committed >= applied.length) return;

    const present = new Set();
    if (this.navigationHandler && await this.navigationHandler.editorBlockCount().catch(() => 0) === 1) present.add(NAVIGATION);
    if (this.filterHandler && await this.filterHandler.editorBlockCount().catch(() => 0) === 1) present.add(PRODUCT_FILTER);
    const standard = applied.filter((record) => specialHandlerKind(record.type) === "standard");
    for (const record of standard) if (snapshot.ids.includes(record.committed_block_id)) present.add(record.type);
    const missing = [
      ...applied.filter((record) => !present.has(record.type)),
      ...generatedPending.filter((record) => !present.has(record.type)),
    ];
    // A previous recovery may have committed a specialized block but crashed
    // before persisting its final marker.  If the specialized handler can
    // identify that block uniquely, trust the canvas and finalize the record
    // instead of inserting the same generated result a second time.
    for (const record of generatedPending) {
      if (!present.has(record.type)) continue;
      if (specialHandlerKind(record.type) === "product-filter" || specialHandlerKind(record.type) === "navigation") {
        record.apply_status = "applied";
        record.editor_verified = true;
        record.recovery_source = "existing-canvas";
        record.recovery_required = false;
      }
    }
    if (!missing.length) return;

    // Rebuild the applied-type list to reflect the reopened canvas. This lets
    // the existing specialized recovery handlers safely mark each recovered
    // record as applied again without triggering duplicate-type protection.
    this.state.page.types = this.state.types
      .filter((record) => present.has(record.type))
      .map((record) => record.type);
    this.state.page.saved = false;
    this.state.page.preview_verified = false;
    this.state.page.published_verified = false;
    this.state.page.publish_failure_reason = "";
    for (const record of missing) {
      record.apply_status = "pending";
      record.editor_verified = false;
      record.recovery_required = false;
    }
    await this.persist();
    for (const record of missing) {
      await this.recoverStandardGeneratedResult(record);
    }
  }

  async beforeFinalApply(context) {
    context.record.application_baseline = await this.canvasSnapshot();
    context.record.block_count_before = context.record.application_baseline.count;
    await this.persist();
    ensureSpecialTypeState(context.record);
    if (context.record.type === PRODUCT_FILTER) {
      await this.filterHandler.configureFilterBeforeApply(context.frame, context.record);
    } else if (context.record.type === NAVIGATION) {
      await this.navigationHandler.prepareNavigationResult(context.frame, context.record);
    }
  }

  async afterFinalApply(context) {
    if (context.record.type === NAVIGATION) {
      await this.navigationHandler.configureNavigationAfterApply(context.record);
    }
  }

  async editorAiBlockCount() {
    return (await this.canvasSnapshot()).count;
  }

  async canvasSnapshot() {
    return committedAiSnapshot(this.editor.page.frames(), { ownedBlankPage: true });
  }

  async checkpointAppliedType(record) {
    // Retain earlier successful blocks if a later type crashes or times out.
    // This is an editor checkpoint, not a publish or completed-page marker.
    await this.editor.savePage();
    record.checkpoint_saved = true;
    record.checkpoint_saved_at = new Date().toISOString();
    this.state.page.last_checkpoint_at = record.checkpoint_saved_at;
  }

  async confirmApplicationCommit({ record }) {
    const result = await waitForAiCommit(() => this.canvasSnapshot(), record.application_baseline,
      { timeoutMs: this.config.timeouts.blockRenderMs });
    record.application_commit_confirmed = true;
    record.committed_block_id = result.addedId;
    record.block_count_after = result.count;
    await this.persist();
  }

  async verifyEditorType(type) {
    const count = await this.editorAiBlockCount();
    const record = this.state.types.find((item) => item.type === type);
    record.block_count_after = count;
    // Other types may have been inserted since this record's checkpoint.
    // Rechecking an old type must use its identity, not its old total count.
    const snapshot = await this.canvasSnapshot();
    if (!record.committed_block_id || snapshot.ids.filter(id => id === record.committed_block_id).length !== 1) return false;
    if (type === PRODUCT_FILTER) {
      const settings = this.filterHandler.record().filter_settings;
      const evidence = await filterDisplayEvidence(this.editor.canvasContexts());
      settings.editor_display_verified = evidence.passed;
      await this.persist();
      return settings.select_all_checked === true && settings.apply_status === "succeeded" && evidence.passed;
    }
    if (type === NAVIGATION) {
      const settings = this.navigationHandler.record().navigation_settings;
      return settings.selected_count === this.config.ai.navigationRegression.selectPageCount &&
        settings.add_status === "succeeded" && settings.save_status === "succeeded";
    }
    return true;
  }

  async continueAfterTypeFailure(record, error) {
    record.canvas_diagnostic = [];
    for (const frame of this.editor.page.frames?.() || []) {
      if (isTemporaryAiFrame(frame)) continue;
      const root = frame.locator('#backstage-bodyArea').first();
      if (!await root.count().catch(() => 0)) continue;
      const nodes = await root.evaluate(area => [...area.querySelectorAll('.siteblocks-setting-wrap, .backstage-blocksEditor-wrap, .phoenix2-block-wrap, .block-container')]
        .map(node => ({ id: node.id, classes: node.className, parent: node.parentElement?.id, visible: !!node.getClientRects().length })),
        undefined, { timeout: 1000 }).catch(() => []);
      record.canvas_diagnostic.push({ nodes });
    }
    const dir = `${this.config.paths.artifactsDir}/${this.state.run_id || 'legacy'}`;
    await mkdir(dir, { recursive: true });
    const screenshot = `${dir}/page-${this.pageNumber}-${record.index}-failed.png`;
    if (this.editor.page.screenshot) {
      await this.editor.page.screenshot({ path: screenshot, fullPage: false }).then(() => {
        record.failure_screenshot = screenshot;
      }).catch(() => {});
    }
    if (!canContinueTypeFailure(record, error)) {
      if (record.application_attempted &&
          (record.apply_status !== "applied" || (!record.application_acknowledged && !record.editor_verified))) {
        error.message = `应用状态不确定：${record.type}；${error.message}`;
      }
      this.state.page.failure_reason = error.message;
      this.state.page.quarantined = !isGlobalSafetyFailure(error.message);
      await this.persist();
      return false;
    }
    record.recovery_required = false;
    record.business_failure = true;
    this.state.page.type_failures ??= [];
    this.state.page.type_failures.push({ type: record.type, reason: error.message, at: new Date().toISOString() });
    await this.persist();
    // A settings failure leaves the result view mounted while the generation
    // dialog itself is hidden. Close that view and its nested exit prompt;
    // otherwise it intercepts the next type's AI entry and final Save.
    if (this.editor.page.locator) await this.closeAiResult();
    // No reload: keep earlier blocks and continue with a fresh AI dialog.
    // generateAndApply closes the previous dialog before opening the next.
    return true;
  }

  async run(options = {}) {
    const state = await super.run(options);
    if (state.page.types.length === this.aiConfig.blocksPerPage && !state.page.type_failures?.length) {
      const count = await this.editorAiBlockCount();
      if (count !== this.aiConfig.blocksPerPage) {
        throw new Error(`${state.page.name} 编辑器检测到 ${count}/${this.aiConfig.blocksPerPage} 个 AI 区块`);
      }
    }
    if (state.page.published_verified && this.navigationHandler && this.navigationHandler.record().editor_verified && !state.page.public_navigation_verified) {
      await this.navigationHandler.verifyPublicNavigation();
    }
    if (state.page.published_verified && this.filterHandler) {
      const record = this.filterHandler.record();
      const publicPage = await this.editor.page.context().newPage();
      try {
        await publicPage.goto(state.page.publicUrl, { waitUntil: 'domcontentloaded' });
        const deadline = Date.now() + this.config.ai.publishTimeoutMs;
        let evidence;
        do {
          await publicPage.waitForTimeout(this.config.ai.publishPollIntervalMs);
          evidence = await filterDisplayEvidence(publicPage.frames());
          if (evidence.passed) break;
        } while (Date.now() < deadline);
        record.filter_settings.public_display_verified = evidence.passed;
        if (!evidence.passed) {
          const reason = '产品筛选全选后，公开页仍未显示有效筛选字段（占位提示或控件缺失）';
          record.published_verified = false;
          record.business_failure = true;
          record.failure_reason = reason;
          record.filter_settings.failure_reason = reason;
          state.page.published_verified = false;
          state.page.publish_failure_reason = reason;
          state.page.type_failures ??= [];
          if (!state.page.type_failures.some(item => item.type === PRODUCT_FILTER)) state.page.type_failures.push({ type: PRODUCT_FILTER, reason, at: new Date().toISOString() });
          record.failure_screenshot = `${this.config.paths.artifactsDir}/product-filter-public-${this.config.ai.runId}.png`;
          await mkdir(this.config.paths.artifactsDir, { recursive: true });
          await publicPage.screenshot({ path: record.failure_screenshot, fullPage: true }).catch(() => {});
        }
        await this.persist();
      } finally { await publicPage.close().catch(() => {}); }
    }
    // Page-wide flags never promote an individual failed block to passed.
    return state;
  }
}
