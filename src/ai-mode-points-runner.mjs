import { AiBlockAutomation } from "./ai-runner.mjs";
import { AiDialogPointsReader } from "./ai-points.mjs";
import { committedAiSnapshot, waitForAiCommit, committedIdentityEvidence } from "./ai-canvas-commit.mjs";
import { mkdir } from 'node:fs/promises';
import {
  assertModePointsState,
  createModePointsState,
  finishPointsCheck,
  modePointsPaths,
  readModeJson,
  resumeSafety,
  modeResumeAction,
  writeModeJson,
} from "./ai-mode-points-state.mjs";

async function waitFor(check, timeoutMs, label, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`${label}等待超时`);
}

async function modeMarkers(scope, headings) {
  const results = {};
  for (const heading of headings) {
    let count = 0;
    for (const frame of scope.frames()) {
      count += await frame.locator("div.siteblocks-setting-wrap, div.phoenix2-block-wrap")
        .filter({ has: frame.locator("section[class*='block-settingId-ai-copilot'], .ai-generated-block") })
        .filter({ hasText: heading }).count().catch(() => 0);
    }
    results[heading] = count;
  }
  return results;
}

function allOnce(counts, headings) {
  return headings.every((heading) => counts[heading] === 1);
}

async function identityCount(scope, identity) {
  const evidence = await committedIdentityEvidence(scope, identity);
  return evidence.ready ? evidence.count : 0;
}

export class AiModePointsAutomation {
  constructor(editor, config, runId) {
    this.editor = editor;
    this.config = config;
    this.mode = config.ai.modePointRegression;
    this.runId = runId;
    this.paths = modePointsPaths(config, runId);
    this.state = null;
    this.points = new AiDialogPointsReader(config);
    const scoped = { ...config, ai: { ...config.ai, inputMode: this.mode.inputMode, promptPolishEnabled: false, generationMode: this.mode.modes[0].label } };
    this.base = new AiBlockAutomation(editor, scoped);
    this.base.state = { page: { types: [] } };
  }

  async persist() { await writeModeJson(this.paths.state, this.state); }

  async initialize({ resume = false } = {}) {
    const existing = await readModeJson(this.paths.state);
    if (existing) {
      this.state = existing;
      assertModePointsState(existing, this.config, this.runId);
    } else {
      if (resume) throw new Error(`运行 ${this.runId} 没有点数专项状态，无法恢复`);
      this.state = createModePointsState(this.config, this.runId);
      await this.persist();
    }
    const exists = await this.editor.customPageExists(this.state.page.name);
    if (!exists) {
      if (existing && (this.state.initial_points !== null || this.state.records.some((record) => record.generation_status !== "pending"))) {
        throw new Error(`测试页 ${this.state.page.name} 已不存在，拒绝重复生成和扣点`);
      }
      await this.editor.createCustomPage(this.state.page, { onCreated: async receipt => {
        this.state.page.creation_receipt = receipt; await this.persist();
      } });
    } else {
      await this.editor.openCustomPage(this.state.page.name);
    }
    if (resume) {
      for (const record of this.state.records.filter((item) => item.application_status === "applying" && item.generation_status === "succeeded")) {
        const count = record.committed_block_id
          ? await this.editorIdentityCount(record.committed_block_id)
          : await this.editorMarkerCount(record.heading);
        if (count === 1 && ["passed", "failed"].includes(record.points_status)) {
          // The ID can already be present in the canvas before the page-level
          // Save checkpoint. Persist and reopen before allowing the next mode.
          try {
            await this.editor.savePage();
          } catch (error) {
            await this.editor.openCustomPage(this.state.page.name);
            const stillPresent = record.committed_block_id
              ? await this.editorIdentityCount(record.committed_block_id)
              : await this.editorMarkerCount(record.heading);
            if (stillPresent !== 1) throw error;
          }
          record.checkpoint_saved = true;
          await this.persist();
          await this.editor.openCustomPage(this.state.page.name);
          const persistedCount = record.committed_block_id
            ? await this.editorIdentityCount(record.committed_block_id)
            : await this.editorMarkerCount(record.heading);
          if (persistedCount !== 1) throw new Error(`${record.mode_label} 已应用，但保存后重新进入未找到唯一区块`);
          record.reopen_verified = true;
          record.application_status = "applied";
          record.editor_verified = true;
          record.applied_at ||= new Date().toISOString();
          record.failure_reason = "";
          await this.persist();
        }
      }
      resumeSafety(this.state);
      for (const record of this.state.records.filter((item) => item.application_status === "applied")) {
        const count = record.committed_block_id
          ? await this.editorIdentityCount(record.committed_block_id)
          : await this.editorMarkerCount(record.heading);
        if (count !== 1) throw new Error(`${record.mode_label} 已应用，但编辑器中匹配到 ${count} 个区块；请人工检查`);
      }
    }
    return this.state;
  }

