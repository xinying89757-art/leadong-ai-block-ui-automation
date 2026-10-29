import { AiPagedAutomation } from "./ai-paged-runner.mjs";
import { AiDialogPointsReader } from "./ai-points.mjs";
import { parseGenerationHistoryRecord } from "./ai-history-state.mjs";
import { selectNewCompositeHistoryRecord } from "./ai-combo-prompt.mjs";
import path from "node:path";

function exactButton(scope, selector, text) {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return scope.locator(selector).filter({ hasText: new RegExp(`^\\s*${escaped}\\s*$`) });
}

async function isVisible(locator) { return await locator.isVisible().catch(() => false); }

async function firstVisible(locators) {
  for (const locator of locators) {
    if (await locator.isVisible().catch(() => false)) return locator;
  }
  return null;
}

export function compositeSelectionValid(evidence, expectedDynamicTypes) {
  if (!evidence || evidence.static_layout !== "静态图文" || !evidence.static_layout_selected_before_combo ||
      evidence.combination_enabled !== true || evidence.max_dynamic_types !== 3) return false;
  const actual = evidence.selected_dynamic_types;
  const norm = value => String(value ?? "").replace(/\s+/g, "");
  const actualNorm = Array.isArray(actual) ? actual.map(norm) : [];
  return Array.isArray(actual) && actual.length === expectedDynamicTypes.length &&
    expectedDynamicTypes.every(type => actualNorm.includes(norm(type))) && new Set(actualNorm).size === actualNorm.length;
}

export function classifyCompositeLiveGeneration({ applyModuleVisible, applyModuleEnabled, text = "" }) {
  if (applyModuleVisible && applyModuleEnabled) return "succeeded";
  if (/正在生成整体预览|AI正在生成|正在生成区块|生成中/.test(String(text))) return "running";
  if (/组合操作失败|AI.{0,8}生成失败|生成失败，点数将自动退还/.test(String(text))) return "failed";
  return "waiting";
}

export function compositePromptOnlyView({ submitted, dialogVisible, promptVisible, hasProgress, elapsedMs, graceMs = 10000 }) {
  return submitted === true && dialogVisible === true && promptVisible === true && hasProgress !== true &&
    Number.isFinite(elapsedMs) && elapsedMs >= graceMs;
}

export function canRetryCompositeGeneration(error, attemptNumber, maxAttempts) {
  return error?.code === "GENERATION_FAILED" && error.explicitPlatformFailure === true &&
    Number.isInteger(attemptNumber) && Number.isInteger(maxAttempts) && attemptNumber < maxAttempts;
}

export function canContinueCompositeHistory(record, maxContinuations = 1) {
  const used = Array.isArray(record?.continuation_attempts) ? record.continuation_attempts.length : 0;
  return Number.isInteger(maxContinuations) && maxContinuations >= 0 && used < maxContinuations;
}

export function compositeHistoryRecordMatches(parsed, record, mode, expectedPoints) {
  const normalize = value => String(value ?? "").replace(/\s+/g, " ").trim();
  const expectedPrompt = normalize(record?.polished_prompt || record?.generation_prompt);
  return Boolean(parsed && record && expectedPrompt && parsed.status === "completed" &&
    String(parsed.block_type ?? "").includes("组合区块") && parsed.mode === mode && parsed.points === expectedPoints &&
    parsed.timestamp === record.combo_history_record?.timestamp && normalize(parsed.prompt).includes(expectedPrompt));
}

