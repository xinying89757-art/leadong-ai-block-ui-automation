import { stat, writeFile } from "node:fs/promises";
import { AiBlockAutomation } from "./ai-runner.mjs";
import { AiDialogPointsReader } from "./ai-points.mjs";
import { isGlobalSafetyFailure } from './ai-regression-state.mjs';
import { committedAiSnapshot, waitForAiCommit, committedIdentityEvidence } from './ai-canvas-commit.mjs';
import {
  assertInputModeState,
  createInputModeState,
  finishInputPointsCheck,
  inputModePage,
  inputModePaths,
  inputModeResumeSafety,
  readInputModeJson,
  writeInputModeJson,
} from "./ai-input-modes-state.mjs";

async function waitFor(check, timeoutMs, label, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`${label}等待超时`);
}

async function visible(locator) { return locator.isVisible().catch(() => false); }

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

function allOnce(counts, headings) { return headings.every((heading) => counts[heading] === 1); }

async function renderEvidence(scope) {
  let textLength = 0;
  let blockCount = 0;
  for (const frame of scope.frames()) {
    const text = await frame.locator("body").innerText().catch(() => "");
    textLength = Math.max(textLength, text.trim().length);
    const count = await frame.locator(
      ".ai-generated-block, section[class*='block-settingId-ai-copilot'], .block-container[class*='block-settingId-ai-copilot']",
    ).count().catch(() => 0);
    blockCount = Math.max(blockCount, count);
  }
  const htmlLength = await scope.content().then((html) => html.length).catch(() => 0);
  return { textLength, htmlLength, blockCount, passed: (textLength > 0 || htmlLength > 1000) && blockCount >= 1 };
}

export class AiInputModesAutomation {
  constructor(editor, config, runId) {
    this.editor = editor;
    this.config = config;
    this.mode = config.ai.inputModeRegression;
    this.runId = runId;
    this.paths = inputModePaths(config, runId);
    this.state = null;
    this.points = new AiDialogPointsReader(config);
    const scoped = { ...config, ai: { ...config.ai, inputMode: this.mode.inputModes[0].label, generationMode: this.mode.generationMode, promptPolishEnabled: false } };
    this.base = new AiBlockAutomation(editor, scoped);
    this.base.state = { page: { types: [] } };
  }

  async persist() { await writeInputModeJson(this.paths.state, this.state); }

  async validateFixtures(inputMode) {
    if (!inputMode || inputMode === 'image') try {
      const image = await stat(this.mode.imagePath);
      if (!image.isFile()) throw new Error("测试图片路径不是文件");
    } catch (error) {
      throw new Error(`上传图片测试文件不可用：${this.mode.imagePath}（${error.message}）`);
    }
    if (!inputMode || inputMode === 'url') {
      const url = new URL(this.mode.referenceUrl);
      if (url.protocol !== "https:") throw new Error("提供网址测试必须使用 HTTPS 地址");
    }
  }

  async initialize({ resume = false } = {}) {
    const existing = await readInputModeJson(this.paths.state);
    if (existing) {
      this.state = existing;
      assertInputModeState(existing, this.config, this.runId);
    } else {
      if (resume) throw new Error(`运行 ${this.runId} 没有输入方式专项状态，无法恢复`);
      this.state = createInputModeState(this.config, this.runId);
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
      // The block canvas is an about:blank child frame and can render after
      // the pagebuilder iframe itself reports ready.
      await this.editor.page.waitForTimeout(5000);
      for (const record of this.state.records.filter((item) => item.input_status === "failed" && item.generation_status === "pending" && item.points_status === "pending" && item.application_status === "pending")) {
        record.input_status = "pending";
        record.input_failure_reason = "";
        record.failure_reason = "";
        await this.persist();
      }
      for (const record of this.state.records.filter((item) => ["applying", "applied"].includes(item.application_status) && item.generation_status === "succeeded" && ["passed", "failed"].includes(item.points_status))) {
        if (record.application_status === 'applying' && !record.committed_block_id && Number.isInteger(record.application_baseline_count)) {
          const committed = await waitForAiCommit(() => committedAiSnapshot(this.editor.page.frames(), { ownedBlankPage: true }),
            { ids: record.application_baseline_ids || [], count: record.application_baseline_count }, { timeoutMs: this.config.timeouts.blockRenderMs });
          record.committed_block_id = committed.addedId; record.application_commit_confirmed = true;
          await this.persist();
        }
        const count = await this.recordIdentityCount(record);
        if (count === 1 && ["passed", "failed"].includes(record.points_status)) {
          record.application_status = "applied";
          record.editor_verified = true;
          record.applied_at ||= new Date().toISOString();
          record.failure_reason = "";
          await this.persist();
        } else if (count === 0) {
          if (record.committed_block_id) throw new Error(`${record.input_mode_label} 已提交区块 ID 不在正文，应用状态不确定`);
          await this.recoverGeneratedRecord(record);
        } else {
          throw new Error(`${record.input_mode_label} 应用状态不明确，编辑器中匹配到 ${count} 个区块；请人工检查`);
        }
      }
      inputModeResumeSafety(this.state);
      for (const record of this.state.records.filter((item) => item.application_status === "applied")) {
        const count = await this.recordIdentityCount(record);
        if (count !== 1) throw new Error(`${record.input_mode_label} 已应用，但编辑器中匹配到 ${count} 个区块；请人工检查`);
      }
    }
    return this.state;
  }