  async editorMarkerCount(heading) {
    let count = 0;
    for (const frame of this.editor.canvasContexts()) {
      count += await frame.locator("div.siteblocks-setting-wrap")
        .filter({ has: frame.locator("section[class*='block-settingId-ai-copilot'], .ai-generated-block") })
        .filter({ hasText: heading }).count().catch(() => 0);
    }
    return count;
  }

  async editorIdentityCount(identity) {
    // The CMS may strip the AI-specific wrapper class on commit, even though
    // the generated content and its stable DOM ID remain in the page canvas.
    // Resolve the stable ID directly across non-temporary frames; the baseline
    // and commit barrier already proved it was the unique new page node.
    return identityCount(this.editor.page, identity);
  }

  async selectType(frame) {
    await frame.locator(this.config.selectors.aiCategoryTriggerSelector).click();
    const option = frame.locator(this.config.selectors.aiCategoryOptionSelector).filter({ hasText: this.mode.type }).first();
    await option.waitFor({ state: "visible", timeout: this.config.timeouts.actionMs });
    await option.click({ force: true });
    const chosen = await frame.locator(this.config.selectors.aiCategoryTriggerSelector).innerText();
    if (!chosen.includes(this.mode.type)) throw new Error(`AI 类型选择失败：${this.mode.type}`);
  }

  async closeGenerationDialog(frame) {
    await this.base.closeAiGenerationDialog(frame);
    await this.base.closeAiResult();
  }

  async inspectModeHistory(frame, record) {
    const cards = frame.locator(this.config.selectors.aiHistoryCardSelector);
    const matches = [];
    const normalize = (value) => String(value).replace(/\s+/g, " ").trim();
    for (let index = 0, count = await cards.count(); index < count; index += 1) {
      const card = cards.nth(index);
      if (!(await card.isVisible().catch(() => false))) continue;
      const text = await card.innerText();
      const id = await card.getAttribute("data-id") || await card.getAttribute("data-record-id") || "";
      if (record.generation_record_id ? id !== record.generation_record_id : !normalize(text).includes(normalize(record.original_prompt))) continue;
      matches.push({ card, text, id });
    }
    if (matches.length > 1) throw new Error(`${record.mode_label} 生成记录匹配不唯一，拒绝插入或重新扣点`);
    if (!matches.length) return null;
    const { card, text, id } = matches[0];
    if (id) record.generation_record_id = id;
    if (/生成失败|已自动退还|失败，点数将自动退还/.test(text) || /is-failed/.test(await card.getAttribute("class") || "")) {
      const error = new Error(`${record.mode_label} AI 类型生成失败：${text.slice(-300)}`);
      error.code = "GENERATION_FAILED";
      error.frame = frame;
      error.refundAnnounced = /已自动退还\s*\d+\s*点/.test(text);
      throw error;
    }
    const insert = card.locator("button").filter({ hasText: /插入|应用模块/ }).first();
    return await insert.isVisible().catch(() => false) && await insert.isEnabled().catch(() => false)
      ? { mode: "history", control: insert, frame } : { status: "generating", frame };
  }