export function prepareCompositeGenerationRetry(record, error, now = new Date()) {
  const attemptNumber = Number(record.generation_attempt_number || 1);
  record.generation_attempts ??= [];
  const current = [...record.generation_attempts].reverse().find(item => item.attempt === attemptNumber);
  const failure = {
    attempt: attemptNumber,
    status: "failed",
    failure_reason: error.message,
    explicit_platform_failure: true,
    finished_at: now.toISOString(),
    generation_record_id: record.generation_record_id || "",
  };
  if (current) Object.assign(current, failure);
  else record.generation_attempts.push(failure);

  record.generation_attempt_number = attemptNumber + 1;
  record.generation_status = "pending";
  record.apply_status = "pending";
  record.failure_reason = "";
  record.generation_prompt = "";
  record.generation_record_id = "";
  record.generation_submitted_at = "";
  record.generation_submit_confirmed = false;
  record.generation_submission = null;
  record.last_record_status = "";
  record.generation_wait = null;
  record.application_attempted = false;
  record.application_acknowledged = false;
  record.application_commit_confirmed = false;
  record.committed_block_id = "";
  record.recovery_required = false;
  record.started_at = "";
  record.generated_at = "";
  record.applied_at = "";
  return attemptNumber + 1;
}

export class AiCompositeRegressionAutomation extends AiPagedAutomation {
  constructor(...args) { super(...args); this.comboPoints = new AiDialogPointsReader(this.config); }