  async editorMarkerCount(heading) {
    let count = 0;
    for (const frame of [this.editor.page, ...this.editor.page.frames()]) {
      const primary = frame.locator(".block-container[class*='block-settingId-ai-copilot']").filter({ hasText: heading });
      const primaryCount = await primary.count().catch(() => 0);
      const fallback = primaryCount > 0 ? primaryCount : await frame.locator("div.siteblocks-setting-wrap, .ai-generated-block").filter({ hasText: heading }).count().catch(() => 0);
      count = Math.max(count, fallback);
    }
    return count;
  }

  async recordIdentityCount(record, page = this.editor.page) {
    if (record.committed_block_id) {
      const evidence = await committedIdentityEvidence(page, record.committed_block_id);
      return evidence.ready ? evidence.count : 0;
    }
    return page === this.editor.page ? this.editorMarkerCount(record.heading) : (await modeMarkers(page, [record.heading]))[record.heading];
  }

  async recoverGeneratedRecord(record) {
    const frame = await this.base.openAiDialog();
    const history = frame.locator(this.config.selectors.aiHistoryTriggerSelector ?? ".ai-history-trigger").first();
    if (await visible(history)) await history.click();
    const cards = frame.locator(this.config.selectors.aiHistoryCardSelector);
    const card = await waitFor(async () => {
      const matches = [];
      for (let index = 0; index < await cards.count().catch(() => 0); index++) {
        const candidate = cards.nth(index);
        const id = await candidate.getAttribute('data-id').catch(() => '') || await candidate.getAttribute('data-record-id').catch(() => '') || '';
        const text = await candidate.innerText().catch(() => '');
        if (record.generation_record_id ? id === record.generation_record_id : text.includes(record.original_prompt)) matches.push(candidate);
      }
      if (matches.length > 1) throw new Error('历史生成记录匹配不唯一，拒绝应用');
      return matches.length === 1 ? matches[0] : false;
    }, this.config.timeouts.blockRenderMs, '本轮输入方式生成记录');
    return this.applyRecoveredCard(record, frame, card);
  }

  async applyRecoveredCard(record, frame, card) {
    await card.waitFor({ state: "visible", timeout: this.config.timeouts.blockRenderMs });
    const insert = card.locator("button.ai-history-insert, button").filter({ hasText: /插入|应用模块/ }).first();
    await insert.waitFor({ state: "visible", timeout: this.config.timeouts.actionMs });
    await insert.click();
    const apply = frame.locator(this.config.selectors.aiApplySelector).filter({ hasText: /^应用$/ }).first();
    await apply.waitFor({ state: "visible", timeout: this.config.timeouts.blockRenderMs });
    const baseline = await committedAiSnapshot(this.editor.page.frames(), { ownedBlankPage: true });
    record.application_baseline_ids = baseline.ids;
    record.application_baseline_count = baseline.count;
    record.application_status = 'applying'; await this.persist();
    await apply.click();
    const committed = await waitForAiCommit(() => committedAiSnapshot(this.editor.page.frames(), { ownedBlankPage: true }), baseline,
      { timeoutMs: this.config.timeouts.blockRenderMs });
    record.committed_block_id = committed.addedId;
    record.application_commit_confirmed = true;
    await this.persist();
    const close = frame.locator(".close-icon-container").first();
    if (await visible(close)) await close.click();
    await this.editor.page.waitForTimeout(this.config.ai.applyIntervalMs);
    const count = await waitFor(() => this.recordIdentityCount(record), this.config.timeouts.blockRenderMs, `${record.input_mode_label}历史结果恢复`);
    if (count !== 1) throw new Error(`${record.input_mode_label}历史结果恢复后匹配到 ${count} 个区块`);
    record.application_status = "applied";
    record.editor_verified = true;
    record.applied_at ||= new Date().toISOString();
    record.failure_reason = "";
    await this.persist();
    await this.editor.savePage();
  }