  async waitForModeGeneration(record, frame) {
    const started = Date.now();
    const timeoutMs = this.mode.generationTimeoutMs;
    const intervalMs = this.mode.generationStatusRefreshIntervalMs;
    const deadline = started + timeoutMs;
    while (Date.now() < deadline) {
      const cycleStarted = Date.now();
      // Prefer this fresh result before opening history. After a refresh the
      // only safe fallback is the uniquely matched record from this run.
      if (!record.recovered_from_history && !(record.status_refresh_count > 0)) {
        const currentDeadline = Math.min(deadline, started + intervalMs);
        do {
          const module = frame.locator('button').filter({ hasText: '应用模块' }).first();
          if (await module.isVisible().catch(() => false) && await module.isEnabled().catch(() => false)) {
            return { mode: 'module', control: module, frame };
          }
          await this.editor.page.waitForTimeout(Math.min(250, Math.max(0, currentDeadline - Date.now())));
        } while (Date.now() < currentDeadline);
      }
      const trigger = frame.locator(this.config.selectors.aiHistoryTriggerSelector).first();
      await trigger.waitFor({ state: "visible", timeout: this.config.timeouts.actionMs });
      if (!/(?:^|[\s-])active(?:\s|$)/.test(await trigger.getAttribute("class") || "")) await trigger.click();
      // Allow the history request to populate after each fresh dialog open.
      let result = null;
      const historyDeadline = Math.min(deadline, Date.now() + this.config.timeouts.actionMs);
      do {
        result = await this.inspectModeHistory(frame, record);
        if (result) break;
        await this.editor.page.waitForTimeout(Math.min(250, Math.max(0, historyDeadline - Date.now())));
      } while (Date.now() < historyDeadline);
      record.last_observed_status = result?.control ? "succeeded" : result ? "generating" : "not-found";
      record.generation_wait_ms = Date.now() - started;
      record.last_status_refresh_at = new Date().toISOString();
      await this.persist();
      if (result?.control) return result;
      // History is a snapshot. Polling its DOM cannot refresh generation.
      await this.closeGenerationDialog(frame);
      await this.editor.page.waitForTimeout(Math.min(Math.max(0, intervalMs - (Date.now() - cycleStarted)), Math.max(0, deadline - Date.now())));
      if (Date.now() >= deadline) break;
      frame = await this.base.openAiDialog();
      record.status_refresh_count = (record.status_refresh_count ?? 0) + 1;
    }
    record.generation_wait_ms = Date.now() - started;
    const error = new Error(`${record.mode_label} AI 区块生成结果等待超时（${timeoutMs}ms）；记录状态不确定，恢复时仅查询本轮记录，不重新生成或扣点`);
    error.code = "GENERATION_TIMEOUT";
    throw error;
  }

