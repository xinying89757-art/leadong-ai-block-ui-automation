import path from "node:path";
import { isGlobalSafetyFailure } from './ai-regression-state.mjs';
import { AiBlockAutomation } from "./ai-runner.mjs";
import { AiFullPageAutomation, waitFor } from "./ai-full-page-runner.mjs";
import {
  assertBlockCountDelta,
  assertHistoryApplicationSource,
  assertHistoryReuseState,
  historyReusePaths,
  historyReuseResumeAction,
  markHistoryApplied,
  markHistoryMatched,
  readHistoryReuseJson,
  writeHistoryReuseJson,
} from "./ai-history-reuse-state.mjs";

async function visible(locator) {
  return locator && await locator.isVisible().catch(() => false);
}

async function firstVisible(locators) {
  for (const locator of locators) {
    if (await visible(locator)) return locator;
  }
  return null;
}

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

async function renderedPageData(page) {
  const texts = [];
  const images = [];
  for (const frame of page.frames()) {
    const text = normalizeText(await frame.locator("body").innerText().catch(() => ""));
    if (text && !texts.includes(text)) texts.push(text);
    const sources = await frame.locator("img[src]").evaluateAll((nodes) => nodes.map((node) => node.currentSrc || node.src || "")).catch(() => []);
    for (const source of sources) if (source && !images.includes(source)) images.push(source);
  }
  return { text: texts.join(" "), images };
}

function sourceKey(value) {
  try { return new URL(value).pathname.split("/").filter(Boolean).at(-1) ?? ""; }
  catch { return String(value ?? "").split("/").filter(Boolean).at(-1) ?? ""; }
}

export function renderedBlockEvidence(data, editorEvidence) {
  const signature = normalizeText(editorEvidence?.text_signature);
  const textMatched = signature.length >= 12 && normalizeText(data?.text).includes(signature);
  const editorImages = (editorEvidence?.image_sources ?? []).map(sourceKey).filter((value) => value.length >= 4);
  const targetImages = (data?.images ?? []).map(sourceKey);
  const imageMatched = editorImages.some((value) => targetImages.includes(value));
  return {
    passed: textMatched || imageMatched,
    text_matched: textMatched,
    image_matched: imageMatched,
    text_length: normalizeText(data?.text).length,
    image_count: data?.images?.length ?? 0,
  };
}

class HistoryFullPageHarness extends AiFullPageAutomation {
  constructor(owner) {
    const scoped = {
      ...owner.config,
      ai: {
        ...owner.config.ai,
        fullPageRegression: {
          ...owner.config.ai.fullPageRegression,
          ...owner.mode,
        },
      },
    };
    super(owner.editor, scoped, owner.runId);
    this.owner = owner;
    this.mode = scoped.ai.fullPageRegression;
    this.state = {
      page: owner.state.full_page.page,
      generation: owner.state.full_page.generation,
    };
  }

  async persist() { await this.owner.persist(); }
}

export class AiHistoryReuseAutomation {
  constructor(editor, config, runId) {
    this.editor = editor;
    this.config = config;
    this.runId = runId;
    this.mode = config.ai.historyReuseRegression;
    this.paths = historyReusePaths(config, runId);
    this.state = null;
    const scoped = {
      ...config,
      ai: {
        ...config.ai,
        inputMode: this.mode.inputMode,
        generationMode: this.mode.generationMode,
        promptPolishEnabled: false,
        applyIntervalMs: this.mode.applyIntervalMs,
      },
    };
    this.blockBase = new AiBlockAutomation(editor, scoped);
    this.blockBase.state = { page: { types: [] } };
  }

  async persist() { await writeHistoryReuseJson(this.paths.state, this.state); }

  async initialize() {
    const state = await readHistoryReuseJson(this.paths.state);
    if (!state) throw new Error(`运行 ${this.runId} 没有生成记录复用状态`);
    assertHistoryReuseState(state, this.config, this.runId);
    this.state = state;
    return state;
  }

  async closeBlockDialog(frame) {
    await this.blockBase.closeAiGenerationDialog(frame);
    await this.blockBase.closeAiResult();
  }

