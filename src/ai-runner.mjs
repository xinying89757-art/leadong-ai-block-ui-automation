import { aiPageDescriptor } from "./config.mjs";
import {
  AiStateStore,
  assertAiStateCompatible,
  assertNoDuplicateAppliedType,
  createInitialAiState,
  markTypeApplied,
  markTypeFailed,
  markTypeGenerated,
  markTypePolishFailed,
  markTypePolishStarted,
  markTypePolished,
  markTypeStarted,
  pendingAiRecords,
} from "./ai-state.mjs";
import { exactTypeMenuMatches } from "./ai-type-menu.mjs";

function deadlineAfter(ms) {
  return Date.now() + ms;
}

async function waitUntil(check, timeoutMs, intervalMs = 250, label = "条件") {
  const deadline = deadlineAfter(timeoutMs);
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`${label}等待超时${lastError ? `：${lastError.message}` : ""}`);
}

async function visible(locator) {
  return locator && await locator.isVisible().catch(() => false);
}

async function firstVisible(locators) {
  for (const locator of locators) {
    if (await visible(locator)) return locator;
  }
  return null;
}

async function clickAiEntry(locator) {
  // Force clicks can succeed syntactically while a higher iframe receives
  // the physical pointer event. Require a genuine, unobstructed UI click.
  await locator.click();
}

function exactText(scope, text) {
  return scope.getByText(text, { exact: true });
}

export function publishTimeoutMessage(target, count, expected) {
  return `发布轮询超时：${target} 中检测到 ${count}/${expected} 个 AI 区块`;
}

export class AiBlockAutomation {
  constructor(editor, config, store = new AiStateStore(config.paths.aiStateFile), pageNumber = 1) {
    this.editor = editor;
    this.config = config;
    this.aiConfig = config.ai;
    this.store = store;
    this.pageNumber = pageNumber;
    this.state = null;
    this.page = null;
  }

  async initialize({ resume = false } = {}) {
    if (!this.aiConfig?.enabled) throw new Error("配置未启用 AI 区块模式");
    const descriptor = aiPageDescriptor(this.config, this.pageNumber);
    const existing = await this.store.load();
    if (existing) {
      const migrated = assertAiStateCompatible(existing, this.config);
      this.state = existing;
      if (migrated) await this.store.save(this.state);
    } else {
      this.state = createInitialAiState(this.config, descriptor);
      this.state.page.creation_status = 'pending';
      await this.store.save(this.state);
    }
    if (this.state.page.name !== descriptor.name || this.state.page.path !== descriptor.path) {
      throw new Error("AI 状态文件中的测试页面与当前配置不一致，拒绝误操作其他页面");
    }
    this.page = this.state.page;
    const exists = await this.editor.customPageExists(this.page.name);
    if (!exists) {
      if (resume && this.state.types.some(record => record.generation_status !== 'pending' || record.application_attempted)) {
        throw new Error(`恢复时找不到页面 ${this.page.name}，为避免重复插入已停止`);
      }
      try {
        await this.editor.createCustomPage(this.page, { onCreated: async receipt => {
          this.page.creation_receipt = receipt; this.page.creation_status = 'created'; await this.persist();
        } });
      } catch (error) {
        this.page.failure_step = this.page.creation_status === 'created' ? 'page-switch' : 'page-create';
        this.page.failure_reason = error.message; await this.persist(); throw error;
      }
      this.state.page.creation_status = 'created';
      await this.persist();
    } else {
      if (this.state.page.creation_status === 'pending') throw new Error('测试页面已存在但创建归属未确认，拒绝覆盖；使用新运行隔离重试');
      const identity = await this.editor.openCustomPage(this.page.name);
      if (identity && this.page.creation_receipt?.id && this.page.creation_receipt.id !== identity.id) throw new Error('页面身份不匹配：创建回执与实际页面不同');
      if (identity) this.page.target_identity = identity;
      this.page.failure_step = ''; await this.persist();
    }
    return this.state;
  }

  async persist() {
    await this.store.save(this.state);
  }

  contentFrame() {
    const frames = this.editor.canvasContexts();
    return frames[0];
  }

  async waitForAiImage() {
    const selector = this.config.selectors.aiBlockSelector;
    const frame = this.contentFrame();
    const ai = frame.locator(selector).first();
    await waitUntil(async () => {
      const background = await ai.evaluate((element) => getComputedStyle(element).backgroundImage).catch(() => "");
      const rect = await ai.boundingBox().catch(() => null);
      const present = await ai.count().catch(() => 0);
      return present > 0 && background && background !== "none" && !background.includes("undefined")
        ? (rect || true) && ai
        : false;
    }, this.config.timeouts.blockRenderMs, 250, "AI 区块入口图片");
    return ai;
  }

  aiFrame() {
    return this.editor.page.frames().find((frame) => frame.url().includes(this.config.selectors.aiEditorFrameUrlIncludes));
  }

