import { AiPagedAutomation } from "./ai-paged-runner.mjs";

function exactButton(scope, selector, text) {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return scope.locator(selector).filter({ hasText: new RegExp(`^\\s*${escaped}\\s*$`) });
}

async function isVisible(locator) { return await locator.isVisible().catch(() => false); }

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
  canResumeSubmittedGeneration(record) {
    return record?.type === this.config.ai.compositeRegression.type &&
      record.generation_status === "uncertain" && record.generation_submit_confirmed === true &&
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
        const text = (await card.innerText().catch(() => "")).replace(/\s+/g, " ");
        if (needle && text.includes(needle)) matches.push({ card, text });
      }
      if (matches.length === 1) {
        const { card, text } = matches[0];
        if (/组合操作失败，已保留可恢复进度/.test(text)) {
          const error = new Error("AI 复合区块生成失败：本轮历史记录明确显示组合操作失败；准备发起新的独立生成");
          error.code = "GENERATION_FAILED";
          error.explicitPlatformFailure = true;
          error.record_id = await card.getAttribute("data-id").catch(() => "") || await card.getAttribute("data-record-id").catch(() => "") || "";
          throw error;
        }
        return frame;
      }
      if (matches.length > 1) throw new Error("复合区块生成记录匹配不唯一，拒绝继续生成");
      await this.editor.page.waitForTimeout(250);
    }
    throw new Error("未找到本轮复合区块生成记录，拒绝重新提交生成");
  }

  async generateAndApply(record) {
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
      const deadline = Date.now() + this.config.timeouts.actionMs;
      while (Date.now() < deadline && !await isVisible(options.first())) await this.editor.page.waitForTimeout(100);
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
}