  async runMode(record, { recover = false, reusePoints = false } = {}) {
    let frame = await this.base.openAiDialog();
    if (!recover) {
      await this.base.selectInputMode(frame);
      await this.selectType(frame);
      this.base.aiConfig.generationMode = record.mode_label;
      await this.base.selectGenerationMode(frame);
      const selected = await frame.locator(this.config.selectors.aiTierTriggerSelector).innerText();
      if (!selected.includes(record.mode_label)) throw new Error(`${record.mode_label} 未选中`);
      const prompt = frame.locator(this.config.selectors.aiPromptSelector).first();
      await prompt.fill(record.original_prompt);
      const before = await this.points.read(frame);
      if (before < record.expected_cost) throw new Error(`余额不足：${record.mode_label} 可用点数 ${before}，不足 ${record.expected_cost} 点`);
      if (this.state.initial_points === null) this.state.initial_points = before;
      record.points_source = "ai-dialog-settings";
      record.points_before = before;
      record.points_status = "checking";
      record.generation_status = "running";
      record.started_at = new Date().toISOString();
      await this.persist();
      const generate = frame.locator(this.config.selectors.aiGenerateSelector).first();
      await this.base.waitForAiControlReady(frame, generate, "AI 开始生成按钮");
      this.base.persist = async () => this.persist();
      await this.base.submitBlockGeneration(frame, generate, record.original_prompt, record);
      record.submitted_at = new Date().toISOString();
      await this.persist();
    } else {
      if (await this.editorMarkerCount(record.heading) !== 0) throw new Error(`${record.mode_label} 应用状态不确定，页面已有区块，请人工检查`);
      record.recovered_from_history = true;
      if (record.failure_reason) {
        record.previous_failures ??= [];
        record.previous_failures.push({ reason: record.failure_reason, recovered_at: new Date().toISOString() });
      }
      await this.persist();
    }
    let result;
    try {
      result = await this.waitForModeGeneration(record, frame);
      frame = result.frame;
      record.generation_status = "succeeded";
      record.generated_at = new Date().toISOString();
      record.failure_reason = "";
      await this.persist();
    } catch (error) {
      record.generation_status = error.code === "GENERATION_FAILED" ? "failed" : "uncertain";
      record.points_status = "uncertain";
      if (error.code === "GENERATION_FAILED" && error.refundAnnounced) {
        await this.confirmRefund(error.frame || frame, record).catch(() => {});
      }
      if (record.generation_status === "uncertain") error.message = `扣点状态不确定：${error.message}`;
      record.failure_reason = error.message;
      await this.persist();
      throw error;
    }
    if (reusePoints && (record.points_status !== 'passed' || !Number.isFinite(record.points_after) ||
        record.points_before - record.points_after !== record.expected_cost)) throw new Error('点数证据不完整，拒绝只恢复应用');
    try {
      if (!reusePoints) {
        const after = await this.points.waitForCharge(frame, record.points_before, record.expected_cost, {
          timeoutMs: this.mode.pointsTimeoutMs,
          intervalMs: this.mode.pointsPollIntervalMs,
        });
        finishPointsCheck(record, after);
        await this.persist();
      }
    } catch (error) {
      record.points_status = "uncertain";
      error.message = `扣点状态不确定：${error.message}`;
      record.points_failure_reason = error.message;
      await this.persist();
      throw error;
    }
    if (result.mode === 'history') result = await this.inspectModeHistory(frame, record);
    if (!result?.control) throw new Error(`${record.mode_label} 当前生成记录无法再次确认，拒绝应用`);
    record.application_source = result.mode === 'history' ? 'history' : 'current-result';
    record.application_status = "applying";
    await this.persist();
    await result.control.click();
    // Inserting a history result may expose an intermediate Apply Module.
    const next = result.mode !== 'history' ? 'final' : await waitFor(async () => {
      const module = frame.locator("button").filter({ hasText: "应用模块" }).first();
      if (await module.isVisible().catch(() => false) && await module.isEnabled().catch(() => false)) return module;
      const final = frame.locator(this.config.selectors.aiApplySelector).filter({ hasText: /^应用$/ }).first();
      return await final.isVisible().catch(() => false) && await final.isEnabled().catch(() => false) ? "final" : false;
    }, this.config.timeouts.blockRenderMs, `${record.mode_label} 历史记录插入`);
    if (next !== "final") await next.click();
    const apply = frame.locator(this.config.selectors.aiApplySelector).filter({ hasText: /^应用$/ }).first();
    await apply.waitFor({ state: "visible", timeout: this.config.timeouts.blockRenderMs });
    await this.base.waitForAiControlReady(frame, apply, "AI 应用按钮");
    const baseline = await committedAiSnapshot(this.editor.canvasContexts(), { ownedBlankPage: true });
    if (baseline.ids.length !== baseline.count || baseline.ids.some((id) => !id)) {
      throw new Error(`${record.mode_label} 应用前无法读取全部现有 AI 区块 ID，拒绝提交`);
    }
    record.application_baseline_ids = baseline.ids;
    record.application_baseline_count = baseline.count;
    await this.persist();
    const responsePromise = this.editor.page.waitForResponse((response) =>
      response.request().method() === "POST" && response.url().includes("/phoenix2/composite/editor/v1/newEditor/savePage"),
    { timeout: this.config.timeouts.blockRenderMs }).catch(() => null);
    await apply.click();
    const response = await responsePromise;
    if (response && !response.ok()) throw new Error(`${record.mode_label} 应用接口返回 HTTP ${response.status()}`);
    const committed = await waitForAiCommit(
      () => committedAiSnapshot(this.editor.canvasContexts(), { ownedBlankPage: true }), baseline,
      { timeoutMs: this.config.timeouts.blockRenderMs, stableMs: 3000 },
    );
    record.committed_block_id = committed.addedId;
    record.application_commit_confirmed = true;
    await this.persist();
    const close = frame.locator(".close-icon-container").first();
    if (await close.isVisible().catch(() => false)) await close.click();
    await this.editor.page.waitForTimeout(this.config.ai.applyIntervalMs);
    const count = await waitFor(() => this.editorIdentityCount(record.committed_block_id), this.config.timeouts.blockRenderMs, `${record.mode_label} 编辑器区块 ID`);
    record.application_status = "applied";
    record.applied_at = new Date().toISOString();
    record.editor_verified = count === 1;
    await this.persist();
    if (!record.editor_verified) throw new Error(`${record.mode_label} 编辑器内匹配到 ${count} 个区块，预期 1 个`);
    await this.editor.savePage();
    record.checkpoint_saved = true;
    await this.persist();
    await this.editor.openCustomPage(this.state.page.name);
    const persistedCount = await waitFor(() => this.editorIdentityCount(record.committed_block_id), this.config.timeouts.blockRenderMs, `${record.mode_label} 保存后区块 ID`);
    record.reopen_verified = persistedCount === 1;
    await this.persist();
    if (!record.reopen_verified) throw new Error(`${record.mode_label} 保存后重新进入页面未找到唯一的区块 ID`);
  }