  async historyRecord(frame, record) {
    const history = frame.locator(this.config.selectors.aiHistoryTriggerSelector).first();
    const cards = frame.locator(this.config.selectors.aiHistoryCardSelector);
    if (!await cards.first().isVisible().catch(() => false) && await history.isVisible().catch(() => false)) await history.click();
    const mode = this.config.ai.generationModes.find(item => item.label === record.generation_mode);
    if (!mode) throw new Error(`复合区块历史记录没有配置模式：${record.generation_mode}`);
    const deadline = Date.now() + this.config.timeouts.blockRenderMs;
    while (Date.now() < deadline) {
      const matches = [];
      for (let index = 0; index < await cards.count().catch(() => 0); index += 1) {
        const card = cards.nth(index); const text = await card.innerText().catch(() => "");
        let parsed = null;
        try { parsed = parseGenerationHistoryRecord(text,
          await card.getAttribute("data-id").catch(() => "") || await card.getAttribute("data-record-id").catch(() => "")); } catch { /* Ignore incomplete cards. */ }
        if (!compositeHistoryRecordMatches(parsed, record, mode.key, mode.expectedCost)) continue;
        const insert = await firstVisible([
          card.locator(this.config.selectors.aiHistoryInsertSelector).first(),
          card.getByRole("button", { name: /插入/ }).first(),
          card.getByText(/插入/).first(),
        ]);
        if (insert) matches.push({ card, text, insert, id: parsed.id || "" });
      }
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) throw new Error("复合区块历史记录时间戳匹配重复，拒绝插入歧义记录");
      await this.editor.page.waitForTimeout(250);
    }
    throw new Error("未找到与本轮时间戳/提示词/模式/点数匹配的组合区块历史记录");
  }

  async submitBlockGeneration(frame, generate, prompt, record) {
    record.combo_points_before = await this.comboPoints.read(frame);
    record.combo_history_before = Number((await frame.locator(this.config.selectors.aiHistoryTriggerSelector).innerText()).match(/\d+\s*$/)?.[0]?.trim());
    if (!Number.isInteger(record.combo_history_before)) throw new Error("无法读取生成前历史记录数");
    return super.submitBlockGeneration(frame, generate, prompt, record);
  }

  async inspectCompositeHistoryRecord(frame, _prompt, _historyCountBefore, record) {
    const trigger = frame.locator(this.config.selectors.aiHistoryTriggerSelector).first();
    const triggerText = await trigger.innerText().catch(() => "");
    const currentCount = Number(triggerText.match(/(\d+)\s*$/)?.[1]);
    if (!Number.isInteger(currentCount)) return false;
    record.combo_history_after = currentCount;
    if (currentCount <= record.combo_history_before) return false;
    const cards = frame.locator(this.config.selectors.aiHistoryCardSelector);
    const parsedCards = [];
    for (let index = 0; index < await cards.count().catch(() => 0); index += 1) {
      const card = cards.nth(index);
      const text = (await card.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
      try {
        const parsed = parseGenerationHistoryRecord(text,
          await card.getAttribute("data-id").catch(() => "") || await card.getAttribute("data-record-id").catch(() => ""));
        parsedCards.push({ parsed, card });
      } catch { /* Running cards may not have complete badges yet. */ }
    }
    const mode = this.config.ai.generationModes.find(item => item.label === record.generation_mode);
    if (!mode) throw new Error(`组合区块生成模式无点数配置：${record.generation_mode}`);
    const match = selectNewCompositeHistoryRecord(parsedCards.map(item => item.parsed), {
      baselineCount: record.combo_history_before,
      currentCount,
      submittedAt: record.generation_submitted_at,
      polishedPrompt: record.polished_prompt,
      mode: mode.key,
      expectedPoints: mode.expectedCost,
    });
    if (!match) return false;
    const entry = parsedCards.find(({ parsed }) => parsed.epoch_ms === match.epoch_ms && parsed.prompt === match.prompt &&
      parsed.status === match.status && parsed.points === match.points);
    if (!entry) throw new Error("新增组合区块历史记录无法绑定到唯一卡片");
    record.combo_history_record = match;
    record.generation_record_id = match.id || "";
    record.last_record_status = match.status;
    if (match.status === "failed") {
      const error = new Error("AI 复合区块生成失败：平台明确返回组合操作失败；可安全重新生成");
      error.code = "GENERATION_FAILED";
      error.explicitPlatformFailure = true;
      error.record_id = match.id || "";
      throw error;
    }
    if (match.status !== "completed") return false;
    if (match.points !== mode.expectedCost || match.mode !== mode.key) {
      throw new Error(`新组合记录模式/点数不符：${match.mode}/${match.points}`);
    }
    const insert = await firstVisible([
      entry.card.getByText(/插入|应用模块/),
      entry.card.locator("button").filter({ hasText: /插入|应用模块/ }),
    ]);
    if (!insert || !await insert.isEnabled().catch(() => false)) return false;
    record.combo_actual_mode = match.mode;
    return { mode: "history", frame, control: insert, recordId: match.id || "" };
  }

  async waitForGeneration(frame, prompt, historyCountBefore, timeoutMs, record) {
    const mode = this.config.ai.generationModes.find(item => item.label === this.config.ai.compositeRegression.generationMode);
    if (!mode) throw new Error("组合区块生成模式未配置点数规则");
    const waitStarted = Date.now();
    const deadline = waitStarted + (timeoutMs ?? this.config.ai.compositeRegression.generationTimeoutMs);
    let lastPersist = 0;
    let current = frame;
    let runningObserved = record.generation_wait?.running_observed === true;
    while (Date.now() < deadline) {
      // The common AI block flow advances as soon as “应用模块” is enabled.
      // The composite preview may be mounted in a different iframe than the
      // first matching 4.0 iframe, so inspect the active view and then every
      // frame. Do not navigate to generation history while this request runs.
      const frames = [...new Set([frame, ...this.editor.page.frames()])];
      let applyModule = null;
      const frameEvidence = [];
      for (const candidateFrame of frames) {
        applyModule = await this.findApplyModule(candidateFrame);
        const dialogVisible = await isVisible(candidateFrame.locator(this.config.selectors.aiDialogSelector));
        const promptVisible = await isVisible(candidateFrame.locator(this.config.selectors.aiPromptSelector).first());
        const exactTextCount = await candidateFrame.getByText("应用模块", { exact: true }).count().catch(() => 0);
        const buttonLabels = await candidateFrame.locator("button, [role='button']").evaluateAll(elements =>
          elements.map(element => (element.innerText || element.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim())
            .filter(label => /应用模块|返回修改|重新生成/.test(label)).slice(0, 8)).catch(() => []);
        frameEvidence.push({
          url: candidateFrame.url(), dialog_visible: dialogVisible, prompt_visible: promptVisible,
          apply_module_text_count: exactTextCount, apply_module_ready: Boolean(applyModule), button_labels: buttonLabels,
        });
        if (applyModule) {
          current = candidateFrame;
          break;
        }
      }
      if (!applyModule) {
        let activeDialogFrame = null;
        for (const candidateFrame of frames) {
          if (await isVisible(candidateFrame.locator(this.config.selectors.aiDialogSelector))) {
            activeDialogFrame = candidateFrame;
            break;
          }
        }
        if (activeDialogFrame) current = activeDialogFrame;
      }
      const text = await current.locator("body").innerText().catch(() => "");
      const hasProgress = /正在生成整体预览|AI正在生成|正在生成区块|生成中/.test(text);
      let status = classifyCompositeLiveGeneration({
        applyModuleVisible: Boolean(applyModule),
        applyModuleEnabled: Boolean(applyModule),
        text,
      });
      if (status === "running") runningObserved = true;
      if (status === "failed" && !runningObserved) {
        // On resume the dialog can retain the previous attempt's failure text.
        // Never retry from that stale text unless this same submitted attempt
        // was first observed running on the current page.
        status = "waiting";
        record.stale_failure_text_ignored_at = new Date().toISOString();
      }
      record.generation_wait = {
        started_at: new Date(waitStarted).toISOString(), elapsed_ms: Date.now() - waitStarted,
        refresh_count: 0, last_checked_at: new Date().toISOString(), last_status: status,
        observation_source: "current-generation-page", running_observed: runningObserved,
        frame_evidence: frameEvidence,
      };
      if (status === "waiting" && Date.now() - waitStarted > 10_000 && !record.generation_wait.screenshot) {
        record.generation_wait.screenshot = path.join(path.dirname(this.config.paths.aiStateFile), "composite-current-generation-wait.png");
        await this.editor.page.screenshot({ path: record.generation_wait.screenshot, fullPage: false }).catch(() => {});
      }
      if (status === "failed") {
        const error = new Error("复合区块生成页显示平台失败");
        error.code = "GENERATION_FAILED"; error.explicitPlatformFailure = true;
        throw error;
      }
      if (status === "succeeded") {
        record.generation_result_source = "current-generation-page";
        record.combo_points_status = "pending";
        const badge = await current.locator(this.config.selectors.aiHistoryTriggerSelector).innerText().catch(() => "");
        record.combo_history_after = Number(badge.match(/\d+\s*$/)?.[0]?.trim());
        record.combo_history_badge_delta = Number.isInteger(record.combo_history_after) && Number.isInteger(record.combo_history_before)
          ? record.combo_history_after - record.combo_history_before : null;
        await this.persist();
        return { mode: "module", frame: current, control: applyModule };
      }
      const promptOnlyFrame = frameEvidence.find(item => item.dialog_visible && item.prompt_visible);
      if (promptOnlyFrame && compositePromptOnlyView({
        submitted: record.generation_submit_confirmed === true,
        dialogVisible: true,
        promptVisible: true,
        hasProgress,
        elapsedMs: Date.now() - waitStarted,
      })) {
        record.generation_status = "uncertain";
        record.generation_wait.last_status = "result-view-unavailable";
        record.generation_wait.failure_reason = "已提交生成，但当前弹窗回到了提示词页；按流程不切换到生成记录，停止等待以避免重复生成";
        record.generation_wait.screenshot = path.join(path.dirname(this.config.paths.aiStateFile), "composite-result-view-unavailable.png");
        await this.editor.page.screenshot({ path: record.generation_wait.screenshot, fullPage: false }).catch(() => {});
        await this.persist();
        const error = new Error(record.generation_wait.failure_reason);
        error.code = "GENERATION_UNCONFIRMED";
        throw error;
      }
      if (Date.now() - lastPersist >= 5_000) { await this.persist(); lastPersist = Date.now(); }
      await this.editor.page.waitForTimeout(Math.min(750, Math.max(0, deadline - Date.now())));
    }
    record.generation_status = "uncertain";
    record.generation_wait = {
      started_at: new Date(waitStarted).toISOString(), elapsed_ms: Date.now() - waitStarted,
      refresh_count: 0, last_checked_at: new Date().toISOString(), last_status: runningObserved ? "running" : "waiting",
      observation_source: "current-generation-page", running_observed: runningObserved,
    };
    record.generation_wait.screenshot = path.join(path.dirname(this.config.paths.aiStateFile), "generation-wait-timeout.png");
    await this.editor.page.screenshot({ path: record.generation_wait.screenshot, fullPage: false }).catch(() => {});
    await this.persist();
    const error = new Error(`${runningObserved ? "复合区块仍在生成" : "复合区块当前页状态未确认"}，等待超时；已留在当前生成页，未查看生成记录或重复提交`);
    error.code = "GENERATION_UNCONFIRMED";
    throw error;
  }

  async afterModuleClick({ frame, record }) {
    const mode = this.config.ai.generationModes.find(item => item.label === record.generation_mode);
    if (!mode || !Number.isInteger(record.combo_points_before)) {
      record.combo_points_status = "unconfirmed";
      record.combo_points_failure_reason = "缺少生成前点数或模式成本配置";
      await this.persist();
      return;
    }
    // Advance the shared UI flow immediately when “应用模块” becomes ready.
    // Balance polling happens after that click so it cannot hold the user on
    // the generated preview page.
    record.combo_points_status = "unconfirmed";
    await this.persist();
    try {
      record.combo_points_after = await this.comboPoints.waitForCharge(frame, record.combo_points_before, mode.expectedCost, {
        timeoutMs: this.config.ai.compositeRegression.pointsWaitTimeoutMs ?? 30_000,
        intervalMs: this.config.ai.compositeRegression.pointsPollIntervalMs ?? 3_000,
      });
      record.combo_balance_delta_observed = record.combo_points_before - record.combo_points_after;
      record.combo_points_charged = record.combo_balance_delta_observed;
      record.combo_points_status = record.combo_points_charged === mode.expectedCost ? "passed" : "failed";
      record.combo_points_failure_reason = record.combo_points_status === "passed" ? "" : `预期扣除 ${mode.expectedCost} 点，实际扣除 ${record.combo_points_charged} 点`;
    } catch (error) {
      record.combo_points_status = "unconfirmed";
      record.combo_points_failure_reason = error.message;
    }
    await this.persist();
  }

  canResumeSubmittedGeneration(record) {
    return record?.type === this.config.ai.compositeRegression.type &&
      (["running", "uncertain", "succeeded"].includes(record.generation_status) ||
        // A test-side wait/refresh error (e.g. an editor overlay blocking a
        // click) is not a platform result; the submitted row may be complete.
        (record.generation_status === "failed" && record.generation_attempts?.at(-1)?.explicit_platform_failure !== true)) &&
      record.generation_submit_confirmed === true &&
      record.apply_status !== "applied" && record.application_attempted !== true &&
      !record.application_commit_confirmed && !record.committed_block_id;
  }

  async resumeSubmittedGeneration(record) {
    // Resume by reopening the same generation view and observing its live
    // result. Deliberately do not navigate to the generation-history panel.
    if (!record.generation_submit_confirmed) throw new Error("复合区块没有提交确认，拒绝恢复到当前生成页");
    this.resumeHistoryResult = null;
    for (const currentFrame of this.editor.page.frames()) {
      if (await isVisible(currentFrame.locator(this.config.selectors.aiDialogSelector))) return currentFrame;
    }
    return this.openAiDialog();
  }

  async generateAndApply(record) {
    if (record.generation_status === "uncertain" && record.generation_submit_confirmed === true &&
        record.apply_status !== "applied" && record.application_attempted !== true && !record.committed_block_id) {
      await this.resumeSubmittedGeneration(record);
      if (this.resumeHistoryResult && record.combo_history_record?.status === "completed") {
        record.generation_status = "succeeded";
        await this.persist();
        return this.generateAndApply(record);
      }
    }
    if (record.generation_status === "succeeded" && record.combo_history_record?.status === "completed" &&
        record.apply_status !== "applied" && record.application_attempted !== true && !record.committed_block_id) {
      const attempt = record.generation_attempts?.find(item => item.attempt === Number(record.generation_attempt_number || 1));
      await this.recoverStandardGeneratedResult(record);
      if (attempt) Object.assign(attempt, { status: "succeeded", failure_reason: "", explicit_platform_failure: false,
        finished_at: new Date().toISOString(), generation_record_id: record.generation_record_id || "",
        application_source: "history" });
      record.final_generation_attempt = Number(record.generation_attempt_number || 1);
      record.generation_status = "succeeded";
      await this.persist();
      return;
    }
    const maxAttempts = this.config.ai.compositeRegression.maxGenerationAttempts;
    record.generation_attempt_number = Number(record.generation_attempt_number || 1);
    record.generation_attempts ??= [];
    while (record.generation_attempt_number <= maxAttempts) {
      const attemptNumber = record.generation_attempt_number;
      const existing = record.generation_attempts.find(item => item.attempt === attemptNumber);
      const resumingSubmitted = this.canResumeSubmittedGeneration(record);
      const attempt = resumingSubmitted && existing ? existing : {
        attempt: attemptNumber,
        generation_mode: this.config.ai.compositeRegression.generationMode,
        started_at: new Date().toISOString(),
        prompt_marker: attemptNumber > 1 ? `attempt=${attemptNumber}` : "",
      };
      attempt.status = "running";
      if (resumingSubmitted) attempt.last_resume_at = new Date().toISOString();
      else if (!existing) record.generation_attempts.push(attempt);
      else Object.assign(existing, attempt);
      await this.persist();
      try {
        await super.generateAndApply(record);
        Object.assign(attempt, {
          status: "succeeded",
          failure_reason: "",
          explicit_platform_failure: false,
          finished_at: new Date().toISOString(),
          generation_record_id: record.generation_record_id || "",
          application_source: record.application_source || "current-result",
        });
        record.final_generation_attempt = attemptNumber;
        await this.persist();
        return;
      } catch (error) {
        const canRetry = canRetryCompositeGeneration(error, attemptNumber, maxAttempts);
        if (!canRetry) {
          attempt.status = error?.code === "GENERATION_UNCONFIRMED" ? "uncertain" : "failed";
          attempt.failure_reason = error.message;
          attempt.explicit_platform_failure = error?.explicitPlatformFailure === true;
          attempt.finished_at = new Date().toISOString();
          attempt.generation_record_id = error.record_id || record.generation_record_id || "";
          record.generation_attempts[record.generation_attempts.findIndex(item => item.attempt === attemptNumber)] = attempt;
          if (error?.code === "GENERATION_FAILED" && error.explicitPlatformFailure === true) {
            record.generation_status = "failed";
            record.last_record_status = "failed";
          }
          await this.persist();
          throw error;
        }
        if (error.record_id) record.generation_record_id = error.record_id;
        prepareCompositeGenerationRetry(record, error);
        await this.persist();
      }
    }
    throw new Error(`复合区块已达到最多 ${maxAttempts} 次生成尝试，保留现场供后续恢复`);
  }

  async selectType(frame, type) {
    const mode = this.config.ai.compositeRegression;
    const record = this.state.types.find(item => item.type === type);
    if (type !== mode.type || !record) throw new Error(`复合区块专项遇到意外类型：${type}`);

    const trigger = frame.locator(this.config.selectors.aiCategoryTriggerSelector);
    let options = frame.locator("button.block-category-option");
    if (!await isVisible(options.first())) {
      await trigger.click();
      await options.first().waitFor({ state: "visible", timeout: this.config.timeouts.actionMs }).catch(() => {});
    }
    if (!await isVisible(options.first())) throw new Error("未打开 AI 区块类型菜单，无法选择复合区块");

    const staticOption = exactButton(frame, "button.block-category-option", mode.staticType);
    if (await staticOption.count() !== 1 || !await isVisible(staticOption)) throw new Error(`复合区块菜单中未唯一找到静态布局“${mode.staticType}”`);
    let staticPressed = await staticOption.getAttribute("aria-pressed").catch(() => null) === "true";
    if (!staticPressed) {
      await staticOption.click();
      await this.editor.page.waitForTimeout(250);
      if (!await isVisible(options.first())) await trigger.click();
      if (!await isVisible(options.first())) throw new Error("选择静态图文布局后无法重新打开动态区块菜单");
      staticPressed = await exactButton(frame, "button.block-category-option", mode.staticType).getAttribute("aria-pressed").catch(() => null) === "true";
    }
    if (!staticPressed) throw new Error("静态图文未处于选中状态，拒绝启动复合区块生成");

    const dynamicGroup = frame.locator('.block-category-group[aria-label="动态区块"]');
    if (await dynamicGroup.count() !== 1 || !await isVisible(dynamicGroup)) throw new Error("类型菜单中未唯一找到动态区块分组");
    const combination = dynamicGroup.locator("button.block-category-combination");
    if (await combination.count() !== 1) throw new Error("未找到唯一的“组合区块”开关");
    if (await combination.getAttribute("aria-pressed") !== "true") await combination.click();
    if (await combination.getAttribute("aria-pressed") !== "true") throw new Error("“组合区块”开关未能启用");
    const title = await combination.getAttribute("title").catch(() => "");
    const maxMatch = title.match(/最多选择\s*(\d+)\s*种动态类型/);
    const maxDynamicTypes = maxMatch ? Number(maxMatch[1]) : 0;
    if (maxDynamicTypes !== 3) throw new Error(`无法确认组合区块最多选择 3 种动态类型：${title || "缺少限制说明"}`);

    const dynamicOptions = dynamicGroup.locator("button.block-category-option");
    const optionCount = await dynamicOptions.count();
    const observed = [];
    for (let index = 0; index < optionCount; index += 1) {
      const option = dynamicOptions.nth(index);
      const name = (await option.innerText().catch(() => "")).trim();
      if (await option.getAttribute("aria-pressed").catch(() => null) === "true") observed.push(name);
      const shouldSelect = mode.dynamicTypes.some(type => type.replace(/\s+/g, "") === name.replace(/\s+/g, ""));
      const isSelected = await option.getAttribute("aria-pressed").catch(() => null) === "true";
      if (shouldSelect !== isSelected) {
        await option.click();
        await this.editor.page.waitForTimeout(150);
      }
    }
    const selectedDynamicTypes = [];
    for (let index = 0; index < optionCount; index += 1) {
      const option = dynamicOptions.nth(index);
      if (await option.getAttribute("aria-pressed").catch(() => null) === "true") selectedDynamicTypes.push((await option.innerText().catch(() => "")).trim());
    }
    record.composite_selection = {
      static_layout: mode.staticType,
      static_layout_selected_before_combo: staticPressed,
      combination_enabled: await combination.getAttribute("aria-pressed") === "true",
      max_dynamic_types: maxDynamicTypes,
      requested_dynamic_types: [...mode.dynamicTypes],
      selected_dynamic_types: selectedDynamicTypes,
      previously_selected_dynamic_types: observed,
      checked_at: new Date().toISOString(),
    };
    record.type_menu_evidence = { expected: "组合区块", match_count: 1, status: "matched", text: "组合区块", observed_at: record.composite_selection.checked_at };
    await this.persist();
    if (!compositeSelectionValid(record.composite_selection, mode.dynamicTypes)) {
      throw new Error(`复合区块所选类型不符合预期：${selectedDynamicTypes.join("、") || "未选中"}`);
    }
  }

  async verifyEditorType(type) {
    const committed = await super.verifyEditorType(type);
    const record = this.state.types.find(item => item.type === type);
    const id = record?.committed_block_id || "";
    const evidence = { block_id: id, unique_visible_block: false, text_length: 0, visible_image_count: 0, checked_at: new Date().toISOString() };
    if (committed && /^[a-zA-Z0-9_-]+$/.test(id)) {
      for (const frame of this.editor.canvasContexts()) {
        const block = frame.locator(`#${id}`);
        if (await block.count().catch(() => 0) !== 1 || !await block.isVisible().catch(() => false)) continue;
        evidence.unique_visible_block = true;
        evidence.text_length = (await block.innerText().catch(() => "")).trim().length;
        evidence.visible_image_count = await block.locator("img:visible").count().catch(() => 0);
        break;
      }
    }
    evidence.passed = evidence.unique_visible_block && (evidence.text_length > 0 || evidence.visible_image_count > 0);
    record.composite_editor_evidence = evidence;
    await this.persist();
    return committed && evidence.passed && compositeSelectionValid(record.composite_selection, this.config.ai.compositeRegression.dynamicTypes);
  }

  async afterFinalApply({ record }) {
    const priorFailure = record.failure_reason;
    record.failure_reason = "";
    record.recovery_required = false;
    if (priorFailure) {
      record.previous_failures ??= [];
      record.previous_failures.push({ reason: priorFailure, recovered_at: new Date().toISOString() });
    }
    this.state.page.type_failures = (this.state.page.type_failures || []).filter(item => item.type !== record.type);
    this.state.page.failure_reason = "";
    await this.persist();
  }

  async runUnpublished({ resume = false } = {}) {
    const state = await this.run({ maxTypes: 1, resume, publish: false });
    const record = state.types[0];
    if (!state.page.saved || record.apply_status !== "applied" || !record.committed_block_id) throw new Error("组合区块未确认保存及应用，禁止后续验证");
    await this.editor.page.reload({ waitUntil: "domcontentloaded" });
    await this.editor.waitForCanvasReady();
    await this.editor.openCustomPage(state.page.name);
    if (!await this.verifyEditorType(record.type)) throw new Error("保存并重新打开后未找到本轮复合区块");
    record.combo_reopen_verified = true;
    const dynamicTypes = this.config.ai.compositeRegression.dynamicTypes;
    const evidence = { checked_types: [], matches: {} };
    for (const type of dynamicTypes) {
      const needle = type === "产品列表" ? /product|goods/i
        : type === "产品分类" ? /product.?categor|categor(y|ies)|classif/i
          : type === "文章列表" ? /article|news/i
            : type === "文章分类" ? /article.?categor|news.?categor|categor(y|ies)|classif/i : /video|gallery|download|faq/i;
      let found = 0;
      for (const frame of this.editor.canvasContexts()) {
        const block = frame.locator(`#${record.committed_block_id}`);
        found += await block.locator("*").evaluateAll((nodes, source) => {
          const pattern = new RegExp(source, "i");
          return nodes.filter(node => pattern.test(`${node.className || ""} ${node.getAttribute("data-type") || ""} ${node.getAttribute("data-component") || ""} ${node.getAttribute("data-module") || ""}`) &&
            node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden" && getComputedStyle(node).display !== "none").length;
        }, needle.source).catch(() => 0);
      }
      evidence.checked_types.push(type);
      evidence.matches[type] = { visible_dom_matches: found, selector_hint: needle.source };
      if (!found) throw new Error(`复合区块画布中未发现可见的 ${type} 类型特征 DOM`);
    }
    record.combo_subblock_dom = evidence;
    state.page.persisted_verified = true;
    state.combo_assertions_status = "PASS";
    state.combo_preview_status = state.page.preview_verified ? "passed" : "blocked-environment";
    state.combo_overall = state.combo_preview_status === "blocked-environment" ? "PASS (preview env-blocked)" : "PASS";
    state.page.publish_status = "not-applicable; no publishing performed";
    state.status = "passed";
    await this.persist();
    return state;
  }
}