  async openAiDialog() {
    const ai = await this.waitForAiImage();
    // A specialized block setting can leave the 4.0 editor's exit-confirm
    // layer behind after its final apply. Clear that completed-action prompt
    // before reusing the same AI iframe for the next type.
    await this.dismissAiExitPrompt();
    const existingFrame = this.aiFrame();
    if (existingFrame && await visible(existingFrame.locator(this.config.selectors.aiDialogSelector))) {
      // A specialized recovery can leave the 4.0 dialog mounted on its
      // result view. Reusing that view makes the next category trigger look
      // clickable while its option menu is not mounted. Reopen only when the
      // normal prompt surface is actually visible.
      const promptVisible = await visible(existingFrame.locator(this.config.selectors.aiPromptSelector).first());
      if (promptVisible) return existingFrame;
      await this.closeAiResult();
    }

    await clickAiEntry(ai);
    const loadingText = exactText(this.editor.page, this.config.selectors.aiLoadingText);
    const loadingShown = await waitUntil(
      async () => (await visible(loadingText)) || Boolean(this.aiFrame()),
      this.config.timeouts.blockRenderMs,
      250,
      "AI 编辑器初始化",
    ).catch(() => false);
    const frame = await waitUntil(
      async () => this.aiFrame(),
      this.config.timeouts.blockRenderMs,
      250,
      "AI 4.0 编辑器 iframe",
    );
    await waitUntil(
      async () => Boolean(await frame.locator(".bloct-editor-container").count().catch(() => 0)),
      this.config.timeouts.blockRenderMs,
      250,
      "AI 4.0 编辑器初始化完成",
    );

    if (loadingShown && await visible(loadingText)) {
      // 4.0 iframe 的根节点会先出现，弹层按钮还要等待动画和消息总线稳定。
      await this.editor.page.waitForTimeout(5000);
      const confirm = exactText(this.editor.page, "确定").last();
      if (await confirm.count().catch(() => 0)) {
        await confirm.click({ force: true });
      } else {
        const fallback = this.editor.page.locator(".layui-layer-btn0").last();
        if (await fallback.count().catch(() => 0)) await fallback.click({ force: true });
      }
      await waitUntil(
        async () => !(await visible(loadingText)),
        this.config.timeouts.blockRenderMs,
        250,
        "AI 编辑器加载提示关闭",
      ).catch(() => this.editor.page.waitForTimeout(2000));
      await this.editor.page.waitForTimeout(1000);
    }

    const dialog = frame.locator(this.config.selectors.aiDialogSelector);
    const openedAfterFirstClick = await waitUntil(
      async () => visible(dialog),
      8000,
      250,
      "AI 生成弹窗首次点击",
    ).catch(() => false);
    if (!openedAfterFirstClick) {
      // 首次点击可能只负责预热 4.0 iframe；仅在确实没有弹窗时再次点击。
      await clickAiEntry(await this.waitForAiImage());
    }
    await waitUntil(
      async () => visible(dialog),
      this.config.timeouts.blockRenderMs,
      250,
      "AI 生成弹窗",
    );
    return frame;
  }

  async selectInputMode(frame) {
    const tab = frame.locator(this.config.selectors.aiInputModeSelector).filter({ hasText: this.aiConfig.inputMode }).first();
    if (await tab.count()) {
      const active = await tab.evaluate((element) => element.classList.contains("active")).catch(() => false);
      if (!active) await tab.click({ force: true });
    }
    await waitUntil(
      async () => frame.locator(this.config.selectors.aiInputModeSelector).filter({ hasText: this.aiConfig.inputMode }).first().evaluate((el) => el.classList.contains("active")).catch(() => false),
      this.config.timeouts.actionMs,
      100,
      `输入模式 ${this.aiConfig.inputMode}`,
    );
  }