  async confirmRefund(frame, record) {
    const deadline = Date.now() + this.mode.pointsTimeoutMs;
    while (Date.now() < deadline) {
      const after = await this.points.read(frame);
      if (after === record.points_before) {
        record.points_after = after;
        record.actual_cost = 0;
        record.points_status = "failed";
        record.points_checked_at = new Date().toISOString();
        record.points_failure_reason = "生成失败，已确认点数全部退还";
        record.refund_confirmed = true;
        record.application_status = "failed";
        await this.persist();
        return;
      }
      await this.editor.page.waitForTimeout(this.mode.pointsPollIntervalMs);
    }
    throw new Error("生成失败后的退款余额尚未确认");
  }

  async verifyPreview(records = this.state.records) {
    const before = new Set(this.editor.page.context().pages());
    const popupPromise = this.editor.page.context().waitForEvent("page", { timeout: 10_000 }).catch(() => null);
    await this.editor.page.locator(".clickToPreview").first().click();
    const preview = await popupPromise ?? this.editor.page.context().pages().find((page) => !before.has(page));
    if (!preview) throw new Error("点击预览后没有打开页面");
    try {
      const counts = await waitFor(async () => {
        const values = Object.fromEntries(await Promise.all(records.map(async (record) =>
          [record.mode, await identityCount(preview, record.committed_block_id)])));
        return records.every((record) => values[record.mode] === 1) ? values : null;
      }, this.config.timeouts.blockRenderMs, "三模式预览区块 ID", 500);
      this.state.page.preview_verified = records.length === this.state.records.length;
      this.state.page.partial_preview_verified = true;
      for (const record of records) record.preview_verified = counts[record.mode] === 1;
      await this.persist();
    } finally { await preview.close().catch(() => {}); }
  }