  async reopenFullPageHistory(harness) {
    const existing = harness.aiFrame();
    if (existing && await visible(existing.locator(".close-icon-container").first())) {
      await harness.closeFullPageGenerator(existing).catch(() => {});
    }
    // Closing the full-page AI surface can briefly leave the browser on the
    // cross-region handoff page rather than the 3.0 editor shell. Re-enter
    // through the canonical editor URL before opening New Page again. This
    // also proves that the next action comes from a fresh history session.
    await this.editor.goto();
    await this.editor.waitForCanvasReady().catch(() => {});
    const frame = await harness.openGenerator();
    const trigger = frame.locator("button.ai-page-history-trigger").first();
    await trigger.waitFor({ state: "visible", timeout: this.config.timeouts.actionMs });
    if (!String(await trigger.getAttribute("class")).includes("active")) await trigger.click();
    const marker = this.state.full_page.generation.active_prompt || this.state.full_page.generation.original_prompt;
    const card = await waitFor(
      () => harness.matchingHistoryCard(frame, marker),
      this.config.timeouts.blockRenderMs,
      "重新打开后的整页生成记录",
      500,
    );
    const action = card.locator("button").filter({ hasText: /新建页面|应用|使用|插入/ }).first();
    await action.waitFor({ state: "visible", timeout: this.config.timeouts.actionMs });
    const recordId = await card.getAttribute("data-id").catch(() => "");
    markHistoryMatched(this.state.full_page, recordId);
    this.state.full_page.generation.history_id = recordId || this.state.full_page.generation.history_id;
    await this.persist();
    return { frame, card };
  }

  async runFullPage() {
    const section = this.state.full_page;
    const exists = await this.editor.customPageExists(section.page.name);
    const action = historyReuseResumeAction(section, exists);
    const harness = new HistoryFullPageHarness(this);
    if (action === "done") return;
    if (action === "generate") {
      const frame = await harness.openGenerator();
      section.history.baseline_count = await harness.historyBaseline(frame);
      await this.persist();
      await harness.generate(frame);
    } else if (action === "recover-history") {
      const frame = await harness.openGenerator();
      if (section.generation.generation_status === "succeeded") {
        harness.generationFrame = frame;
      } else {
        const result = await harness.waitForGenerationAfterReopen(frame);
        harness.generationFrame = result.frame;
        section.generation.generation_status = "succeeded";
        section.generation.generated_at ||= new Date().toISOString();
        section.generation.failure_reason = "";
        await this.persist();
      }
    }
    if (["generate", "recover-history"].includes(action)) {
      const { frame, card } = await this.reopenFullPageHistory(harness);
      section.history.application_source = "history";
      await this.persist();
      await harness.applyResult(frame, card);
      markHistoryApplied(section);
      assertHistoryApplicationSource(section);
      await this.persist();
    } else {
      await this.editor.openCustomPage(section.page.name);
      assertHistoryApplicationSource(section);
    }
    if (!section.page.editor_verified) await harness.verifyEditor();
    if (!section.page.saved) {
      await harness.waitForPageApplicationComplete();
      await this.editor.savePage();
      section.page.saved = true;
      await this.persist();
      if (!(await this.editor.customPageExists(section.page.name))) throw new Error("保存后未在自定义页面列表找到生成记录整页");
      await this.editor.openCustomPage(section.page.name);
      await harness.assertTargetPageIdentity();
      await harness.waitForPageApplicationComplete();
      section.page.reopen_verified = true;
      await this.persist();
    }
    if (!section.page.preview_verified) await harness.verifyPreview();
    if (!section.page.published_verified) {
      if (section.page.publish_status === "running") throw new Error("整页记录复用的上次发布状态不确定，请先检查公开页");
      if (section.page.publish_status !== "accepted") {
        section.page.publish_status = "running";
        await this.persist();
        await this.editor.publishSite();
        section.page.publish_status = "accepted";
        await this.persist();
      }
      await harness.verifyPublished();
    }
    section.page.failure_reason = "";
    await this.persist();
  }

  async aiBlockCount() {
    let count = 0;
    for (const frame of this.editor.canvasContexts()) {
      const primary = await frame.locator(".block-container[class*='block-settingId-ai-copilot']").count().catch(() => 0);
      const fallback = primary > 0 ? primary : await frame.locator(".ai-generated-block").count().catch(() => 0);
      count = Math.max(count, fallback);
    }
    return count;
  }