  async selectType(frame, type) {
    assertNoDuplicateAppliedType(this.state, type);
    const record = this.state.types.find(item => item.type === type);
    if (!record) throw new Error(`状态文件中不存在 AI 类型：${type}`);
    let currentFrame = frame;
    let trigger = currentFrame.locator(this.config.selectors.aiCategoryTriggerSelector);
    await this.dismissAiExitPrompt();
    let option = null;
    for (let surfaceAttempt = 1; surfaceAttempt <= 3 && !option; surfaceAttempt += 1) {
      await trigger.click().catch(() => trigger.click({ force: true }).catch(() => {}));
      const optionDeadline = Date.now() + Math.min(this.config.timeouts.blockRenderMs, 10000);
      let lastMenuRetry = 0;
      while (Date.now() < optionDeadline && !option) {
        const scopes = [currentFrame, ...this.editor.contexts()];
        if (this.aiConfig.exactCategoryMenuTypes?.includes(type)) {
          for (const scope of scopes) {
            const candidates = scope.locator(this.config.selectors.aiCategoryOptionSelector);
            const texts = await candidates.allInnerTexts().catch(() => []);
            const visibleIndexes = [];
            for (let index = 0; index < texts.length; index += 1) {
              if (await candidates.nth(index).isVisible().catch(() => false)) visibleIndexes.push(index);
            }
            const exact = exactTypeMenuMatches(visibleIndexes.map(index => texts[index]), type);
            if (exact.length > 1) {
              const error = new Error(`AI 类型菜单中的“${type}”精确匹配到 ${exact.length} 项，拒绝猜测目标`);
              record.type_menu_evidence = { expected: type, match_count: exact.length, status: "ambiguous", observed_at: new Date().toISOString() };
              await this.persist();
              throw error;
            }
            if (exact.length === 1) {
              const index = visibleIndexes[exact[0]];
              option = candidates.nth(index);
              record.type_menu_evidence = { expected: type, match_count: 1, status: "matched", text: String(texts[index]).trim(), observed_at: new Date().toISOString() };
              await this.persist();
              break;
            }
          }
        } else {
          option = await firstVisible(scopes.map((scope) =>
            scope.locator(this.config.selectors.aiCategoryOptionSelector).filter({ hasText: type }).first(),
          ));
        }
        if (option) break;
        if (Date.now() - lastMenuRetry >= 2000) {
          lastMenuRetry = Date.now();
          await trigger.click().catch(() => trigger.click({ force: true }).catch(() => {}));
        }
        await this.editor.page.waitForTimeout(200);
      }
      if (option) break;
      if (surfaceAttempt < 3) {
        const close = await firstVisible([
          currentFrame.locator(".close-icon-container").first(),
          currentFrame.getByRole("button", { name: /关闭|Close/i }).first(),
        ]);
        if (close) await close.click({ force: true }).catch(() => close.evaluate((element) => element.click()).catch(() => {}));
        await this.dismissAiExitPrompt().catch(() => {});
        await this.editor.page.waitForTimeout(2000);
        currentFrame = await this.openAiDialog();
        trigger = currentFrame.locator(this.config.selectors.aiCategoryTriggerSelector);
      }
    }
    if (!option) {
      const available = [];
      for (const scope of [frame, ...this.editor.contexts()]) {
        available.push(...await scope.locator(this.config.selectors.aiCategoryOptionSelector).allInnerTexts().catch(() => []));
      }
      if (this.aiConfig.exactCategoryMenuTypes?.includes(type)) {
        record.type_menu_evidence = {
          expected: type,
          match_count: 0,
          status: "not-found",
          available_options: [...new Set(available.map(value => value.trim()).filter(Boolean))],
          observed_at: new Date().toISOString(),
        };
        await this.persist();
      }
      throw new Error(`AI 类型下拉中未找到 ${type}；当前选项：${available.map((value) => value.trim()).filter(Boolean).join("、") || "空"}`);
    }
    await option.click({ force: true });
    await waitUntil(
      async () => (await currentFrame.locator(this.config.selectors.aiCategoryTriggerSelector).innerText().catch(() => "")).includes(type),
      this.config.timeouts.actionMs,
      100,
      `AI 类型 ${type}`,
    );
  }

  async selectGenerationMode(frame) {
    const trigger = frame.locator(this.config.selectors.aiTierTriggerSelector);
    if ((await trigger.innerText().catch(() => "")).trim() !== this.aiConfig.generationMode) {
      await trigger.click();
      const choice = await firstVisible([
        frame.getByRole("option", { name: this.aiConfig.generationMode, exact: true }),
        frame.locator(".tier-option").filter({ hasText: this.aiConfig.generationMode }).first(),
        exactText(frame, this.aiConfig.generationMode),
      ]);
      if (!choice) throw new Error(`未找到 AI 生成模式 ${this.aiConfig.generationMode}`);
      await choice.click();
    }
  }

