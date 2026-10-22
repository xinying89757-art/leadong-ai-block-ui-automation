import {
  assertFullPageState,
  fullPagePaths,
  fullPageResumeAction,
  readFullPageJson,
  writeFullPageJson,
} from "./ai-full-page-state.mjs";
import path from "node:path";
import { pageContentSnapshot, waitForCompleteContent } from "./ai-content-ready.mjs";
import { assertPageCapacityAvailable } from './ai-platform-errors.mjs';
import { comparePageIdentity } from './page-identity.mjs';

async function visible(locator) { return locator.isVisible().catch(() => false); }

async function firstVisible(locator) {
  if (Array.isArray(locator)) {
    for (const candidate of locator) {
      if (candidate && await visible(candidate)) return candidate;
    }
    return null;
  }
  const count = await locator.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    if (await visible(locator.nth(index))) return locator.nth(index);
  }
  return null;
}

export async function waitFor(check, timeoutMs, label, intervalMs = 300) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`${label}等待超时`);
}

function evidenceFromText(text, heading, sections, requireSectionLabels = true) {
  const uniqueHeading = text.includes(heading);
  const foundSections = sections.filter((section) => text.toLowerCase().includes(section.toLowerCase()));
  const hasSubstantialContent = text.length >= 200;
  const structurePassed = (uniqueHeading || foundSections.length >= 3) &&
    (requireSectionLabels || hasSubstantialContent);
  const passed = uniqueHeading && (requireSectionLabels ? foundSections.length >= 3 : hasSubstantialContent);
  return { uniqueHeading, foundSections, hasSubstantialContent, structurePassed, passed };
}

export function englishContentEvidence(text) {
  const chinese = text.match(/[\u4e00-\u9fff]/g) ?? [];
  const excerpt = text.match(/.{0,20}[\u4e00-\u9fff].{0,30}/s)?.[0] ?? "";
  return { passed: chinese.length === 0, chineseCharacterCount: chinese.length, excerpt: excerpt.slice(0, 100) };
}

// Full-page AI copy is model-dependent. Hard assertions only require that
// the rendered page contains actual content, not any particular heading or
// section label.
export function hardContentEvidence(text) {
  const normalized = String(text ?? "")
    .replace(/添加在这里|暂无内容|加载失败|生成失败/g, "")
    .trim();
  return {
    passed: normalized.length > 0,
    hasContent: normalized.length > 0,
    textLength: normalized.length,
  };
}

function generationFailureStatus(error) {
  return /整页生成失败|未检测到生成请求|开始生成按钮点击/.test(error.message) ? "failed" : "uncertain";
}

export function promptMatchesPayload(payload, expectedPrompt) {
  try {
    const body = typeof payload === "string" ? JSON.parse(payload) : payload;
    if (typeof body?.prompt === "string") return body.prompt === expectedPrompt;
  } catch { /* Fall through to a raw-text comparison. */ }
  return typeof payload === "string" && payload.includes(expectedPrompt);
}

async function renderedText(page) {
  const parts = [];
  for (const frame of page.frames()) {
    const text = await frame.locator("body").innerText().catch(() => "");
    if (text && !parts.includes(text)) parts.push(text);
  }
  return parts.join("\n");
}

async function editorCanvasText(page) {
  const parts = [];
  for (const frame of page.frames()) {
    if (frame === page.mainFrame() || frame.url().includes("/blockEditorUI/")) continue;
    const area = frame.locator("#backstage-bodyArea");
    const text = await (await area.count().catch(() => 0) ? area.innerText() : frame.locator("body").innerText()).catch(() => "");
    if (text && !parts.includes(text)) parts.push(text);
  }
  return parts.join("\n");
}

export class AiFullPageAutomation {
  constructor(editor, config, runId) {
    this.editor = editor;
    this.config = config;
    this.mode = config.ai.fullPageRegression;
    this.runId = runId;
    this.paths = fullPagePaths(config, runId);
    this.state = null;
  }

  async persist() { await writeFullPageJson(this.paths.state, this.state); }

  async initialize() {
    const state = await readFullPageJson(this.paths.state);
    if (!state) throw new Error(`运行 ${this.runId} 没有整页状态`);
    assertFullPageState(state, this.config, this.runId);
    this.state = state;
    const exists = await this.editor.customPageExists(state.page.name);
    return fullPageResumeAction(state, exists);
  }

  aiFrame() {
    return this.editor.page.frames().find((frame) => frame.url().includes(this.config.selectors.aiEditorFrameUrlIncludes));
  }

  async currentPageName() {
    return (await this.editor.page.locator("#backstage_select_pages a.backstage-topToolbar-menuIcon").first().innerText().catch(() => "")).trim();
  }

  async currentPageIdentity() {
    if (this.editor.currentPageIdentity) return this.editor.currentPageIdentity();
    const selector = this.editor.page.locator("#backstage_select_pages a.backstage-topToolbar-menuIcon").first();
    return selector.evaluate((element) => ({
      name: (element.innerText || "").trim(),
      id: element.getAttribute("data-page-id") || element.getAttribute("data-px2-page-id") || "",
      path: "",
    })).catch(() => ({ name: "", id: "", path: "" }));
  }