  async editorBlockEvidence() {
    for (const frame of this.editor.canvasContexts()) {
      const candidates = [
        frame.locator(".block-container[class*='block-settingId-ai-copilot']").first(),
        frame.locator(".ai-generated-block").first(),
      ];
      for (const candidate of candidates) {
        if (!(await visible(candidate))) continue;
        const evidence = await candidate.evaluate((element) => {
          const text = (element.innerText || "").replace(/\s+/g, " ").trim();
          const images = [...element.querySelectorAll("img")]
            .filter((image) => {
              const rect = image.getBoundingClientRect();
              const style = getComputedStyle(image);
              return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
            })
            .map((image) => image.currentSrc || image.src || "")
            .filter(Boolean);
          return {
            passed: text.length > 0 || images.length > 0,
            text_length: text.length,
            text_signature: text.slice(0, 80),
            image_sources: images.slice(0, 10),
          };
        });
        if (evidence.passed) return evidence;
      }
    }
    return { passed: false, text_length: 0, text_signature: "", image_sources: [] };
  }

  async generateBlockRecord() {
    const section = this.state.block;
    let frame = await this.blockBase.openAiDialog();
    await this.blockBase.selectInputMode(frame);
    await this.blockBase.selectType(frame, section.type);
    await this.blockBase.selectGenerationMode(frame);
    const prompt = frame.locator(this.config.selectors.aiPromptSelector).first();
    await prompt.fill(section.generation.prompt);
    if ((await prompt.inputValue()).trim() !== section.generation.prompt) throw new Error("静态图文提示词未成功填入");
    const generate = frame.locator(this.config.selectors.aiGenerateSelector).first();
    await this.blockBase.waitForAiControlReady(frame, generate, "AI 开始生成按钮");
    section.history.baseline_count = await frame.locator(this.config.selectors.aiHistoryCardSelector).count().catch(() => 0);
    section.generation.generation_status = "running";
    section.generation.started_at = new Date().toISOString();
    section.generation.failure_reason = "";
    await this.persist();
    this.blockBase.persist = async () => this.persist();
    await this.blockBase.submitBlockGeneration(frame, generate, section.generation.prompt, section.generation);
    try {
      const result = await this.blockBase.waitForGeneration(frame, section.generation.prompt, section.history.baseline_count,
        undefined, section.generation);
      frame = result.frame ?? frame;
      section.generation.generation_status = "succeeded";
      section.generation.generated_at = new Date().toISOString();
      await this.persist();
    } catch (error) {
      section.generation.generation_status = error.code === 'GENERATION_FAILED' ? 'failed' : 'uncertain';
      section.generation.failure_reason = error.message;
      await this.persist();
      throw error;
    }
    await this.closeBlockDialog(frame);
  }

  async inspectBlockHistory(frame) {
    const cards = frame.locator(this.config.selectors.aiHistoryCardSelector);
    const matches = [];
    for (let index = 0, count = await cards.count().catch(() => 0); index < count; index += 1) {
      const candidate = cards.nth(index);
      if ((await candidate.innerText().catch(() => "")).includes(this.state.block.generation.marker)) matches.push(candidate);
    }
    if (matches.length > 1) throw new Error(`静态图文生成记录匹配到 ${matches.length} 条，拒绝不确定插入`);
    if (matches.length === 0) return { status: "not-found", card: null };
    const card = matches[0];
    const text = await card.innerText().catch(() => "");
    const className = await card.getAttribute("class") ?? "";
    if (/生成失败|失败，点数将自动退还/.test(text) || className.includes("is-failed")) {
      throw new Error(`静态图文生成失败：${text.slice(-300)}`);
    }
    const insert = await firstVisible([
      card.locator(this.config.selectors.aiHistoryInsertSelector).first(),
      card.locator("button").filter({ hasText: /插入|应用模块/ }).first(),
    ]);
    return insert ? { status: "succeeded", card, insert } : { status: "generating", card, insert: null };
  }