  async selectType(frame) {
    await frame.locator(this.config.selectors.aiCategoryTriggerSelector).click();
    const option = frame.locator(this.config.selectors.aiCategoryOptionSelector).filter({ hasText: this.mode.type }).first();
    await option.waitFor({ state: "visible", timeout: this.config.timeouts.actionMs });
    await option.click({ force: true });
    const chosen = await frame.locator(this.config.selectors.aiCategoryTriggerSelector).innerText();
    if (!chosen.includes(this.mode.type)) throw new Error(`AI 类型选择失败：${this.mode.type}`);
  }

  async configureInput(frame, record) {
    await this.validateFixtures(record.input_mode);
    const tab = frame.locator(this.config.selectors.aiInputModeSelector).filter({ hasText: record.input_mode_label }).first();
    await tab.waitFor({ state: "visible", timeout: this.config.timeouts.actionMs });
    await tab.click();
    await waitFor(() => tab.evaluate((element) => element.classList.contains("active")).catch(() => false), this.config.timeouts.actionMs, `${record.input_mode_label}页签`);
    if (record.input_mode === "text") {
      const prompt = frame.locator(this.config.selectors.aiCardPromptSelector).first();
      await prompt.fill(record.original_prompt);
      if ((await prompt.inputValue()).trim() !== record.original_prompt.trim()) throw new Error("文字描述未成功填入");
    } else if (record.input_mode === "image") {
      const fileInput = frame.locator(this.config.selectors.aiUploadFileSelector).first();
      await fileInput.setInputFiles(record.image_path);
      // Some builds render the thumbnail only after an asynchronous upload,
      // while others keep the preview node hidden and expose the selected file
      // through the native input. Treat a non-empty `files` list as the
      // authoritative upload evidence and use the thumbnail as a secondary
      // check rather than failing on a cosmetic selector.
      const uploaded = await waitFor(async () => fileInput
        .evaluate((element) => Boolean(element.files?.length))
        .catch(() => false), this.config.timeouts.actionMs, "上传图片文件").catch(() => false);
      if (!uploaded) {
        await waitFor(() => frame.locator(
          `${this.config.selectors.aiUploadPreviewSelector}, img[src^='blob:'], .upload-preview, .image-preview, .el-upload-list__item`,
        ).count().then(async (count) => {
          for (let index = 0; index < count; index += 1) if (await visible(frame.locator(
            `${this.config.selectors.aiUploadPreviewSelector}, img[src^='blob:'], .upload-preview, .image-preview, .el-upload-list__item`,
          ).nth(index))) return true;
          return false;
        }).catch(() => false), this.config.timeouts.actionMs, "上传图片预览");
      }
      const prompt = frame.locator(this.config.selectors.aiPlainPromptSelector).first();
      await prompt.fill(`[runId=${this.runId},input=image] Use the uploaded image as the visual reference. Create the English static image-and-text block with the exact heading "${record.heading}", a concise description, and a Learn More CTA.`);
      record.original_prompt = await prompt.inputValue();
    } else if (record.input_mode === "url") {
      const url = frame.locator(this.config.selectors.aiUrlSelector).first();
      await url.fill(record.reference_url);
      if ((await url.inputValue()).trim() !== record.reference_url) throw new Error("参考网址未成功填入");
      const prompt = frame.locator(this.config.selectors.aiPlainPromptSelector).first();
      await prompt.fill(`[runId=${this.runId},input=url] Use the provided webpage as visual reference. Create an English static image-and-text block with the exact heading "${record.heading}", a concise description, an image area, and a Learn More CTA.`);
      record.original_prompt = await prompt.inputValue();
    } else {
      throw new Error(`不支持的输入方式：${record.input_mode}`);
    }
    record.input_status = "succeeded";
    record.input_failure_reason = "";
    await this.persist();
  }

