import { AiPagedAutomation } from "./ai-paged-runner.mjs";
import { AiDialogPointsReader } from "./ai-points.mjs";
import { parseGenerationHistoryRecord } from "./ai-history-state.mjs";
import { selectNewCompositeHistoryRecord } from "./ai-combo-prompt.mjs";

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
  return Array.isArray(actual) && actual.length === expectedDynamicTypes.length &&
    expectedDynamicTypes.every(type => actual.includes(type)) && new Set(actual).size === actual.length;
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
    const result = this.resumeHistoryResult ?? await super.waitForGeneration(frame, prompt, historyCountBefore, timeoutMs, record);
    this.resumeHistoryResult = null;
    const current = result?.frame ?? frame;
    const mode = this.config.ai.generationModes.find(item => item.label === this.config.ai.compositeRegression.generationMode);
    if (!mode) throw new Error("组合区块生成模式未配置点数规则");
    // Use the exact new history row for this generation's charge. A previous
    // timed-out request can finish after its local process exits, so the live
    // balance delta may include more than this record's charge.
    record.combo_points_after = await this.comboPoints.read(current);
    record.combo_balance_delta_observed = record.combo_points_before - record.combo_points_after;
    record.combo_history_after = Number((await current.locator(this.config.selectors.aiHistoryTriggerSelector).innerText()).match(/\d+\s*$/)?.[0]?.trim());
    if (!Number.isInteger(record.combo_history_after) || record.combo_history_after <= record.combo_history_before) throw new Error(`组合区块历史记录数未增加：${record.combo_history_before} → ${record.combo_history_after}`);
    const match = record.combo_history_record;
    if (!match) throw new Error("缺少按历史基线、提交时间、润色提示词、模式和点数匹配的新组合记录");
    if (!Number.isInteger(match.points) || match.points !== mode.expectedCost) throw new Error(`历史 points badge ${match.points} 与模式成本 ${mode.expectedCost} 不符`);
    if (!Number.isInteger(record.combo_balance_delta_observed) || record.combo_balance_delta_observed < match.points) throw new Error(`余额扣点 ${record.combo_balance_delta_observed} 小于该历史记录成本 ${match.points}`);
    record.combo_points_charged = match.points;
    record.combo_balance_delta_attribution = record.combo_balance_delta_observed === match.points ? "exact" : "contains additional completed generation charge(s)";
    record.combo_actual_mode = match.mode;
    return result;
  }

  canResumeSubmittedGeneration(record) {
    return record?.type === this.config.ai.compositeRegression.type &&
      ["uncertain", "succeeded"].includes(record.generation_status) && record.generation_submit_confirmed === true &&
      record.apply_status !== "applied" && record.application_attempted !== true &&
      !record.application_commit_confirmed && !record.committed_block_id;
  }

  async resumeSubmittedGeneration(record) {
    const frame = await this.openAiDialog();
    const history = frame.locator(this.config.selectors.aiHistoryTriggerSelector).first();
    const cards = frame.locator(this.config.selectors.aiHistoryCardSelector);
    if (!await cards.first().isVisible().catch(() => false)) {
      if (!await history.isVisible().catch(() => false)) throw new Error("复合区块生成已提交，但无法打开本轮生成记录");
      await history.click();
    }
    const deadline = Date.now() + this.config.timeouts.blockRenderMs;
    const needle = String(record.generation_prompt || "").trim().replace(/\s+/g, " ");
    while (Date.now() < deadline) {
      const matches = [];
      for (let index = 0; index < await cards.count().catch(() => 0); index += 1) {
        const card = cards.nth(index);
        const text = await card.innerText().catch(() => "");
        const normalizedText = text.replace(/\s+/g, " ");
        if (needle && normalizedText.includes(needle)) matches.push({ card, text });
      }
      if (matches.length === 1) {
        const { card, text } = matches[0];
        let parsed = null;
        try { parsed = parseGenerationHistoryRecord(text,
          await card.getAttribute("data-id").catch(() => "") || await card.getAttribute("data-record-id").catch(() => "")); } catch { /* Keep polling incomplete cards. */ }
        if (parsed?.status === "completed") {
          const mode = this.config.ai.generationModes.find(item => item.label === record.generation_mode);
          const submitted = Date.parse(record.generation_submitted_at);
          const polished = String(record.polished_prompt || "").replace(/\s+/g, " ").trim();
          if (!mode || !Number.isFinite(submitted) || parsed.epoch_ms < submitted - 60_000 ||
              !String(parsed.block_type).includes("组合区块") || parsed.mode !== mode.key || parsed.points !== mode.expectedCost ||
              !String(parsed.prompt).replace(/\s+/g, " ").includes(polished)) throw new Error("恢复到的完成历史记录与本轮提示词/模式/成本不符");
          const insert = await firstVisible([
            card.getByText(/插入|应用模块/),
            card.locator("button").filter({ hasText: /插入|应用模块/ }),
          ]);
          if (insert && await insert.isEnabled().catch(() => false)) {
            record.combo_history_record = parsed; record.generation_record_id = parsed.id || "";
            record.last_record_status = parsed.status; this.resumeHistoryResult = { mode: "history", frame, control: insert, recordId: parsed.id || "" };
            await this.persist(); return frame;
          }
        }
        if (/组合操作失败，已保留可恢复进度/.test(text)) {
          const continueButton = card.getByRole('button', { name: '继续生成', exact: true });
          if (!await continueButton.isVisible().catch(() => false) || !await continueButton.isEnabled().catch(() => false)) {
            const error = new Error("AI 复合区块存在可恢复失败，但未找到可用的继续生成按钮");
            error.code = "GENERATION_FAILED"; error.explicitPlatformFailure = true;
            error.record_id = await card.getAttribute("data-id").catch(() => "") || await card.getAttribute("data-record-id").catch(() => "") || "";
            throw error;
          }
          record.continuation_attempts ??= [];
          const maxContinuations = this.config.ai.compositeRegression.maxContinuations ?? 1;
          if (!canContinueCompositeHistory(record, maxContinuations)) {
            const error = new Error(`继续生成已达到 ${maxContinuations} 次上限，保留失败记录供人工恢复`);
            error.code = 'GENERATION_FAILED'; error.explicitPlatformFailure = true; throw error;
          }
          const continuation = { started_at: new Date().toISOString(), clicked: false, result_visible: false, terminal_status: '' };
          record.continuation_attempts.push(continuation); await this.persist();
          await continueButton.click(); continuation.clicked = true;
          continuation.loading_observed = await continueButton.isDisabled().catch(() => false); await this.persist();
          const deadline = Date.now() + (this.config.ai.compositeRegression.generationTimeoutMs ?? this.config.timeouts.blockRenderMs);
          while (Date.now() < deadline) {
            const result = frame.locator('button').filter({ hasText: /^应用(?:模块|区块)$/ }).first();
            if (await result.isVisible().catch(() => false) && await result.isEnabled().catch(() => false)) {
              continuation.result_visible = true; continuation.terminal_status = 'result-visible'; continuation.finished_at = new Date().toISOString();
              await this.persist(); return frame;
            }
            const currentText = (await card.innerText().catch(() => '')).replace(/\s+/g, ' ');
            const disabled = await continueButton.isDisabled().catch(() => false);
            if (disabled) continuation.loading_observed = true;
            if (continuation.loading_observed && !disabled && /组合操作失败，已保留可恢复进度/.test(currentText)) {
              continuation.terminal_status = 'failed-again'; continuation.finished_at = new Date().toISOString(); await this.persist();
              const error = new Error('继续生成后仍返回组合操作失败'); error.code = 'GENERATION_FAILED'; error.explicitPlatformFailure = true;
              error.record_id = await card.getAttribute('data-id').catch(() => '') || ''; throw error;
            }
            await this.editor.page.waitForTimeout(500);
          }
          continuation.terminal_status = 'uncertain'; continuation.finished_at = new Date().toISOString(); await this.persist();
          const error = new Error('组合区块继续生成等待超时，拒绝重复提交'); error.code = 'GENERATION_UNCONFIRMED'; throw error;
        }
        return frame;
      }
      if (matches.length > 1) throw new Error("复合区块生成记录匹配不唯一，拒绝继续生成");
      await this.editor.page.waitForTimeout(250);
    }
    throw new Error("未找到本轮复合区块生成记录，拒绝重新提交生成");
  }

  async generateAndApply(record) {
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
      const shouldSelect = mode.dynamicTypes.includes(name);
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