  async waitForAiControlReady(frame, locator, label) {
    await waitUntil(async () => {
      if (!(await visible(locator)) || !(await locator.isEnabled().catch(() => false))) return false;
      return locator.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height) return false;
        const target = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        return target === element || element.contains(target);
      }).catch(() => false);
    }, this.config.timeouts.blockRenderMs, 100, `${label}交互层`);
  }

  async polishPrompt(frame, record, prompt) {
    if (!this.aiConfig.promptPolishEnabled) return record.prompt;
    markTypePolishStarted(record);
    await this.persist();
    try {
      const polish = frame.locator(this.aiConfig.aiPolishSelector).first();
      if (!(await visible(polish))) throw new Error("AI 弹窗中未找到“一键润色”按钮");
      if (!(await polish.isEnabled().catch(() => false))) {
        throw new Error("AI 弹窗中的“一键润色”按钮当前不可用");
      }
      await this.waitForAiControlReady(frame, polish, "AI 一键润色按钮");
      const original = (await prompt.inputValue()).trim();
      await polish.click();
      const polished = await waitUntil(async () => {
        const value = (await prompt.inputValue().catch(() => "")).trim();
        if (value && value !== original) return value;
        const failure = frame.getByText(/润色失败|提示词润色失败|润色.*失败|润色暂不可用/).first();
        if (await visible(failure)) {
          throw new Error(`提示词润色失败：${await failure.innerText()}`);
        }
        return false;
      }, this.aiConfig.aiPolishTimeoutMs, 250, `AI 类型 ${record.type} 提示词润色`);
      markTypePolished(record, polished);
      await this.persist();
      return record.prompt;
    } catch (error) {
      markTypePolishFailed(record, error);
      await this.persist();
      throw error;
    }
  }

  async waitForGeneration(frame, prompt, historyCountBefore = 0, timeoutMs = this.aiConfig.generationTimeoutMs ?? 180000, record = null) {
    const waitStarted = Date.now();
    const deadline = waitStarted + timeoutMs;
    const refreshMs = this.aiConfig.generationStatusRefreshIntervalMs ?? 30000;
    let nextRefresh = waitStarted + refreshMs, refreshCount = 0;
    const metadata = record ?? {};
    const inspect = async () => {
      const applyModule = await firstVisible([
        exactText(frame, "应用模块"),
        frame.locator("button").filter({ hasText: "应用模块" }).first(),
      ]);
      if (refreshCount === 0 && applyModule && await applyModule.isEnabled().catch(() => false)) return { mode: "module", control: applyModule, frame };
      const cards = frame.locator(this.config.selectors.aiHistoryCardSelector);
      const cardCount = await cards.count().catch(() => 0);
      // The service does not guarantee newest-first ordering.  Inspect all
      // newly-created/prompt-matching cards so a failed upload/image request
      // is reported as a confirmed refund instead of becoming a generic
      // timeout with an indeterminate points state.
      for (let index = 0; index < cardCount; index += 1) {
        const candidate = cards.nth(index);
        const text = (await candidate.innerText().catch(() => "")).replace(/\s+/g, ' ').trim();
        const id = await candidate.getAttribute('data-id').catch(() => '') || await candidate.getAttribute('data-record-id').catch(() => '') || '';
        const isNew = metadata.generation_record_id ? id === metadata.generation_record_id : prompt && text.includes(String(prompt).replace(/\s+/g, ' ').trim());
        if (!isNew) continue;
        if (record?.type === "复合区块" && /组合操作失败，已保留可恢复进度/.test(text)) {
          const error = new Error("AI 复合区块生成失败：平台明确返回组合操作失败；可安全重新生成");
          error.code = "GENERATION_FAILED";
          error.explicitPlatformFailure = true;
          error.record_id = await candidate.getAttribute("data-id").catch(() => "") ||
            await candidate.getAttribute("data-record-id").catch(() => "") || "";
          throw error;
        }
        if (/生成失败|失败，点数将自动退还|已自动退还/.test(text)) {
          const error = new Error(`AI 类型生成失败：平台明确返回生成失败${/退还/.test(text) ? '，点数将自动退还' : ''}`); error.code = 'GENERATION_FAILED'; throw error;
        }
      }
      // Counts/order cannot identify a requested generation. A retry often
      // has older successful cards with the same type; never take cards.first().
      const matches = [];
      for (let index = 0; index < cardCount; index += 1) {
        const candidate = cards.nth(index);
        const id = await candidate.getAttribute('data-id').catch(() => '') || await candidate.getAttribute('data-record-id').catch(() => '') || '';
        const text = (await candidate.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
        if (metadata.generation_record_id ? id === metadata.generation_record_id : text.includes(String(prompt).replace(/\s+/g, ' ').trim())) matches.push(candidate);
      }
      const matchedCount = matches.length;
      if (matchedCount > 1) throw new Error('历史生成记录匹配不唯一，拒绝应用');
      const card = matches[0];
      if (matchedCount === 1 && await visible(card)) {
        metadata.generation_record_id = await card.getAttribute('data-id').catch(() => '') || await card.getAttribute('data-record-id').catch(() => '') || metadata.generation_record_id || '';
        metadata.last_record_status = /生成中|正在生成/.test(await card.innerText()) ? 'running' : 'observed';
        const insert = await firstVisible([
          card.getByText(/插入|应用模块/),
          card.locator("button").filter({ hasText: /插入|应用模块/ }),
        ]);
        if (insert && await insert.isEnabled().catch(() => false)) return { mode: "history", frame, control: insert, recordId: await card.getAttribute('data-id').catch(() => '') ||
          await card.getAttribute('data-record-id').catch(() => '') || '' };
      }
      if (await visible(frame.getByText(/AI正在生成|生成中/).first())) metadata.last_record_status = 'running';
      return false;
    };
    while (Date.now() < deadline) {
      const result = await inspect();
      metadata.generation_wait = { started_at: new Date(waitStarted).toISOString(), elapsed_ms: Date.now() - waitStarted,
        refresh_count: refreshCount, last_checked_at: new Date().toISOString(), last_status: metadata.last_record_status || 'unconfirmed' };
      if (record && this.state) await this.persist();
      if (result) {
        metadata.last_record_status = 'succeeded'; metadata.generation_wait.last_status = 'succeeded';
        if (record && this.state) await this.persist();
        return result;
      }
      if (Date.now() >= nextRefresh) {
        await this.closeAiResult();
        frame = await this.openAiDialog();
        const history = frame.locator(this.config.selectors.aiHistoryTriggerSelector).first();
        if (await visible(history)) await history.click();
        refreshCount += 1; nextRefresh = Date.now() + refreshMs;
      }
      await this.editor.page.waitForTimeout(Math.min(500, Math.max(0, deadline - Date.now())));
    }
    // The platform can finish just as the wait deadline is reached. Its
    // history iframe may still show the stale "running" snapshot from the
    // previous 30-second refresh, so reopen once and inspect the same record
    // before recording an uncertain timeout. This is a read-only check: it
    // never submits another generation request.
    await this.closeAiResult();
    frame = await this.openAiDialog();
    const finalHistory = frame.locator(this.config.selectors.aiHistoryTriggerSelector).first();
    if (await visible(finalHistory)) await finalHistory.click();
    const finalResult = await inspect();
    metadata.generation_wait = { started_at: new Date(waitStarted).toISOString(), elapsed_ms: Date.now() - waitStarted,
      refresh_count: refreshCount + 1, last_checked_at: new Date().toISOString(), last_status: metadata.last_record_status || 'unconfirmed' };
    if (record && this.state) await this.persist();
    if (finalResult) {
      metadata.last_record_status = 'succeeded'; metadata.generation_wait.last_status = 'succeeded';
      if (record && this.state) await this.persist();
      return finalResult;
    }
    metadata.generation_status = 'uncertain';
    const error = new Error(metadata.last_record_status === 'running' ? '生成结果待确认：仍在生成，已达到等待上限' : '生成结果待确认：等待超时，未收到明确失败结果');
    error.code = 'GENERATION_UNCONFIRMED'; throw error;
  }

  // Specialized AI block flows can prepare the generated block before the
  // final 4.0 “应用” action. The default block flow has no extra step.
  async beforeFinalApply() {}

  canResumeSubmittedGeneration() { return false; }

  async resumeSubmittedGeneration() { return null; }

  async submitBlockGeneration(frame, generate, prompt, record) {
    record.generation_submitted_at = new Date().toISOString();
    record.generation_mode = this.aiConfig.generationMode;
    await this.persist();
    const matches = request => {
      if (request.method() !== 'POST' || !/generat/i.test(new URL(request.url()).pathname)) return false;
      let payload = request.postData() || '';
      try { payload = decodeURIComponent(payload); } catch { /* Raw JSON is valid. */ }
      return payload.includes(prompt) || payload.includes(JSON.stringify(prompt).slice(1, -1));
    };
    const requestPromise = this.editor.page.waitForRequest(matches, { timeout: this.config.timeouts.actionMs }).catch(() => null);
    await generate.click();
    const request = await requestPromise;
    const progress = await visible(frame.getByText(/AI正在生成|正在生成区块|生成中/).first());
    record.generation_submit_confirmed = Boolean(request || progress || await generate.isDisabled().catch(() => false));
    record.generation_submission = { confirmed: record.generation_submit_confirmed,
      request_observed: Boolean(request), submitted_at: record.generation_submitted_at,
      generation_mode: this.aiConfig.generationMode };
    await this.persist();
    if (!record.generation_submit_confirmed) throw Object.assign(new Error('生成提交结果待确认：开始生成后未检测到请求或进度'), { code: 'GENERATION_UNCONFIRMED' });
  }

  async generateAndApply(record) {
    const resumingSubmittedGeneration = this.canResumeSubmittedGeneration(record);
    let frame;
    let generationPrompt;
    let historyCountBefore = 0;
    if (resumingSubmittedGeneration) {
      frame = await this.resumeSubmittedGeneration(record);
      generationPrompt = record.generation_prompt;
      historyCountBefore = await frame.locator(this.config.selectors.aiHistoryCardSelector).count().catch(() => 0);
    } else {
    // Every type starts from a fresh AI dialog. This is especially important
    // after a specialized product-filter recovery: the previous 4.0 result
    // view can remain mounted and swallow the category-menu transition.
    const staleFrame = this.aiFrame();
    if (staleFrame && (await visible(staleFrame.locator(this.config.selectors.aiDialogSelector)) ||
        await visible(staleFrame.locator('.header-container .close-icon-container').first()))) {
      await this.closeAiResult();
      await this.editor.page.waitForTimeout(500);
    }
    frame = await this.openAiDialog();
    // The exit-confirm layer can be mounted a moment after the AI iframe is
    // returned (especially after a specialized block settings flow). Clear it
    // once more immediately before interacting with the category control so
    // it cannot intercept the first click of the next generation.
    await this.dismissAiExitPrompt();
    await this.editor.page.waitForTimeout(150);
    markTypeStarted(record);
    await this.persist();
    await this.selectInputMode(frame);
    await this.selectType(frame, record.type);
    await this.selectGenerationMode(frame);
    const prompt = frame.locator(this.config.selectors.aiPromptSelector).first();
    const originalPrompt = record.original_prompt ?? record.prompt;
    await prompt.fill(originalPrompt);
    let generationPrompt = originalPrompt;
    try {
      generationPrompt = await this.polishPrompt(frame, record, prompt);
    } catch (error) {
      // Prompt polish is observable test evidence, but it is not allowed to
      // block the detail regression. Keep the failure in state and continue
      // with the original prompt so generation, apply, preview and publish
      // remain covered.
      record.prompt = originalPrompt;
      await this.persist();
    }
    const attemptSuffix = record.type === '复合区块' && Number(record.generation_attempt_number) > 1
      ? `,attempt=${Number(record.generation_attempt_number)}` : '';
    const reference = this.aiConfig.runId ? `[runId=${this.aiConfig.runId},type=${record.type}${attemptSuffix}]` : '';
    if (reference && !generationPrompt.includes(reference)) {
      generationPrompt = `${reference} ${generationPrompt}`;
      await prompt.fill(generationPrompt);
    }
    record.generation_prompt = generationPrompt;
    await this.persist();
    const generate = frame.locator(this.config.selectors.aiGenerateSelector).first();
    if (!(await visible(generate))) throw new Error("AI 弹窗中未找到“开始生成”按钮");
    await this.waitForAiControlReady(frame, generate, "AI 开始生成按钮");
    historyCountBefore = await frame.locator(this.config.selectors.aiHistoryCardSelector).count().catch(() => 0);
    await this.submitBlockGeneration(frame, generate, generationPrompt, record);
    }
    const result = await this.waitForGeneration(frame, generationPrompt, historyCountBefore, undefined, record);
    frame = result.frame ?? frame;
    record.application_source = result.mode === 'history' ? 'history' : 'current-result';
    record.generation_record_id = result.recordId || record.generation_record_id || '';
    await this.persist();
    await result.control.click();
    // History insertion is asynchronous. Depending on the editor build it
    // either exposes “应用模块” or enables the final “应用” directly. Do not
    // wait for a control that may never exist.
    if (result.mode === "history") {
      const next = await waitUntil(async () => {
        const candidate = await firstVisible([
          exactText(frame, "应用模块"),
          frame.locator("button").filter({ hasText: "应用模块" }).first(),
        ]);
        if (candidate && await candidate.isEnabled().catch(() => false)) return { mode: "module", control: candidate };
        const finalApply = frame.locator(this.config.selectors.aiApplySelector).filter({ hasText: /^应用$/ }).first();
        if (await visible(finalApply) && await finalApply.isEnabled().catch(() => false)) return { mode: "final" };
        return false;
      }, this.config.timeouts.blockRenderMs, 250, "AI 历史记录插入");
      if (next.mode === "module") await next.control.click({ force: true });
    }
    markTypeGenerated(record);
    await this.persist();

    // Product-filter regression uses this hook to open the generated block's
    // toolbar, configure the filter fields, and apply the side-panel settings
    // before the generated module is committed to the page.
    await this.beforeFinalApply({ frame, record, result });

    const apply = frame.locator(this.config.selectors.aiApplySelector).filter({ hasText: /^应用$/ }).first();
    if (!(await visible(apply))) throw new Error("生成结果已完成，但未找到 4.0“应用”按钮");
    // “应用模块/插入” is asynchronous.  The final 应用 button can be
    // visible while still disabled, which otherwise makes Playwright return
    // without committing anything to the 3.0 canvas.
    await this.waitForAiControlReady(frame, apply, "AI 应用按钮");
    const saveResponse = this.editor.page.waitForResponse(
      (response) => response.request().method() === "POST" && response.url().includes("/phoenix2/composite/editor/v1/newEditor/savePage"),
      { timeout: this.config.timeouts.blockRenderMs },
    ).catch(() => null).then(response => {
      record.application_acknowledged = response?.ok() === true;
      record.application_http_status = response?.status() ?? null;
      return response;
    });
    record.application_attempted = true;
    await this.persist();
    await apply.click();
    // Paged runs prove the committed outer canvas, not a nested result.
    // Observe DOM and the save response concurrently rather than waiting
    // a full response timeout before starting the rendering barrier.
    const commit = this.confirmApplicationCommit({ frame, record });
    const [response] = await Promise.all([saveResponse, commit]);
    record.application_acknowledged = response?.ok() === true;
    if (response && !response.ok()) throw new Error(`AI 区块应用保存接口返回 HTTP ${response.status()}`);
    // The 3.0 canvas is updated asynchronously after the save response. Wait
    // for the committed AI wrapper before closing the 4.0 dialog; closing too
    // early can leave only the temporary result iframe on screen.
    if (!record.application_commit_confirmed) await waitUntil(async () => {
      for (const canvas of this.editor.canvasContexts()) {
        if (await canvas.locator(this.config.selectors.aiGeneratedBlockSelector).count().catch(() => 0)) return true;
      }
      return false;
    }, this.config.timeouts.blockRenderMs, 250, "3.0 AI 区块提交").catch(() => this.editor.page.waitForTimeout(3000));
    // At this point the AI result has been committed into the 3.0 canvas.
    // Persist the applied marker before specialized settings so a settings
    // failure can resume from the existing block without regenerating.
    markTypeApplied(this.state, record);
    await this.persist();
    await this.afterFinalApply({ frame, record });
    const close = frame.locator(".close-icon-container").first();
    if (await visible(close)) await close.click();
    await this.dismissAiExitPrompt();
    await this.editor.page.waitForTimeout(this.aiConfig.applyIntervalMs);
    record.editor_verified = await this.verifyEditorType(record.type);
    record.verified_at = new Date().toISOString();
    if (!record.editor_verified) throw new Error(`AI 类型 ${record.type} 应用后未在编辑器中检测到 AI 区块`);
    await this.checkpointAppliedType(record);
    await this.persist();
  }

  // Specialized flows can configure the freshly committed 3.0 block before
  // the temporary AI dialog is closed. The default flow has no extra step.
  async afterFinalApply() {}

  async confirmApplicationCommit() {}

  async checkpointAppliedType() {}

  async dismissAiExitPrompt() {
    const selector = '.el-overlay-message-box[role="dialog"][aria-label="退出编辑"], .el-overlay-message-box[role="dialog"][aria-label="Exit editing"]';
    const scopes = this.editor.contexts?.() || [this.editor.page];
    const prompt = await firstVisible(scopes.map(scope => scope.locator(selector).first()));
    if (!prompt) return false;
    const confirm = await firstVisible([
      prompt.getByRole("button", { name: /确定|退出|确认|OK|Confirm/i }).last(),
      prompt.locator(".el-message-box__btns button").filter({ hasText: /确定|退出|确认|OK|Confirm/i }).last(),
    ]);
    if (!confirm) throw new Error("AI 编辑器存在“退出编辑”确认层，但未找到确认按钮");
    await confirm.click({ force: true });
    await waitUntil(
      async () => !(await visible(prompt)),
      this.config.timeouts.actionMs,
      100,
      "AI 编辑器退出确认层关闭",
    );
    return true;
  }

  async closeAiResult() {
    const frame = this.aiFrame();
    if (frame) {
      await this.closeAiGenerationDialog(frame);
      const close = frame.locator('.header-container .close-icon-container').first();
      if (await visible(close)) await close.click();
    }
    await this.dismissAiExitPrompt();
    await waitUntil(async () => await this.editor.page.locator('.px2-embed-overlay:visible').count() === 0,
      5000, 100, 'AI 编辑器遮罩关闭');
  }

  async closeAiGenerationDialog(frame) {
    const dialog = frame.locator(this.config.selectors.aiDialogSelector);
    if (!await visible(dialog)) return;
    const close = dialog.locator('.ai-dialog-actions button[title="关闭"], .ai-dialog-actions button[aria-label="关闭"]').first();
    if (!await visible(close)) throw new Error('AI 生成弹窗未找到自己的关闭按钮');
    await close.click();
    await waitUntil(async () => !await visible(dialog), 5000, 100, '关闭 AI 生成记录弹窗');
  }

  async verifyEditorType() {
    const selector = this.config.selectors.aiGeneratedBlockSelector;
    for (const frame of this.editor.canvasContexts()) {
      if (await frame.locator(selector).count().catch(() => 0) > 0) return true;
    }
    // 新编辑器可能把区块包装在普通模块节点中；应用后“添加在这里”占位应消失。
    const canvas = this.contentFrame();
    const bodyText = await canvas.locator("#backstage-bodyArea").innerText().catch(() => "");
    return bodyText.trim() !== "" && !bodyText.includes("添加在这里");
  }

  async verifyPreview(expectedCount = this.state.page.types.length) {
    const preview = await firstVisible([
      this.editor.page.locator(".clickToPreview"),
      exactText(this.editor.page, "预览"),
    ]);
    if (!preview) throw new Error("未找到预览入口");
    const before = new Set(this.editor.page.context().pages());
    await preview.click();
    await this.editor.page.waitForTimeout(1000);
    const previewPage = [...this.editor.page.context().pages()].find((item) => !before.has(item)) ?? this.editor.page;
    await previewPage.waitForLoadState("domcontentloaded").catch(() => {});
    const count = await this.countRenderedAiBlocks(previewPage);
    this.state.page.preview_verified = count >= expectedCount;
    for (const record of this.state.types.filter((item) => item.apply_status === "applied")) record.preview_verified = this.state.page.preview_verified;
    await this.persist();
    const result = { url: previewPage.url(), count, verified: this.state.page.preview_verified };
    if (previewPage !== this.editor.page && !previewPage.isClosed()) await previewPage.close();
    return result;
  }

  async countRenderedAiBlocks(page) {
    let count = 0;
    for (const frame of page.frames()) {
      const aiCount = await frame.locator(this.config.selectors.aiGeneratedBlockSelector).count().catch(() => 0);
      const wrapperCount = await frame.locator(".phoenix2-block-wrap, [data-px2-page-id]").count().catch(() => 0);
      const htmlCount = await frame.locator("body").evaluate((body) => {
        const html = body.innerHTML;
        return Math.max(
          (html.match(/phoenix2-block-wrap/g) ?? []).length,
          (html.match(/data-px2-page-id/g) ?? []).length,
        );
      }).catch(() => 0);
      count = Math.max(count, aiCount, wrapperCount, htmlCount);
    }
    return count;
  }

  async verifyPublished() {
    const target = this.page.publicUrl;
    const publicPage = await this.editor.page.context().newPage();
    const deadline = deadlineAfter(this.aiConfig.publishTimeoutMs);
    await publicPage.waitForTimeout(this.aiConfig.publishInitialWaitMs);
    let count = 0;
    while (Date.now() < deadline) {
      await publicPage.goto(target, { waitUntil: "domcontentloaded" }).catch(() => {});
      count = await this.countRenderedAiBlocks(publicPage);
      if (count >= this.aiConfig.blocksPerPage) {
        this.state.page.published_verified = true;
        for (const record of this.state.types.filter((item) => item.apply_status === "applied")) record.published_verified = true;
        await this.persist();
        await publicPage.close();
        return { url: target, count, verified: true };
      }
      await publicPage.waitForTimeout(this.aiConfig.publishPollIntervalMs);
    }
    this.state.page.publish_failure_reason = publishTimeoutMessage(target, count, this.aiConfig.blocksPerPage);
    await this.persist();
    await publicPage.close();
    throw new Error(this.state.page.publish_failure_reason);
  }

  async run({ maxTypes = this.aiConfig.blocksPerPage, publish = false, resume = false } = {}) {
    await this.initialize({ resume });
    if (resume) {
      const uncertain = this.state.types.find((record) => record.recovery_required);
      if (uncertain) {
        throw new Error(`AI 类型 ${uncertain.type} 上次已生成但应用状态无法确认；请人工检查页面后再清理状态或重试`);
      }
      if (
        this.state.page.saved &&
        this.state.page.preview_verified &&
        (!publish || this.state.page.published_verified) &&
        !this.state.page.type_failures?.length &&
        this.state.types.every(record => record.apply_status === 'applied' && record.editor_verified && !record.failure_reason &&
          (record.type !== '导航' || record.navigation_settings?.save_status === 'succeeded') &&
          (record.type !== '产品筛选' || record.filter_settings?.fields_verified === true))
      ) {
        return this.state;
      }
    }
    const records = pendingAiRecords(this.state).slice(0, maxTypes);
    for (const record of records) {
      try {
        if (resume && record.generation_status !== 'pending' && !this.canResumeSubmittedGeneration(record)) {
          throw new Error(`应用状态不确定：${record.type} 已发起生成；恢复仅允许确认历史结果，不再次生成`);
        }
        await this.generateAndApply(record);
      } catch (error) {
        markTypeFailed(record, error);
        await this.persist();
        if (await this.continueAfterTypeFailure(record, error)) continue;
        throw error;
      }
    }
    if (this.state.page.types.length > 0) {
      this.state.page.editor_verified = this.state.types
        .filter((record) => record.apply_status === "applied")
        .every((record) => record.editor_verified);
      await this.editor.savePage();
      this.state.page.saved = true;
      await this.persist();
      await this.verifyPreview(this.state.page.types.length);
      if (publish && this.state.page.types.length === this.aiConfig.blocksPerPage) {
        await this.editor.publishSite();
        await this.verifyPublished();
      }
    }
    return this.state;
  }

  // Only the independent non-detail paged workflow opts into continuation.
  async continueAfterTypeFailure() { return false; }
}