  async runRecord(record) {
    let frame = await this.base.openAiDialog();
    this.base.aiConfig.inputMode = record.input_mode_label;
    this.base.aiConfig.generationMode = this.mode.generationMode;
    // Select the block category first.  After the first generated result the
    // dialog can reopen with the previous category's compact tab set; choosing
    // 静态图文 refreshes the input tabs and makes 上传图片/提供网址 available.
    await this.selectType(frame);
    await this.base.selectInputMode(frame);
    await this.base.selectGenerationMode(frame);
    try {
      await this.configureInput(frame, record);
    } catch (error) {
      record.input_status = "failed";
      record.input_failure_reason = error.message;
      record.failure_reason = error.message;
      await this.editor.page.screenshot({ path: `${this.paths.root}/input-${record.input_mode}-failure.png`, fullPage: false }).catch(() => {});
      await writeFile(`${this.paths.root}/input-${record.input_mode}-frame.html`, await frame.locator("body").innerHTML().catch(() => ""), "utf8").catch(() => {});
      await this.persist();
      throw error;
    }
    const before = await this.points.read(frame);
    if (before < record.expected_cost) throw new Error(`${record.input_mode_label} 可用点数 ${before}，不足 ${record.expected_cost} 点`);
    if (this.state.initial_points === null) this.state.initial_points = before;
    record.points_source = "ai-dialog-settings";
    record.points_before = before;
    record.points_status = "checking";
    record.generation_status = "running";
    record.started_at = new Date().toISOString();
    await this.persist();

    const generate = frame.locator(this.config.selectors.aiGenerateSelector).first();
    await this.base.waitForAiControlReady(frame, generate, "AI 开始生成按钮");
    const historyCount = await frame.locator(this.config.selectors.aiHistoryCardSelector).count();
    this.base.persist = async () => this.persist();
    await this.base.submitBlockGeneration(frame, generate, record.original_prompt, record);
    let result;
    try {
      result = await this.base.waitForGeneration(
        frame,
        record.original_prompt,
        historyCount,
        this.mode.generationTimeoutMs ?? this.config.ai.generationTimeoutMs ?? 180000, record,
      );
      frame = result.frame ?? frame;
      record.application_source = result.mode === 'history' ? 'history' : 'current-result';
      record.generation_record_id = result.recordId || record.generation_record_id || '';
      record.generation_status = "succeeded";
      record.generated_at = new Date().toISOString();
      await this.persist();
    } catch (error) {
      record.generation_status = error.code === 'GENERATION_FAILED' ? 'failed' : 'uncertain';
      // A failure card explicitly stating that points were refunded is safe
      // to retry.  Only an absent/ambiguous card remains “uncertain” and is
      // blocked by resume safety.
      record.points_status = /自动退还|点数将自动退还/.test(error.message) ? "pending" : "uncertain";
      record.failure_reason = error.message;
      await this.persist();
      throw error;
    }
    const after = await this.points.waitForCharge(frame, before, record.expected_cost, {
      timeoutMs: this.mode.pointsTimeoutMs,
      intervalMs: this.mode.pointsPollIntervalMs,
    });
    finishInputPointsCheck(record, after);
    await this.persist();
    if (record.points_status !== "passed") throw new Error(record.points_failure_reason);

    record.application_status = "applying";
    await this.persist();
    await result.control.click();
    const apply = frame.locator(this.config.selectors.aiApplySelector).filter({ hasText: /^应用$/ }).first();
    await apply.waitFor({ state: "visible", timeout: this.config.timeouts.blockRenderMs });
    const baseline = await committedAiSnapshot(this.editor.page.frames(), { ownedBlankPage: true });
    record.application_baseline_ids = baseline.ids;
    record.application_baseline_count = baseline.count;
    await this.persist();
    const responsePromise = this.editor.page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes("/phoenix2/composite/editor/v1/newEditor/savePage"), { timeout: this.config.timeouts.blockRenderMs }).catch(() => null);
    await apply.click();
    const committed = await waitForAiCommit(() => committedAiSnapshot(this.editor.page.frames(), { ownedBlankPage: true }), baseline,
      { timeoutMs: this.config.timeouts.blockRenderMs });
    record.committed_block_id = committed.addedId;
    record.application_commit_confirmed = true;
    await this.persist();
    const response = await responsePromise;
    if (response && !response.ok()) throw new Error(`${record.input_mode_label} 应用接口返回 HTTP ${response.status()}`);
    const close = frame.locator(".close-icon-container").first();
    if (await visible(close)) await close.click();
    await this.editor.page.waitForTimeout(this.config.ai.applyIntervalMs);
    const count = await waitFor(() => this.recordIdentityCount(record), this.config.timeouts.blockRenderMs, `${record.input_mode_label} 编辑器区块`);
    record.application_status = "applied";
    record.applied_at = new Date().toISOString();
    record.editor_verified = count === 1;
    await this.persist();
    if (!record.editor_verified) throw new Error(`${record.input_mode_label} 编辑器内匹配到 ${count} 个区块，预期 1 个`);
    // The top-right save response can be dropped while the 3.0 canvas is
    // still committing an AI block. Retry the same idempotent save once after
    // a short stabilization window before treating the input mode as failed.
    try {
      await this.editor.savePage();
    } catch (firstError) {
      await this.editor.page.waitForTimeout(1500);
      try {
        await this.editor.savePage();
      } catch {
        throw firstError;
      }
    }
    record.checkpoint_saved = true;
    await this.persist();
    await this.editor.openCustomPage(this.state.page.name);
    if (await this.recordIdentityCount(record) !== 1) throw new Error(`${record.input_mode_label} 保存后区块未持久化`);
    record.reopen_verified = true; await this.persist();
  }

  async verifyPreview(records = this.state.records) {
    const before = new Set(this.editor.page.context().pages());
    const popupPromise = this.editor.page.context().waitForEvent("page", { timeout: 10_000 }).catch(() => null);
    await this.editor.page.locator(".clickToPreview").first().click();
    const preview = await popupPromise ?? this.editor.page.context().pages().find((page) => !before.has(page));
    if (!preview) throw new Error("点击预览后没有打开页面");
    try {
      const evidence = await waitFor(async () => {
        const value = await renderEvidence(preview);
        const counts = await Promise.all(records.map(record => this.recordIdentityCount(record, preview)));
        return value.passed && counts.every(count => count === 1) ? value : null;
      }, this.config.timeouts.blockRenderMs, "三种输入方式预览区块", 500);
      this.state.page.preview_verified = records.length === this.state.records.length;
      this.state.page.preview_evidence = evidence;
      for (const record of records) record.preview_verified = true;
      await this.persist();
    } finally { await preview.close().catch(() => {}); }
  }

  async verifyPublished(records = this.state.records) {
    const publicPage = await this.editor.page.context().newPage();
    try {
      await publicPage.waitForTimeout(this.config.ai.publishInitialWaitMs);
      const evidence = await waitFor(async () => {
        await publicPage.goto(this.state.page.publicUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
        const value = await renderEvidence(publicPage);
        const counts = await Promise.all(records.map(record => this.recordIdentityCount(record, publicPage)));
        return value.passed && counts.every(count => count === 1) ? value : null;
      }, this.config.ai.publishTimeoutMs, "三种输入方式公开页区块", this.config.ai.publishPollIntervalMs);
      this.state.page.published_verified = records.length === this.state.records.length;
      this.state.page.public_evidence = evidence;
      for (const record of records) record.published_verified = true;
      await this.persist();
    } finally { await publicPage.close().catch(() => {}); }
  }

  async run({ resume = false } = {}) {
    try {
      await this.initialize({ resume });
      for (const record of this.state.records) {
        if (record.application_status === "applied") continue;
        if (record.generation_status !== "pending" || record.points_status !== "pending" || record.input_status !== "pending") throw new Error(`${record.input_mode_label} 上次操作状态不确定，拒绝重复生成或扣点`);
        try { await this.runRecord(record); }
        catch (error) {
          record.failure_reason = error.message; await this.persist();
          const notSubmitted = record.generation_status === 'pending' && record.application_status === 'pending' && record.points_status === 'pending';
          const knownChargeFailure = record.generation_status === 'succeeded' && record.application_status === 'pending' && record.points_status === 'failed';
          if (isGlobalSafetyFailure(error.message) || !notSubmitted && !knownChargeFailure) throw error;
          await this.base.closeAiResult();
        }
      }
      const failed = this.state.records.filter(record => record.application_status !== 'applied');
      if (failed.length) {
        const applied = this.state.records.filter(record => record.application_status === 'applied' && record.editor_verified);
        if (applied.length) {
          await this.editor.savePage(); this.state.page.saved = true; await this.persist();
          await this.verifyPreview(applied);
          if (!['accepted', 'running'].includes(this.state.page.publish_status)) {
            this.state.page.publish_status = 'running'; await this.persist();
            await this.editor.publishSite(); this.state.page.publish_status = 'accepted'; await this.persist();
          }
          await this.verifyPublished(applied);
        }
        throw new Error(`三输入方式部分失败：${failed.map(record => `${record.input_mode_label}：${record.failure_reason}`).join('；')}`);
      }
      const headings = this.state.records.map((record) => record.heading);
      const counts = await waitFor(async () => {
        const values = {};
        for (const record of this.state.records) values[record.heading] = await this.recordIdentityCount(record);
        return allOnce(values, headings) ? values : null;
      }, this.config.timeouts.blockRenderMs, "三种输入方式编辑器区块", 300);
      this.state.page.editor_verified = allOnce(counts, headings);
      await this.persist();
      if (!this.state.page.editor_verified) throw new Error("编辑器未展示全部三种输入方式区块，或存在重复区块");
      if (!this.state.page.saved) {
        try { await this.editor.savePage(); }
        catch (error) {
          await this.editor.openCustomPage(this.state.page.name);
          const persisted = {}; for (const record of this.state.records) persisted[record.heading] = await this.recordIdentityCount(record);
          if (!allOnce(persisted, headings)) throw error;
          this.state.page.save_warning = "顶部保存未返回成功信号；重进编辑器后确认三个区块已持久化";
        }
        this.state.page.saved = true;
        await this.persist();
      }
      if (!this.state.page.preview_verified) await this.verifyPreview();
      if (!this.state.page.published_verified) {
        if (this.state.page.publish_status === "running") throw new Error("上次发布请求状态不确定；请人工检查后恢复");
        if (this.state.page.publish_status !== "accepted") { this.state.page.publish_status = "running"; await this.persist(); await this.editor.publishSite(); this.state.page.publish_status = "accepted"; await this.persist(); }
        await this.verifyPublished();
      }
      this.state.page.failure_reason = "";
      await this.persist();
      return this.state;
    } catch (error) {
      if (this.state) { this.state.page.failure_reason = error.message; await this.persist(); }
      throw error;
    }
  }

  async cleanup() {
    const state = await readInputModeJson(this.paths.state);
    if (!state) throw new Error(`运行 ${this.runId} 没有输入方式专项状态`);
    assertInputModeState(state, this.config, this.runId);
    this.state = state;
    if (!state.page.name.endsWith(this.runId)) throw new Error("测试页面名称缺少运行 ID，拒绝删除");
    if (state.page.cleanup_status === "completed") return state;
    if (!(await this.editor.customPageExists(state.page.name))) throw new Error("测试页面不存在，无法确认清理目标");
    await this.editor.openCustomPage(state.page.name);
    const applied = state.records.filter((record) => record.application_status === "applied");
    for (const record of applied) { const matches = await this.editor.findAiBlockWrappers({ marker: record.heading }); if (matches.length !== 1) throw new Error(`${record.input_mode_label} 区块匹配数量=${matches.length}，拒绝清理`); }
    for (const record of applied) { await this.editor.deleteAiBlock({ marker: record.heading, apply: true }); const remaining = await this.editor.findAiBlockWrappers({ marker: record.heading }); if (remaining.length) throw new Error(`${record.input_mode_label} 区块删除后仍可见`); }
    if (applied.length) await this.editor.savePage();
    const deleted = await this.editor.deleteCustomPage(state.page.name, { apply: true });
    if (!deleted.applied || await this.editor.customPageExists(state.page.name)) throw new Error("页面删除后仍在页面列表");
    await this.editor.publishSite();
    state.page.cleanup_status = "completed";
    state.page.cleaned_at = new Date().toISOString();
    await this.persist();
    return state;
  }
}