  async verifyPublished(records = this.state.records) {
    const publicPage = await this.editor.page.context().newPage();
    try {
      await publicPage.waitForTimeout(this.config.ai.publishInitialWaitMs);
      const counts = await waitFor(async () => {
        await publicPage.goto(this.state.page.publicUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
        const values = Object.fromEntries(await Promise.all(records.map(async (record) =>
          [record.mode, await identityCount(publicPage, record.committed_block_id)])));
        return records.every((record) => values[record.mode] === 1) ? values : null;
      }, this.config.ai.publishTimeoutMs, "三模式公开页区块 ID", this.config.ai.publishPollIntervalMs);
      this.state.page.published_verified = records.length === this.state.records.length;
      this.state.page.partial_published_verified = true;
      for (const record of records) record.published_verified = counts[record.mode] === 1;
      await this.persist();
    } finally { await publicPage.close().catch(() => {}); }
  }

  async run({ resume = false } = {}) {
    try {
      await this.initialize({ resume });
      for (const record of this.state.records) {
        const action = modeResumeAction(record);
        if (action === "done" || action === "skip-failed") continue;
        try { await this.runMode(record, { recover: action === "recover-history" }); }
        catch (error) {
          record.failure_reason = error.message;
          await this.persist();
          let safeToContinue = false;
          try { safeToContinue = modeResumeAction(record) === "skip-failed"; } catch {}
          if (!safeToContinue) throw error;
          // A failed generation with a verified full refund has no ambiguous
          // application or credit state. Close only its AI surface, then let
          // the next independent mode run; do not silently regenerate it.
          await this.base.closeAiResult();
        }
      }
      const failed = this.state.records.filter(record => record.generation_status === "failed");
      if (failed.length) {
        const applied = this.state.records.filter(record => record.application_status === "applied" && record.editor_verified);
        if (applied.length) {
          await this.editor.savePage();
          this.state.page.saved = true;
          await this.persist();
          await this.verifyPreview(applied);
          if (this.state.page.publish_status !== "accepted") {
            if (this.state.page.publish_status === "running") throw new Error("上次发布请求状态不确定；请人工检查后恢复");
            this.state.page.publish_status = "running";
            await this.persist();
            await this.editor.publishSite();
            this.state.page.publish_status = "accepted";
            await this.persist();
          }
          await this.verifyPublished(applied);
        }
        throw new Error(`三模式回归部分失败：${failed.map(record => `${record.mode_label}生成失败（已确认退款）`).join("；")}`);
      }
      const verified = {};
      for (const record of this.state.records) {
        verified[record.mode] = record.committed_block_id
          ? await this.editorIdentityCount(record.committed_block_id)
          : await this.editorMarkerCount(record.heading);
      }
      this.state.page.editor_verified = this.state.records.every((record) => verified[record.mode] === 1);
      await this.persist();
      if (!this.state.page.editor_verified) throw new Error("编辑器未展示全部三个模式区块，或存在重复区块");
      if (!this.state.page.saved) {
        try { await this.editor.savePage(); }
        catch (error) {
          // The 4.0 Apply action saves the page immediately. The top-right
          // Save button may emit no success response when nothing is dirty.
          await this.editor.openCustomPage(this.state.page.name);
          const persisted = {};
          for (const record of this.state.records) persisted[record.mode] = record.committed_block_id
            ? await this.editorIdentityCount(record.committed_block_id) : await this.editorMarkerCount(record.heading);
          if (!this.state.records.every(record => persisted[record.mode] === 1)) throw error;
          this.state.page.save_warning = "顶部保存未返回成功信号；重进编辑器后确认三个区块已持久化";
        }
        this.state.page.saved = true;
        await this.persist();
      }
      if (!this.state.page.preview_verified) await this.verifyPreview();
      if (!this.state.page.published_verified) {
        if (this.state.page.publish_status === "running") throw new Error("上次发布请求状态不确定；请人工检查后恢复");
        if (this.state.page.publish_status !== "accepted") {
          this.state.page.publish_status = "running";
          await this.persist();
          await this.editor.publishSite();
          this.state.page.publish_status = "accepted";
          await this.persist();
        }
        await this.verifyPublished();
      }
      this.state.page.failure_reason = "";
      await this.persist();
      return this.state;
    } catch (error) {
      if (this.state) {
        this.state.page.failure_reason = error.message;
        try {
          if (this.editor.page?.screenshot) {
            await mkdir(this.paths.root, { recursive: true });
            const screenshot = `${this.paths.root}/failure-${Date.now()}.png`;
            await this.editor.page.screenshot({ path: screenshot, fullPage: false });
            this.state.page.failure_screenshot = screenshot;
          }
        } catch { /* A diagnostic failure must not replace the business error. */ }
        await this.persist();
      }
      throw error;
    }
  }

  async cleanup() {
    const state = await readModeJson(this.paths.state);
    if (!state) throw new Error(`运行 ${this.runId} 没有点数专项状态`);
    assertModePointsState(state, this.config, this.runId);
    this.state = state;
    if (!state.page.name.endsWith(this.runId)) throw new Error("测试页面名称缺少运行 ID，拒绝删除");
    if (state.page.cleanup_status === "completed") return state;
    if (!(await this.editor.customPageExists(state.page.name))) throw new Error("测试页面不存在，无法确认清理目标");
    await this.editor.openCustomPage(state.page.name);
    const applied = state.records.filter((record) => record.application_status === "applied");
    for (const record of applied) {
      const matches = await this.editor.findAiBlockWrappers({ marker: record.heading });
      if (matches.length !== 1) throw new Error(`${record.mode_label} 区块匹配数量=${matches.length}，拒绝清理`);
    }
    for (const record of applied) {
      await this.editor.deleteAiBlock({ marker: record.heading, apply: true });
      const remaining = await this.editor.findAiBlockWrappers({ marker: record.heading });
      if (remaining.length) throw new Error(`${record.mode_label} 区块删除后仍可见`);
    }
    if (applied.length) await this.editor.savePage();
    const deleted = await this.editor.deleteCustomPage(state.page.name, { apply: true });
    if (!deleted.applied || await this.editor.customPageExists(state.page.name)) throw new Error("测试页面删除后仍在页面列表");
    await this.editor.publishSite();
    state.page.cleanup_status = "completed";
    state.page.cleaned_at = new Date().toISOString();
    await this.persist();
    return state;
  }
}