  async assertTargetPageIdentity() {
    const identity = await this.currentPageIdentity();
    const expected = this.state.page.target_identity || { name: this.state.page.name, path: this.state.page.path };
    const comparison = comparePageIdentity(expected, identity);
    if (!comparison.matched) {
      throw new Error(`整页目标页面身份不匹配：预期 ${this.state.page.name}，当前 ${identity.name || "未知"}`);
    }
    if (expected?.id && identity.id && expected.id !== identity.id) {
      throw new Error(`整页目标页面 ID 不匹配：预期 ${expected.id}，当前 ${identity.id}`);
    }
    if (expected?.path && identity.path && expected.path !== identity.path) {
      throw new Error(`整页目标页面路径不匹配：预期 ${expected.path}，当前 ${identity.path}`);
    }
    this.state.page.target_identity = { ...expected, id: identity.id, observed_at: new Date().toISOString(), stale_label: comparison.staleLabel === true };
    await this.persist();
    return identity;
  }

  async openGenerator() {
    // Ensure the base 3.0 canvas (including the AI entry) is fully mounted
    // before opening the new-page wizard.  Waiting on the top-level document
    // alone can race the canvas iframe and produce the transient readiness
    // prompt even after the user has logged in successfully.
    await this.editor.waitForCanvasReady().catch(() => {});
    // Let the freshly opened 3.0 editor finish loading/preheating its AI
    // resources before opening the page-creation wizard.  Without this
    // stabilization window the product can show a transient “AI 编辑器尚未
    // 就绪” dialog even though the editor would be ready moments later.
    await this.editor.page.waitForTimeout(this.mode.editorStabilizeMs ?? 5000);
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      // A close/reopen cycle can leave the first-level “新建页面” wizard
      // visible. In that case continue from the visible 3.0 card instead of
      // reopening the page menu and clicking the dialog title.
      let editor3 = await firstVisible([
        this.editor.page.locator("button.editor-page-create").filter({ hasText: /网页编辑器3\.0/ }).first(),
        this.editor.page.getByText("网页编辑器3.0", { exact: true }).first(),
      ]);
      if (!editor3) {
        await this.editor.openCustomPageList();
        const newPage = await firstVisible(this.editor.page.getByText("新建页面", { exact: true }));
        if (!newPage) throw new Error("自定义页面列表中未找到可见的“新建页面”入口");
        await newPage.click();
        editor3 = await firstVisible([
          this.editor.page.locator("button.editor-page-create").filter({ hasText: /网页编辑器3\.0/ }).first(),
          this.editor.page.getByText("网页编辑器3.0", { exact: true }).first(),
        ]);
      }
      if (editor3) {
        await editor3.click({ force: true });
        await this.editor.page.waitForTimeout(this.mode.editorStabilizeMs ?? 5000);
      }
      const create = await waitFor(
        () => firstVisible(this.editor.page.locator("span.ai-page-create")),
        this.config.timeouts.actionMs,
        "AI 生成页面入口",
      );
      if (!create) throw new Error("新建页面弹窗中未找到可见的“AI 生成页面 → 立即生成”入口");
      await create.click();
      try {
        const ready = await this.waitForFullPageAiEditor(attempt);
        if (ready.notReady) {
          this.state.generation.editor_ready_status = "waiting";
          this.state.generation.editor_ready_wait_ms = ready.waitMs;
          this.state.generation.editor_ready_attempt = attempt;
          await this.persist();
          throw new Error("AI 编辑器尚未就绪，请稍后重试");
        }
        const frame = ready.frame;
        if (!(await frame.locator("button.block-category-trigger").first().isDisabled().catch(() => false))) {
          throw new Error("AI 弹窗没有进入整页生成模式，拒绝在当前页生成区块");
        }
        this.state.generation.editor_ready_wait_ms = ready.waitMs;
        this.state.generation.editor_ready_attempt = attempt;
        this.state.generation.editor_ready_status = "ready";
        await this.persist();
        return frame;
      } catch (error) {
        const notReady = this.editor.page.getByText("AI 编辑器尚未就绪，请稍后重试", { exact: true }).first();
        if (attempt === 2 || !(await visible(notReady))) throw error;
        const confirm = await firstVisible([
          this.editor.page.locator(".layui-layer:visible .layui-layer-btn0").last(),
          this.editor.page.locator(".layui-layer:visible button").filter({ hasText: "确定" }).last(),
          this.editor.page.getByRole("button", { name: "确定", exact: true }).last(),
          this.editor.page.getByText("确定", { exact: true }).last(),
        ]);
        if (!confirm) throw new Error("AI 编辑器未就绪提示中未找到可见的“确定”按钮");
        await confirm.click({ force: true }).catch(async () => {
          await confirm.evaluate((element) => element.click()).catch(() => {});
        });
        const closed = await waitFor(
          async () => !(await visible(notReady)),
          3000,
          "关闭 AI 编辑器未就绪提示",
          100,
        ).catch(() => false);
        if (!closed) throw new Error("AI 编辑器未就绪提示的“确定”按钮点击未生效");
        await this.editor.page.waitForTimeout(5000);
        // Retry through New Page → AI Generate Page only. The canvas AI
        // image opens block generation, which must never be used here.
      }
    }
    throw new Error("AI 整页编辑器初始化失败");
  }

  async waitForFullPageAiEditor(attempt) {
    const started = Date.now();
    const deadline = started + this.config.timeouts.blockRenderMs;
    // The backend can briefly render the generic “not ready” message while
    // the AI iframe is still being mounted.  Treating that first paint as a
    // hard failure caused the runner to retry immediately and never gave the
    // editor a chance to become ready.  Keep observing for a short grace
    // window; only a persistent message is considered a real readiness stop.
    const notReadyGraceMs = this.mode.editorNotReadyGraceMs ?? 10000;
    let notReadySince = 0;
    while (Date.now() < deadline) {
      const notReady = this.editor.page
        .getByText("AI 编辑器尚未就绪，请稍后重试", { exact: true })
        .first();
      if (await visible(notReady)) {
        notReadySince ||= Date.now();
        if (Date.now() - notReadySince >= notReadyGraceMs) {
          return { notReady: true, waitMs: Date.now() - started, attempt };
        }
        await this.editor.page.waitForTimeout(300);
        continue;
      }
      notReadySince = 0;
      const frame = this.aiFrame();
      if (frame) {
        const promptReady = await frame.locator("textarea.ai-prompt-input--card").isVisible().catch(() => false);
        const historyReady = await frame.locator("button.ai-page-history-trigger").isVisible().catch(() => false);
        if (promptReady && historyReady) return { frame, waitMs: Date.now() - started, attempt };
      }
      await this.editor.page.waitForTimeout(300);
    }
    throw new Error(`AI 整页编辑器初始化等待超时（${this.config.timeouts.blockRenderMs}ms）`);
  }

  async selectInputs(frame, promptText = this.state.generation.original_prompt) {
    const tab = frame.locator("button.ai-tab-item").filter({ hasText: this.mode.inputMode }).first();
    await tab.click();
    if (!(await tab.evaluate((element) => element.classList.contains("active")))) throw new Error("文字描述页签未选中");
    const tier = frame.locator("button.tier-trigger").first();
    if (!(await tier.innerText()).includes(this.mode.generationMode)) {
      await tier.click();
      const choice = await firstVisible(frame.locator(".tier-option").filter({ hasText: this.mode.generationMode }));
      if (!choice) throw new Error("未找到快速模式");
      await choice.click();
    }
    if (!(await tier.innerText()).includes(this.mode.generationMode)) throw new Error("快速模式选择失败");
    const prompt = frame.locator("textarea.ai-prompt-input--card").first();
    await prompt.fill(promptText);
    if ((await prompt.inputValue()).trim() !== promptText) throw new Error("整页提示词未成功填入");
    // Allow the AI editor's debounced prompt state to catch up before submit.
    await frame.waitForTimeout(1500);
    if ((await prompt.inputValue()).trim() !== promptText) throw new Error("整页提示词在提交前发生变化");
  }

  async historyCards(frame) {
    return frame.locator("article.ai-page-history-card");
  }

  async refreshHistory(frame) {
    const back = frame.locator("button.ai-page-history-back").first();
    if (await visible(back)) {
      await back.click();
      await frame.locator("textarea.ai-prompt-input--card").first()
        .waitFor({ state: "visible", timeout: this.config.timeouts.actionMs });
    }
    const trigger = frame.locator("button.ai-page-history-trigger").first();
    await trigger.waitFor({ state: "visible", timeout: this.config.timeouts.actionMs });
    await trigger.click();
  }

  async closeFullPageGenerator(frame) {
    const close = await firstVisible([
      frame?.getByRole("button", { name: /关闭|Close/i }).first(),
      frame?.getByTitle('关闭', { exact: true }).first(),
      frame?.locator("button").filter({ hasText: /^×$/ }).first(),
      frame?.locator(".close-icon-container").first(),
    ]);
    if (!close) throw new Error("整页 AI 编辑器中未找到关闭按钮，无法刷新生成状态");
    await close.click({ force: true }).catch(async () => {
      await close.evaluate((element) => element.click()).catch(() => {});
    });
    await waitFor(
      async () => !this.aiFrame() || !(await visible(this.aiFrame().locator("textarea.ai-prompt-input--card").first())),
      5000,
      "关闭整页 AI 编辑器",
      100,
    );
  }

  async inspectGenerationCard(frame) {
    const trigger = frame.locator("button.ai-page-history-trigger").first();
    if (await visible(trigger) && !(await trigger.getAttribute("class") ?? "").includes("active")) {
      await trigger.click();
    }
    await frame.locator("article.ai-page-history-card").first().waitFor({
      state: "visible",
      timeout: this.config.timeouts.actionMs,
    }).catch(() => {});
    const marker = this.state.generation.active_prompt || this.state.generation.original_prompt;
    const candidate = await this.matchingHistoryCard(frame, marker);
    if (!candidate) return { status: "not-found", card: null };
    const cardText = await candidate.innerText().catch(() => "");
    const cardClass = await candidate.getAttribute("class") ?? "";
    if (cardClass.includes("is-failed") || cardText.includes("生成失败")) {
      throw new Error(`整页生成失败：${cardText.slice(-300)}`);
    }
    const progress = cardText.match(/(\d+)\s*\/\s*(\d+)/);
    if (cardClass.includes("is-partial-success") || cardText.includes("部分成功")) {
      throw new Error(`整页生成失败：${cardText.slice(-300)}`);
    }
    if ((/is-success|is-completed|is-finished/.test(cardClass) || /生成成功|生成完成/.test(cardText)) &&
        progress && Number(progress[1]) < Number(progress[2])) {
      throw new Error(`整页生成失败：仅完成 ${progress[1]}/${progress[2]} 个区块`);
    }
    const action = candidate.locator("button").filter({ hasText: /新建页面|应用|使用|插入/ });
    const success = await action.count().catch(() => 0) > 0 ||
      /is-success|is-completed|is-finished/.test(cardClass) || /生成成功|生成完成/.test(cardText);
    return { status: success ? "succeeded" : "generating", card: candidate };
  }

  async waitForGenerationAfterReopen(frame) {
    const intervalMs = this.mode.generationStatusRefreshIntervalMs ?? 30000;
    const timeoutMs = this.mode.generationTimeoutMs ?? 1200000;
    const maxRefreshes = this.mode.maxGenerationRefreshes ?? Math.ceil(timeoutMs / intervalMs);
    const started = Date.now();
    let current = frame;
    await this.closeFullPageGenerator(current);
    for (let refresh = 1; refresh <= maxRefreshes && Date.now() - started < timeoutMs; refresh += 1) {
      const remaining = timeoutMs - (Date.now() - started);
      await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, Math.max(0, remaining))));
      if (Date.now() - started >= timeoutMs) break;
      current = await this.openGenerator();
      this.state.generation.status_refresh_count = refresh;
      this.state.generation.last_status_refresh_at = new Date().toISOString();
      this.state.generation.last_observed_status = "refreshing";
      await this.persist();
      try {
        const result = await this.inspectGenerationCard(current);
        this.state.generation.last_observed_status = result.status;
        await this.persist();
        if (result.status === "succeeded") return { frame: current, card: result.card };
      } catch (error) {
        await this.closeFullPageGenerator(current).catch(() => {});
        throw error;
      }
      await this.closeFullPageGenerator(current);
      current = null;
    }
    const timeout = new Error(`整页生成状态在 ${timeoutMs}ms 内未完成（已刷新 ${this.state.generation.status_refresh_count ?? 0} 次）`);
    this.state.generation.generation_status = "uncertain";
    this.state.generation.failure_reason = timeout.message;
    await this.persist();
    throw timeout;
  }

  async matchingHistoryCard(frame, prompt) {
    const cards = await this.historyCards(frame);
    const matches = [];
    for (let index = 0, count = await cards.count(); index < count; index += 1) {
      const candidate = cards.nth(index);
      if ((await candidate.innerText().catch(() => "")).includes(prompt)) matches.push(candidate);
    }
    if (matches.length > 1) throw new Error(`整页生成记录匹配到 ${matches.length} 条，拒绝不确定应用`);
    return matches[0] ?? null;
  }

  async historyBaseline(frame) {
    const trigger = frame.locator("button.ai-page-history-trigger").first();
    await trigger.waitFor({ state: "visible", timeout: this.config.timeouts.actionMs });
    await frame.waitForTimeout(1000);
    return Number((await trigger.locator("b").innerText()).trim()) || 0;
  }

  async findHistoryResult(frame, timeoutMs = this.config.timeouts.blockRenderMs) {
    const trigger = frame.locator("button.ai-page-history-trigger").first();
    if (await visible(trigger) && !(await trigger.getAttribute("class") ?? "").includes("active")) await trigger.click();
    let lastRefresh = Date.now();
    const card = await waitFor(async () => {
      const marker = this.state.generation.active_prompt || this.state.generation.original_prompt;
      const candidate = await this.matchingHistoryCard(frame, marker);
      if (!candidate) {
        if (Date.now() - lastRefresh >= 10000) {
          try { await this.refreshHistory(frame); }
          catch (error) {
            this.state.generation.history_refresh_error = error.message;
            await this.persist();
          }
          lastRefresh = Date.now();
        }
        return false;
      }
      const cardText = await candidate.innerText();
      const cardClass = await candidate.getAttribute("class") ?? "";
      if (cardClass.includes("is-failed") || cardText.includes("生成失败")) {
        throw new Error(`整页生成失败：${cardText.slice(-300)}`);
      }
      const progress = cardText.match(/(\d+)\s*\/\s*(\d+)/);
      if (cardClass.includes("is-partial-success") || cardText.includes("部分成功")) {
        throw new Error(`整页生成失败：${cardText.slice(-300)}`);
      }
      if ((/is-success|is-completed|is-finished/.test(cardClass) || /生成成功|生成完成/.test(cardText)) &&
          progress && Number(progress[1]) < Number(progress[2])) {
        throw new Error(`整页生成失败：仅完成 ${progress[1]}/${progress[2]} 个区块`);
      }
      const action = candidate.locator("button").filter({ hasText: /新建页面|应用|使用|插入/ });
      if (await action.count().catch(() => 0)) return candidate;
      if (/is-success|is-completed|is-finished/.test(cardClass) || /生成成功|生成完成/.test(cardText)) return candidate;
      return false;
    }, timeoutMs, "本轮整页生成记录", 1000);
    const id = await card.getAttribute("data-id").catch(() => "");
    if (id) this.state.generation.history_id = id;
    return card;
  }

  async generate(frame) {
    // A generation request is submitted only once per run.  The modal does
    // not update its history card live, so status polling is handled by
    // close/reopen cycles in waitForGenerationAfterReopen().
    const retryLimit = 1;
    const responses = [];
    const onResponse = (response) => {
      try {
        const url = new URL(response.url());
        if (response.request().method() !== "POST" || !url.pathname.endsWith("/generate-page")) return;
        if (responses.length >= 30) return;
        const entry = { method: response.request().method(), path: url.pathname, status: response.status() };
        const payload = response.request().postData() ?? "";
        try {
          const requestBody = response.request().postDataJSON();
          if (typeof requestBody?.requestId === "string") entry.request_id = requestBody.requestId;
          entry.prompt_submitted = promptMatchesPayload(requestBody, this.state.generation.active_prompt);
        } catch { /* Keep the response evidence. */ }
        if (entry.prompt_submitted === undefined) {
          let decodedPayload = payload;
          try { decodedPayload = decodeURIComponent(payload); } catch { /* Keep raw payload. */ }
          entry.prompt_submitted = promptMatchesPayload(payload, this.state.generation.active_prompt) ||
            decodedPayload.includes(this.state.generation.active_prompt);
        }
        responses.push(entry);
        if (url.pathname.endsWith("/generate-page")) {
          response.json().then((body) => {
            if (!body || typeof body !== "object") return;
            for (const key of ["code", "message", "msg", "success", "status"]) {
              if (["string", "number", "boolean"].includes(typeof body[key])) entry[key] = String(body[key]).slice(0, 300);
            }
            if (typeof body?.data?.pageRecordId === "string" || typeof body?.data?.pageRecordId === "number") {
              entry.page_record_id = String(body.data.pageRecordId);
            }
            if (typeof body?.data?.status === "string") entry.generation_status = body.data.status;
          }).catch(() => {});
        }
      } catch { /* Ignore non-URL responses. */ }
    };
    this.editor.page.context().on("response", onResponse);
    try {
      for (let attempt = 1; attempt <= retryLimit; attempt += 1) {
        const beforeCount = await this.historyBaseline(frame);
        const basePrompt = this.state.generation.original_prompt;
        const activePrompt = attempt === 1 ? basePrompt : `${basePrompt} Retry attempt ${attempt}.`;
        this.state.generation.active_prompt = activePrompt;
        this.state.generation.record_retry_count = attempt - 1;
        await this.selectInputs(frame, activePrompt);
        this.state.generation.generation_status = "running";
        this.state.generation.failure_reason = "";
        this.state.generation.started_at = new Date().toISOString();
        await this.persist();
        const generate = await firstVisible([
          frame.getByRole("button", { name: "开始生成", exact: true }),
          frame.locator("button.ai-generate-btn").filter({ hasText: "开始生成" }).first(),
          frame.locator("button.ai-generate-btn").first(),
        ]);
        if (!generate) throw new Error("整页 AI 编辑器中未找到可见的“开始生成”按钮");
        await generate.waitFor({ state: "visible", timeout: this.config.timeouts.actionMs });
        if (!(await generate.isEnabled())) throw new Error("整页开始生成按钮不可用");
        const clickBefore = {
        text: (await generate.innerText().catch(() => "")).trim(),
        disabled: await generate.isDisabled().catch(() => false),
        historyCount: beforeCount,
      };
        // Ignore unrelated POSTs made while the dialog was loading.
        responses.length = 0;
      // The product may switch the iframe to its history view immediately
      // after submission. Disable Playwright's implicit navigation wait so a
      // successful click is not mistaken for a hung action; status is read
      // only after the modal is closed and reopened.
        await generate.click({ noWaitAfter: true });
      // Confirm that the actual generate control was activated before
      // waiting on the (potentially very slow) generation record.  This
      // makes a missed click observable and prevents silently proceeding as
      // if generation had started.
        const firstSignal = await waitFor(async () => {
          const count = Number((await frame.locator("button.ai-page-history-trigger b").first().innerText().catch(() => "0")).trim()) || 0;
          const text = (await generate.innerText().catch(() => "")).trim();
          const disabled = await generate.isDisabled().catch(() => false);
          return responses.length > 0 || count > clickBefore.historyCount || disabled || text !== clickBefore.text;
        }, 15000, "整页“开始生成”点击确认", 250).catch(() => false);
        if (!firstSignal) throw new Error("点击开始生成按钮后未检测到状态变化或生成请求；为避免重复扣点，停止自动点击");
        this.state.generation.click_verified_at = new Date().toISOString();
        this.state.generation.click_evidence = {
        button_text_before: clickBefore.text,
        button_disabled_before: clickBefore.disabled,
        history_count_before: clickBefore.historyCount,
        captured_at: this.state.generation.click_verified_at,
        };
        await this.persist();
        const requestObserved = await waitFor(
        async () => responses.length > 0 ||
          (Number((await frame.locator("button.ai-page-history-trigger b").first().innerText().catch(() => "0")).trim()) || 0) > beforeCount,
        15000,
        "整页开始生成请求或新增记录",
        250,
        ).catch(() => false);
        if (!requestObserved) throw new Error("点击开始生成按钮后未检测到生成请求或新增记录");
        const request = await waitFor(
          () => responses.find((entry) => entry.page_record_id) || false,
          15000,
          "整页生成接口返回记录 ID",
          250,
        );
        if (!request.prompt_submitted || request.code !== "200") {
          throw new Error("整页生成接口未确认本轮提示词或返回非成功码，停止后续操作");
        }
        this.state.generation.request_attempts ??= [];
        this.state.generation.request_attempts.push({
          attempt,
          prompt: activePrompt,
          request_id: request.request_id ?? "",
          page_record_id: request.page_record_id,
          prompt_submitted: request.prompt_submitted,
          response_code: request.code ?? "",
          submitted_at: new Date().toISOString(),
          // pageRecordId is retained as request evidence only.  It is not
          // compared with the id of a history card because those fields have
          // different semantics in the product API.
          page_record_id_semantics: "page-record",
        });
        this.state.generation.request_evidence = responses.slice();
        this.state.generation.page_record_id = request.page_record_id;
        await this.persist();
        try {
          const result = await this.waitForGenerationAfterReopen(frame);
          this.generationFrame = result.frame;
          this.state.generation.request_evidence = responses;
          this.state.generation.generation_status = "succeeded";
          this.state.generation.generated_at = new Date().toISOString();
          this.state.generation.failure_reason = "";
          await this.persist();
          return result.card;
        } catch (error) {
          this.state.generation.generation_status = generationFailureStatus(error);
          this.state.generation.failure_reason = error.message;
          this.state.generation.request_evidence = responses;
          await this.persist();
          throw error;
        }
      }
    } finally {
      this.editor.page.context().off("response", onResponse);
    }
    throw new Error(`整页生成记录在 ${retryLimit} 次尝试后仍未出现`);
  }

  async recoverGeneration(frame) {
    let card;
    try { card = await this.findHistoryResult(frame, this.mode.generationTimeoutMs); }
    catch (error) {
      this.state.generation.generation_status = generationFailureStatus(error);
      this.state.generation.failure_reason = error.message;
      await this.persist();
      throw error;
    }
    this.state.generation.generation_status = "succeeded";
    this.state.generation.generated_at ||= new Date().toISOString();
    this.state.generation.failure_reason = "";
    await this.persist();
    return card;
  }

  async applyResult(frame, card) {
    const current = await this.currentPageName();
    if (!current || current === this.state.page.name) throw new Error(`整页应用前当前页面不明确：${current}`);
    const historyButton = await firstVisible(card.locator("button").filter({ hasText: /新建页面|应用|使用|插入/ }));
    if (!historyButton) throw new Error("整页成功记录中未找到“新建页面”操作按钮");
    const historyButtonText = (await historyButton.innerText().catch(() => "")).trim();
    const progress = (await card.innerText()).match(/(\d+)\s*\/\s*(\d+)/);
    if (progress && Number(progress[1]) === Number(progress[2])) {
      this.state.generation.expected_block_count = Number(progress[2]);
    }
    if (!this.state.generation.expected_block_count) throw new Error("生成记录区块总数数据不可用，拒绝添加不完整整页");
    const baseline = await pageContentSnapshot(this.editor.canvasContexts(), { editor: true });
    this.state.generation.application_baseline = { block_ids: baseline.blockIds ?? [], fingerprint: baseline.fingerprint };
    this.state.generation.application_status = "applying";
    this.state.page.create_status = "creating";
    await this.persist();
    this.editor.insertionPending = true;
    await historyButton.click();
    // Full-page results use “新建页面” directly; older builds may expose a
    // secondary “应用” button after selecting the result.
    const apply = frame.locator("button.el-button").filter({ hasText: /^应用$/ }).first();
    if (!/新建页面/.test(historyButtonText)) {
      await apply.waitFor({ state: "visible", timeout: this.config.timeouts.blockRenderMs });
      await waitFor(() => apply.isEnabled().catch(() => false), this.config.timeouts.blockRenderMs, "整页应用按钮");
      await apply.click();
    }
    await this.finishPageCreation();
    this.state.generation.application_status = "applied";
    this.state.generation.applied_at = new Date().toISOString();
    this.state.page.create_status = "created";
    await this.persist();
  }

  async finishPageCreation() {
    const expected = this.state.page;
    const dialog = await waitFor(async () => {
      await assertPageCapacityAvailable(this.editor.page);
      const candidate = await firstVisible(this.editor.page.getByText("页面设置", { exact: true }));
      if (candidate) return this.editor.pageSettingsDialog();
      if (expected.creation_receipt?.business_status === 'succeeded') return 'already-created';
      return false;
    }, this.config.timeouts.blockRenderMs, "AI 整页页面设置");
    if (dialog !== "already-created") {
      await this.editor.fillPageSettings(dialog, expected);
      const receipt = await this.editor.submitPageSettings(dialog, expected);
      expected.creation_receipt = receipt;
      expected.create_status = 'created';
      expected.target_identity = { name: expected.name, path: expected.path, id: receipt.id };
      await this.persist();
    }
    this.editor.insertionPending = true;
    // Page creation is not block insertion completion. Never reload, switch
    // pages or open a recovering page menu while insertion is in progress.
    await this.waitForPageApplicationComplete();
    this.editor.insertionPending = false;
    this.editor.unsavedChanges = true;
  }

  async waitForPageApplicationComplete() {
    const page = this.state.page;
    let lastProgressWrite = 0;
    page.application_load_status = "running";
    await this.persist();
    try {
      const evidence = await waitForCompleteContent(async () => {
        await assertPageCapacityAvailable(this.editor.page);
        const snapshot = await pageContentSnapshot(this.editor.canvasContexts(), { editor: true });
        const baseline = this.state.generation.application_baseline;
        const newCanvas = !baseline || (snapshot.fingerprint !== baseline.fingerprint &&
          (snapshot.blockIds ?? []).every((id) => !baseline.block_ids.includes(id)));
        const shellLoading = await this.editor.page.locator(".loadingMask2:visible, .el-loading-mask:visible").count().catch(() => 0);
        const identity = await this.currentPageIdentity();
        const currentPageName = identity.name.trim();
        const expectedIdentity = page.target_identity || { name: page.name, path: page.path };
        const comparison = comparePageIdentity(expectedIdentity, identity);
        return { ...snapshot, loading: snapshot.loading || shellLoading > 0,
          currentPageName, currentPageId: identity.id,
          identityMismatch: comparison.mismatch, targetMatched: comparison.matched, applicationMatched: newCanvas };
      }, {
        expectedCount: this.state.generation.expected_block_count,
        timeoutMs: this.mode.applicationTimeoutMs ?? 300000,
        stableMs: this.mode.applicationStableMs ?? 3000,
        pollMs: this.mode.applicationPollIntervalMs ?? 500,
        identityMismatchTimeoutMs: this.mode.identityMismatchTimeoutMs ?? 15000,
        observe: async (snapshot) => {
          page.application_progress = { count: snapshot.count, ready_count: snapshot.readyCount, loading: snapshot.loading,
            current_page_name: snapshot.currentPageName, current_page_id: snapshot.currentPageId,
            target_matched: snapshot.targetMatched, application_matched: snapshot.applicationMatched };
          if (Date.now() - lastProgressWrite > 5000) { lastProgressWrite = Date.now(); await this.persist(); }
        },
      });
      page.application_load_status = "succeeded";
      page.application_evidence = { count: evidence.count, ready_count: evidence.readyCount, expected_count: evidence.expectedCount,
        stable_ms: evidence.stableMs, block_ids: evidence.blockIds ?? [], target_identity: page.target_identity };
      page.application_ready_at = new Date().toISOString();
      await this.assertTargetPageIdentity();
      await this.persist();
    } catch (error) {
      page.application_load_status = "uncertain";
      page.application_failure_snapshot = error.snapshot || null;
      await this.persist();
      throw error;
    }
  }

  async verifyEditor() {
    // On a fresh application stay on the current canvas until it is complete
    // and saved. Reopening it here can discard blocks still being inserted.
    if (!comparePageIdentity(this.state.page.target_identity || { name: this.state.page.name }, await this.currentPageIdentity()).matched) {
      if (this.state.generation.application_status === "applying") throw new Error("整页应用状态不确定，禁止切换或刷新页面");
      await this.editor.openCustomPage(this.state.page.name);
    }
    await this.assertTargetPageIdentity();
    await this.waitForPageApplicationComplete();
    const evidence = await waitFor(async () => {
      const text = await editorCanvasText(this.editor.page);
      const result = hardContentEvidence(text);
      return result.passed ? result : false;
    }, this.config.timeouts.blockRenderMs, "整页编辑器内容", 500).catch(async () => {
      const text = await editorCanvasText(this.editor.page);
      return hardContentEvidence(text);
    });
    this.state.page.editor_evidence = evidence;
    this.state.page.editor_verified = evidence.passed;
    this.state.page.prompt_fidelity_passed = null;
    if (!evidence.passed) {
      this.state.generation.application_status = "failed";
      this.state.generation.failure_reason = `整页应用后编辑器没有可见内容：文本长度=${evidence.textLength}`;
    }
    await this.persist();
    if (!evidence.passed) throw new Error(`整页编辑器内容校验失败：没有可见内容（文本长度=${evidence.textLength}）`);
  }

  async verifyPreview() {
    const before = new Set(this.editor.page.context().pages());
    const opened = this.editor.page.context().waitForEvent("page", { timeout: 10000 }).catch(() => null);
    await this.editor.page.locator(".clickToPreview").first().click();
    const preview = await opened ?? this.editor.page.context().pages().find((page) => !before.has(page));
    if (!preview) throw new Error("点击预览后未打开页面");
    try {
      await waitForCompleteContent(() => pageContentSnapshot(preview.frames()), {
        expectedCount: this.state.generation.expected_block_count,
        timeoutMs: this.config.timeouts.blockRenderMs,
        stableMs: this.mode.applicationStableMs ?? 3000,
        scope: 'preview', label: '整页预览内容',
      });
      const evidence = await waitFor(async () => {
        const result = hardContentEvidence(await renderedText(preview));
        return result.passed ? result : false;
      }, this.config.timeouts.blockRenderMs, "整页预览内容", 500);
      this.state.page.preview_evidence = { ...evidence, url: preview.url() };
      this.state.page.preview_verified = true;
      await this.persist();
    } finally { if (!preview.isClosed()) await preview.close().catch(() => {}); }
  }

  async verifyPublished() {
    const publicPage = await this.editor.page.context().newPage();
    try {
      await publicPage.waitForTimeout(this.config.ai.publishInitialWaitMs);
      const evidence = await waitFor(async () => {
        await publicPage.goto(this.state.page.publicUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
        const content = await pageContentSnapshot(publicPage.frames());
        const expected = this.state.generation.expected_block_count;
        if (!expected || content.loading || content.count !== expected || content.readyCount !== expected) return false;
        const result = hardContentEvidence(await renderedText(publicPage));
        return result.passed ? { ...result, block_count: content.count, expected_count: expected } : false;
      }, this.config.ai.publishTimeoutMs, "整页公开页内容", this.config.ai.publishPollIntervalMs);
      this.state.page.public_evidence = { ...evidence, url: publicPage.url() };
      this.state.page.published_verified = true;
      this.state.page.failure_reason = "";
      await this.persist();
    } finally { await publicPage.close().catch(() => {}); }
  }

  async verifyPublishedLanguage() {
    const publicPage = await this.editor.page.context().newPage();
    try {
      await publicPage.goto(this.state.page.publicUrl, { waitUntil: "domcontentloaded" });
      const language = englishContentEvidence(await renderedText(publicPage));
      this.state.page.public_evidence ??= { url: publicPage.url() };
      this.state.page.public_evidence.language = language;
      if (!language.passed) {
        this.state.page.prompt_fidelity_passed = false;
        this.state.page.content_warning = [
          this.state.page.content_warning,
          `英语公开页混入中文（${language.chineseCharacterCount} 字）：${language.excerpt}`,
        ].filter(Boolean).join("；");
      }
      await this.persist();
    } finally { await publicPage.close().catch(() => {}); }
  }

  async run() {
    try {
      const action = await this.initialize();
      if (action === "done") return this.state;
      if (action === "generate" || action === "recover-history") {
        const frame = await this.openGenerator();
        const card = action === "generate" ? await this.generate(frame) : await this.recoverGeneration(frame);
        await this.applyResult(this.generationFrame ?? frame, card);
      } else if (action === "verify-page") {
        await this.editor.openCustomPage(this.state.page.name);
        this.state.generation.application_status = "applied";
        this.state.page.create_status = "created";
        await this.persist();
      }
      if (!this.state.page.editor_verified) await this.verifyEditor();
      if (!this.state.page.saved) {
        await this.waitForPageApplicationComplete();
        const save = await this.editor.savePage();
        this.state.page.saved = true;
        this.state.page.save_evidence = save.evidence;
        await this.persist();
        if (!(await this.editor.customPageExists(this.state.page.name))) throw new Error("保存后未在自定义页面列表找到整页");
        await this.editor.openCustomPage(this.state.page.name);
        await this.assertTargetPageIdentity();
        const reopened = await waitForCompleteContent(() => pageContentSnapshot(this.editor.canvasContexts(), { editor: true }), {
          expectedCount: this.state.generation.expected_block_count,
          timeoutMs: this.config.timeouts.blockRenderMs,
          stableMs: this.mode.applicationStableMs ?? 3000,
          scope: "application", label: "整页保存后重新进入页面校验",
        });
        const reopenedText = hardContentEvidence(await editorCanvasText(this.editor.page));
        if (!reopenedText.passed) throw new Error("整页保存后重新进入页面没有有效内容");
        this.state.page.reopened_application_evidence = {
          count: reopened.count, ready_count: reopened.readyCount,
          expected_count: reopened.expectedCount, stable_ms: reopened.stableMs,
          text_length: reopenedText.textLength,
        };
        this.state.page.reopen_verified = true;
        await this.persist();
      }
      if (!this.state.page.preview_verified) await this.verifyPreview();
      if (!this.state.page.published_verified) {
        if (this.state.page.publish_status === "running") throw new Error("上次发布请求状态不确定，请先检查本站公开页");
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
        if (this.state.generation.generation_status === "running" &&
            this.state.generation.application_status === "pending" &&
            !this.state.generation.request_attempts?.length) {
          this.state.generation.generation_status = "uncertain";
          this.state.generation.failure_reason = error.message;
        }
        // Initialization failures happen before generate() can mark the
        // generation as running. Persist them as explicit failures so the
        // CLI's bounded retry policy can recover once, instead of leaving a
        // misleading pending state.
        // The product's "AI 编辑器尚未就绪，请稍后重试" dialog is a
        // transient readiness hint, not a generation failure. Keep the
        // generation status pending so this condition is never mistaken for
        // a billable generation failure or auto-regenerated blindly.
        const screenshot = path.join(this.paths.root, `failure-${Date.now()}.png`);
        if (await this.editor.page.screenshot({ path: screenshot }).then(() => true).catch(() => false)) {
          this.state.page.failure_screenshot = screenshot;
        }
        await this.persist();
      }
      throw error;
    }
  }

  async cleanup() {
    const state = await readFullPageJson(this.paths.state);
    if (!state) throw new Error(`运行 ${this.runId} 没有整页状态`);
    assertFullPageState(state, this.config, this.runId);
    this.state = state;
    if (state.page.cleanup_status === "completed") return state;
    if (!state.page.name.endsWith(this.runId)) throw new Error("整页名称缺少运行 ID，拒绝清理");
    const dryRun = await this.editor.deleteCustomPage(state.page.name, { apply: false });
    if (dryRun.pagePath !== state.page.path) throw new Error(`待清理页面路径不匹配：${dryRun.pagePath}`);
    await this.editor.openCustomPage(state.page.name);
    const evidence = hardContentEvidence(await editorCanvasText(this.editor.page));
    if (!evidence.passed) throw new Error("待清理页面没有可见内容，拒绝删除");
    const deleted = await this.editor.deleteCustomPage(state.page.name, { apply: true });
    if (!deleted.applied || await this.editor.customPageExists(state.page.name)) throw new Error("整页删除后仍在页面列表");
    if (state.page.published_verified) await this.editor.publishSite();
    state.page.cleanup_status = "completed";
    state.page.cleaned_at = new Date().toISOString();
    await this.persist();
    return state;
  }
}

export { evidenceFromText };