  async reopenBlockHistory() {
    const intervalMs = this.mode.generationStatusRefreshIntervalMs;
    const timeoutMs = this.mode.generationTimeoutMs;
    const deadline = Date.now() + timeoutMs;
    for (let refresh = 1; refresh <= this.mode.maxGenerationRefreshes && Date.now() < deadline; refresh += 1) {
      const frame = await this.blockBase.openAiDialog();
      const trigger = frame.locator(this.config.selectors.aiHistoryTriggerSelector).first();
      await trigger.waitFor({ state: "visible", timeout: this.config.timeouts.actionMs });
      if (!String(await trigger.getAttribute("class")).includes("active")) {
        await trigger.click().catch(async () => trigger.evaluate((element) => element.click()));
      }
      await frame.locator(this.config.selectors.aiHistoryCardSelector).first().waitFor({ state: "visible", timeout: this.config.timeouts.actionMs }).catch(() => {});
      const result = await this.inspectBlockHistory(frame);
      if (result.status === "succeeded") {
        const recordId = await result.card.getAttribute("data-id").catch(() => "");
        markHistoryMatched(this.state.block, recordId);
        this.state.block.generation.generation_status = "succeeded";
        this.state.block.generation.generated_at ||= new Date().toISOString();
        await this.persist();
        return { frame, card: result.card, insert: result.insert };
      }
      await this.closeBlockDialog(frame);
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, deadline - Date.now())));
    }
    throw new Error("静态图文生成记录在关闭并重新打开后仍未成功");
  }

  async applyBlockFromHistory(frame, insert) {
    const section = this.state.block;
    const before = await this.aiBlockCount();
    if (before !== 0) throw new Error(`区块记录复用测试页不是空白页：应用前已有 ${before} 个 AI 区块`);
    section.block_count_before = before;
    section.generation.application_status = "applying";
    section.history.application_source = "history";
    await this.persist();
    await insert.click({ force: true });
    const next = await waitFor(async () => {
      const module = await firstVisible([
        frame.getByText("应用模块", { exact: true }).first(),
        frame.locator("button").filter({ hasText: "应用模块" }).first(),
      ]);
      if (module && await module.isEnabled().catch(() => false)) return { mode: "module", control: module };
      const apply = frame.locator(this.config.selectors.aiApplySelector).filter({ hasText: /^应用$/ }).first();
      if (await visible(apply) && await apply.isEnabled().catch(() => false)) return { mode: "apply", control: apply };
      return false;
    }, this.config.timeouts.blockRenderMs, "静态图文历史记录插入", 250);
    if (next.mode === "module") await next.control.click({ force: true });
    const apply = frame.locator(this.config.selectors.aiApplySelector).filter({ hasText: /^应用$/ }).first();
    await this.blockBase.waitForAiControlReady(frame, apply, "AI 应用按钮");
    const saveResponse = this.editor.page.waitForResponse(
      (response) => response.request().method() === "POST" && response.url().includes("/phoenix2/composite/editor/v1/newEditor/savePage"),
      { timeout: this.config.timeouts.blockRenderMs },
    ).catch(() => null);
    await apply.click();
    const response = await saveResponse;
    if (response && !response.ok()) throw new Error(`静态图文历史记录应用接口返回 HTTP ${response.status()}`);
    const after = await waitFor(async () => {
      const value = await this.aiBlockCount();
      return value === before + 1 ? value : false;
    }, this.config.timeouts.blockRenderMs, "静态图文历史记录应用到编辑器", 250);
    section.block_count_after = after;
    assertBlockCountDelta(before, after);
    markHistoryApplied(section);
    await this.persist();
    await this.closeBlockDialog(frame);
    await this.editor.page.waitForTimeout(this.mode.applyIntervalMs);
    section.editor_evidence = await this.editorBlockEvidence();
    section.page.editor_verified = section.editor_evidence.passed;
    if (!section.page.editor_verified) throw new Error("静态图文从生成记录添加后没有可见文本或图片");
    await this.persist();
  }

  async verifyBlockPreview() {
    const section = this.state.block;
    const before = new Set(this.editor.page.context().pages());
    const popupPromise = this.editor.page.context().waitForEvent("page", { timeout: 10000 }).catch(() => null);
    await this.editor.page.locator(".clickToPreview").first().click();
    const preview = await popupPromise ?? this.editor.page.context().pages().find((candidate) => !before.has(candidate));
    if (!preview) throw new Error("点击区块记录复用页预览后没有打开页面");
    try {
      const evidence = await waitFor(async () => {
        const result = renderedBlockEvidence(await renderedPageData(preview), section.editor_evidence);
        return result.passed ? result : false;
      }, this.config.timeouts.blockRenderMs, "区块记录复用预览内容", 500);
      section.preview_evidence = { ...evidence, url: preview.url() };
      section.page.preview_verified = true;
      await this.persist();
    } finally { await preview.close().catch(() => {}); }
  }

  async verifyBlockPublished() {
    const section = this.state.block;
    const publicPage = await this.editor.page.context().newPage();
    try {
      await publicPage.waitForTimeout(this.mode.publishInitialWaitMs);
      const evidence = await waitFor(async () => {
        await publicPage.goto(section.page.publicUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
        const result = renderedBlockEvidence(await renderedPageData(publicPage), section.editor_evidence);
        return result.passed ? result : false;
      }, this.mode.publishTimeoutMs, "区块记录复用公开页内容", this.mode.publishPollIntervalMs);
      section.public_evidence = { ...evidence, url: publicPage.url() };
      section.page.published_verified = true;
      await this.persist();
    } finally { await publicPage.close().catch(() => {}); }
  }

  async runBlock() {
    const section = this.state.block;
    let exists = await this.editor.customPageExists(section.page.name);
    if (!exists) {
      if (section.generation.application_status === "applied") throw new Error("区块状态显示已应用，但测试页面不存在");
      await this.editor.createCustomPage(section.page, { onCreated: async receipt => {
        section.page.creation_receipt = receipt; section.page.create_status = 'created'; await this.persist();
      } });
      section.page.create_status = "created";
      await this.persist();
      exists = true;
    } else {
      await this.editor.openCustomPage(section.page.name);
    }
    const action = historyReuseResumeAction(section, exists, { pageCreatedBeforeGeneration: true });
    if (action === "done") return;
    if (action === "generate") await this.generateBlockRecord();
    if (["generate", "recover-history"].includes(action)) {
      const { frame, insert } = await this.reopenBlockHistory();
      await this.applyBlockFromHistory(frame, insert);
    } else {
      assertHistoryApplicationSource(section);
      const count = await this.aiBlockCount();
      if (count !== 1) throw new Error(`区块记录复用页恢复时检测到 ${count} 个 AI 区块，预期 1 个`);
      section.block_count_after = count;
      section.editor_evidence ||= await this.editorBlockEvidence();
      section.page.editor_verified = section.editor_evidence.passed;
      await this.persist();
    }
    if (!section.page.saved) {
      await this.editor.savePage();
      section.page.saved = true;
      await this.persist();
    }
    if (!section.page.preview_verified) await this.verifyBlockPreview();
    if (!section.page.published_verified) {
      if (section.page.publish_status === "running") throw new Error("区块记录复用的上次发布状态不确定，请先检查公开页");
      if (section.page.publish_status !== "accepted") {
        section.page.publish_status = "running";
        await this.persist();
        await this.editor.publishSite();
        section.page.publish_status = "accepted";
        await this.persist();
      }
      await this.verifyBlockPublished();
    }
    section.page.failure_reason = "";
    await this.persist();
  }

  async run({ sections = ['full_page', 'block'] } = {}) {
    if (!sections.length || new Set(sections).size !== sections.length || sections.some(key => !['full_page', 'block'].includes(key))) {
      throw new Error('生成记录复用目标无效，拒绝扩大执行范围');
    }
    await this.initialize();
    const failures = [];
    for (const [key, action] of [['full_page', () => this.runFullPage()], ['block', () => this.runBlock()]]) {
      if (!sections.includes(key)) continue;
      try { await action(); }
      catch (error) {
        const active = this.state[key].page;
        active.failure_reason = error.message;
        const screenshot = path.join(this.paths.root, `${key}-failure-${Date.now()}.png`);
        if (await this.editor.page.screenshot({ path: screenshot }).then(() => true).catch(() => false)) active.failure_screenshot = screenshot;
        await this.persist();
        if (isGlobalSafetyFailure(error.message)) throw error;
        failures.push(`${key === 'full_page' ? '整页' : '区块'}记录复用：${error.message}`);
        if (key === 'full_page' && sections.includes('block')) {
          // Leave the failed loading page untouched: no refresh/save while
          // its AI content may still be loading. Continue in a fresh tab.
          const nextPage = await this.editor.page.context().newPage();
          nextPage.setDefaultTimeout(this.config.timeouts.actionMs);
          nextPage.setDefaultNavigationTimeout(this.config.timeouts.blockRenderMs);
          this.editor.page = nextPage;
          await this.editor.goto();
        }
      }
    }
    if (failures.length) throw new Error(failures.join('；'));
    return this.state;
  }

  async cleanup() {
    await this.initialize();
    let changed = false;
    for (const section of [this.state.block, this.state.full_page]) {
      if (!section.page.name.endsWith(this.runId)) throw new Error("测试页面名称缺少运行 ID，拒绝清理");
      if (section.page.cleanup_status === "completed") continue;
      if (await this.editor.customPageExists(section.page.name)) {
        const deleted = await this.editor.deleteCustomPage(section.page.name, { apply: true });
        if (!deleted.applied || await this.editor.customPageExists(section.page.name)) throw new Error(`页面 ${section.page.name} 删除后仍存在`);
        changed = true;
      }
      section.page.cleanup_status = "completed";
      section.page.cleaned_at = new Date().toISOString();
      await this.persist();
    }
    if (changed) await this.editor.publishSite();
    return this.state;
  }
}
