import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { AiBlockAutomation } from './ai-runner.mjs';
import { AiDialogPointsReader, parseAvailablePoints } from './ai-points.mjs';
import { fillAndVerify, pollUntil } from './wait-utils.mjs';
import { committedAiSnapshot, isTemporaryAiFrame, waitForAiCommit } from './ai-canvas-commit.mjs';
import { comparePageIdentity } from './page-identity.mjs';
import { assertFlowState, assertCreditDelta, deriveFlowOutcome, flowConfig, flowPaths, readFlowJson, writeFlowJson, renderFlowReport, previewTarget, selectOwnedHistoryRecord } from './ai-new-flow-state.mjs';
import { upgradeHttpUrl, previewFailureStatus } from './network-https-upgrade.mjs';
export const visible = locator => locator.isVisible().catch(() => false);
export const wait = (check, timeoutMs, message) => pollUntil(check, { timeoutMs, intervalMs: 250, message });
export class NewFlowAutomation {
  constructor(editor, config, runId, flow) {
    this.config = config; this.runId = runId; this.flow = flow;
    this.mode = flowConfig(config, flow); this.paths = flowPaths(config, flow, runId);
    this.points = new AiDialogPointsReader(config);
    if (editor) this.attach(editor);
  }
  attach(editor) {
    this.editor = editor;
    this.base = new AiBlockAutomation(editor, { ...this.config, ai: { ...this.config.ai, inputMode: '文字描述', generationMode: '快速模式', promptPolishEnabled: false } });
    this.base.state = { page: { types: [] }, types: [{ type: '静态图文' }] };
    this.base.persist = () => this.persist();
    const closeResult = this.base.closeAiResult.bind(this.base);
    this.base.closeAiResult = async () => {
      const ui = this.base.aiFrame();
      const apply = ui?.getByRole('button', { name: /^应用(?:模块|区块)$/ });
      const regenerate = ui?.getByRole('button', { name: '重新生成', exact: true });
      if (apply && await visible(apply) && await apply.isDisabled() && await visible(regenerate) && await regenerate.isEnabled()) {
        const step = this.activeStep;
        const issue = { kind: 'blank-disabled-result', step: step?.key, observed_at: new Date().toISOString(),
          apply_disabled: true, history_recovery: true };
        this.state.product_observations ??= []; this.state.product_observations.push(issue);
        issue.screenshot = await this.shot('blank-disabled-result', step);
      }
      return closeResult();
    };
    // Retain only allowlisted diagnostics, never request bodies/headers or console text.
    editor.page.on('response', response => {
      if (response.status() >= 400) { const url = new URL(response.url()); this.state.diagnostics.push({ type: 'http', host: url.host, path: url.pathname, status: response.status() }); }
    });
    editor.page.on('pageerror', () => this.state.diagnostics.push({ type: 'pageerror', at: new Date().toISOString() }));
  }
  async initialize({ command = 'run' } = {}) {
    this.state = await readFlowJson(this.paths.state);
    assertFlowState(this.state, this.config, this.flow, this.runId);
    this.state.started_at ||= new Date().toISOString();
    this.command = command;
    if (command === 'cleanup') this.state.verification_result ??= { status: this.state.status, failure_reason: this.state.failure_reason, ended_at: this.state.ended_at, duration_ms: this.state.duration_ms };
    if (['run','resume'].includes(command)) { this.state.status = 'running'; this.state.failure_reason = ''; }
    this.state.attempts ??= [];
    this.state.attempts.push({ command, started_at: new Date().toISOString(), status: 'running' });
    await this.persist();
  }
  async persist() {
    Object.assign(this.state, deriveFlowOutcome(this.state));
    await writeFlowJson(this.paths.state, this.state);
    await mkdir(this.paths.report, { recursive: true });
    await writeFlowJson(path.join(this.paths.report, 'report.json'), this.state);
    await writeFile(path.join(this.paths.report, 'report.md'), renderFlowReport(this.state));
  }
  async shot(label, step) {
    const file = path.join(this.paths.report, `${label}-${Date.now()}.png`);
    await this.editor.page.screenshot({ path: file, timeout: 10000 });
    (step?.evidence ?? this.state.evidence).push(file); await this.persist(); return file;
  }
  async fail(error) {
    if (this.command === 'cleanup') {
      this.state.cleanup_failure = error.message; this.finishAttempt('failed', error.message);
      if (this.editor) await this.shot('cleanup-failure').catch(() => {});
      await this.persist(); return;
    }
    this.state.status = 'failed'; this.state.failure_reason = error.message;
    this.state.ended_at = new Date().toISOString();
    this.state.duration_ms = Date.parse(this.state.ended_at) - Date.parse(this.state.started_at);
    const step = this.state.steps.find(item => item.status === 'running') ?? this.activeStep;
    if (step) {
      step.failure_reason ||= error.message; step.status = 'failed';
      const unresolved = (step.charges ?? []).filter(charge => !charge.passed);
      const frame = this.editor && this.base.aiFrame();
      if (frame && step.points_before !== undefined && step.points_after === undefined) {
        try { step.points_after = await this.points.read(frame); step.points_charged = step.points_before - step.points_after; }
        catch (captureError) { step.failure_credit_capture = captureError.message; }
      }
      if (frame && unresolved.length === 1) {
        const key = this.flow === 'modify' && step.key !== 'seed' ? step.key : this.mode.mode ?? 'quick';
        await this.charge(frame, step, unresolved[0].operation, this.generationMode(key).expectedCost)
          .catch(chargeError => { step.failure_credit_capture = chargeError.message; });
      }
    }
    this.finishAttempt('failed', error.message);
    if (this.editor) await this.shot('failure', step).catch(() => {});
    await this.persist();
  }
  async ownPage() {
    const page = this.currentPage ?? this.state.page;
    if (page.cleanup_status === 'completed') throw new Error('Run was cleaned up');
    const exists = await this.editor.customPageExists(page.name);
    if (!exists) {
      if (page.create_status !== 'pending') throw new Error('Owned page is missing; refusing to recreate');
      page.create_status = 'creating'; await this.persist();
      await this.editor.createCustomPage(page, { onCreated: async receipt => { page.creation_receipt = receipt; page.create_status = 'created'; await this.persist(); } });
    } else {
      if (!page.creation_receipt) throw new Error('Page collision: no creation receipt; refusing to use existing page');
      await this.editor.openCustomPage(page.name);
    }
    await this.assertOwnedIdentity();
  }
  async assertOwnedIdentity() {
    const actual = await this.editor.currentPageIdentity();
    const page = this.currentPage ?? this.state.page;
    const expected = { name: page.name, path: page.path, id: page.creation_receipt?.id };
    if (!comparePageIdentity(expected, actual).matched) throw new Error('Current page does not match owned page');
  }
  snapshot() { return committedAiSnapshot(this.editor.canvasContexts(), { ownedBlankPage: true }); }
  async block(id) {
    const matches = [];
    for (const frame of this.editor.canvasContexts()) {
      if (isTemporaryAiFrame(frame)) continue;
      // Stable IDs originate in the commit snapshot; CSS.escape is applied in the browser.
      const selector = await frame.evaluate(value => `#${CSS.escape(value)}`, id);
      const block = frame.locator(selector);
      if (await block.count() === 1) matches.push({ frame, block });
    }
    if (matches.length !== 1) throw new Error(`Owned block ${id} is not unique in the committed canvas`);
    return matches[0];
  }
  async tokenInBlock(id, token) {
    const { block } = await this.block(id);
    const text = await block.innerText();
    return text.includes(token) ? text : false;
  }
  async waitToken(id, token) {
    return wait(() => this.tokenInBlock(id, token).catch(() => false), this.mode.commitTimeoutMs, `Committed block missing token ${token}`);
  }
  generationMode(key) { return this.config.ai.generationModes.find(item => item.key === key); }
  async prepare(frame, key) {
    await this.base.selectInputMode(frame); await this.base.selectType(frame, '静态图文');
    this.base.aiConfig.generationMode = this.generationMode(key).label;
    await this.base.selectGenerationMode(frame);
  }
  async charge(frame, step, operation, cost) {
    const charge = step.charges.find(item => item.operation === operation);
    if (!charge) throw new Error('Missing pre-charge checkpoint');
    const after = await this.points.waitForCharge(frame, charge.before, cost, { timeoutMs: 30000, intervalMs: 1000 });
    Object.assign(charge, { after, expected_cost: cost, actual_cost: charge.before - after }); await this.persist();
    Object.assign(charge, assertCreditDelta(charge.before, after, cost)); await this.persist();
    await this.creditShot(frame, `${step.key}-${operation}-after-credits`, step, after);
  }
  async startCharge(frame, step, operation) {
    step.charges ??= [];
    if (step.charges.some(item => item.operation === operation)) throw new Error('Refusing duplicate charged operation');
    const before = await this.points.read(frame);
    step.charges.push({ operation, before }); await this.persist();
    await this.creditShot(frame, `${step.key}-${operation}-before-credits`, step, before);
  }
  async creditShot(frame, label, step, expected) {
    const gear = frame.locator('button.ai-settings-trigger');
    const panel = frame.locator('.ai-settings-panel');
    await gear.click();
    try {
      await wait(async () => parseAvailablePoints(await panel.locator('.moli-credit-detail').innerText()) === expected,
        15000, 'Credit screenshot did not match observed balance');
      await this.shot(label, step);
    } finally {
      if (await visible(panel)) await gear.click();
      await panel.waitFor({ state: 'hidden', timeout: 15000 });
    }
  }
  async generate(step, key) {
    const frame = await this.base.openAiDialog(); await this.prepare(frame, key);
    step.prompt ||= `Create an English static image-and-text hero block. Use the exact heading "${step.token}". Include a brief solar energy description and a Learn More button.`;
    await fillAndVerify(frame.locator(this.config.selectors.aiPromptSelector).first(), step.prompt);
    await this.startCharge(frame, step, 'generate');
    step.generation_status = 'running'; await this.persist();
    await this.base.submitBlockGeneration(frame, frame.locator(this.config.selectors.aiGenerateSelector), step.prompt, step);
    const generated = this.flow === 'modify'
      ? await this.base.waitForGeneration(frame, step.prompt, 0, this.mode.generationTimeoutMs, step)
      : (await this.result(frame, { requireEnabled: false }), { frame });
    this.pendingResult = generated;
    const readyFrame = generated.frame ?? frame;
    step.generation_status = 'succeeded'; await this.persist();
    await this.charge(readyFrame, step, 'generate', this.generationMode(key).expectedCost);
    await this.shot(`${step.key}-result`, step); return readyFrame;
  }
  async recoverOwnedHistory(step, frame = null) {
    frame ??= await this.base.openAiDialog();
    const trigger = frame.locator(this.config.selectors.aiHistoryTriggerSelector);
    if (!(await trigger.getAttribute('class')).includes('active')) await trigger.click();
    const cards = frame.locator(this.config.selectors.aiHistoryCardSelector).filter({ hasText: step.prompt });
    const record = await wait(async () => {
      const count = await cards.count();
      if (!count) return false;
      const expected = step.regeneration_status ? 2 : 1;
      if (count < expected) return false;
      const texts = await cards.allInnerTexts();
      const selection = selectOwnedHistoryRecord(texts, expected);
      const selected = { card: cards.nth(selection.index), text: texts[selection.index], timestamp: selection.timestamp };
      const control = selected.card.getByRole('button', { name: /插入/ });
      return await visible(control) && await control.isEnabled() ? { ...selected, control } : false;
    }, this.mode.generationTimeoutMs, 'Owned history result did not complete');
    step.recovered_history_timestamp = record.timestamp;
    step.generation_status = 'succeeded';
    this.pendingResult = { mode: 'history', frame, control: record.control };
    for (const charge of step.charges ?? []) {
      if (charge.passed) continue;
      const key = this.flow === 'modify' && step.key !== 'seed' ? step.key : this.flow === 'modify' ? 'quick' : this.mode.mode;
      await this.charge(frame, step, charge.operation, this.generationMode(key).expectedCost);
    }
    await this.shot(`${step.key}-recovered-history`, step); return frame;
  }
  async result(frame, { requireEnabled = true } = {}) {
    const button = frame.getByRole('button', { name: /^应用(?:模块|区块)$/ });
    await button.waitFor({ state: 'visible', timeout: this.mode.generationTimeoutMs });
    if (requireEnabled) await this.base.waitForAiControlReady(frame, button, '应用模块');
    return button;
  }
  async fullscreen(frame, step) {
    let fromHistory = false;
    if (this.pendingResult?.mode === 'history') {
      await this.pendingResult.control.click(); this.pendingResult = null; fromHistory = true;
    }
    const module = frame.getByRole('button', { name: /^应用(?:模块|区块)$/ });
    if (!fromHistory && await visible(module)) await module.click();
    await frame.locator(this.config.selectors.aiDialogSelector).waitFor({ state: 'hidden', timeout: 15000 });
    const header = frame.locator('.header-container').filter({ hasText: '编辑区块' });
    await header.getByRole('button', { name: '应用', exact: true }).waitFor({ state: 'visible', timeout: 15000 });
    const apply = header.getByRole('button', { name: '应用', exact: true });
    await this.base.waitForAiControlReady(frame, apply, 'Full-screen Apply');
    const stableMs = this.mode.fullscreenStableMs ?? 1000;
    let stableSince = 0, signature = '';
    await wait(async () => {
      let next = '';
      for (const candidate of this.editor.page.frames()) {
        if (!isTemporaryAiFrame(candidate)) continue;
        const heading = candidate.locator('h1,h2,h3,h4').filter({ hasText: step.content_token ?? step.token }).first();
        if (await visible(heading)) { next = await heading.innerText(); break; }
      }
      if (!next || next !== signature) { signature = next; stableSince = Date.now(); return false; }
      return Date.now() - stableSince >= stableMs;
    }, 15000, 'Full-screen generated heading did not stabilize');
    step.fullscreen_evidence = { token: step.content_token ?? step.token, heading: signature, stable_ms: stableMs, apply_ready: true };
    await this.shot(`${step.key}-fullscreen`, step); return header;
  }
  async applyNew(frame, step, { confirmation = false } = {}) {
    step.baseline ??= await this.snapshot();
    step.application_status = 'applying'; await this.persist();
    await this.assertOwnedIdentity(); await this.shot(`${step.key}-before-apply`, step);
    const apply = confirmation
      ? frame.getByRole('dialog').filter({ hasText: '内容已更改' }).getByRole('button', { name: '应用', exact: true })
      : frame.locator('.header-container').getByRole('button', { name: '应用', exact: true });
    await apply.click(); await this.shot(`${step.key}-just-after-apply`, step); await this.finishCommit(step);
  }
  async finishCommit(step) {
    const observations = []; const started = Date.now();
    let committed;
    try { committed = await waitForAiCommit(async () => {
      const snapshot = await this.snapshot();
      const overlay = await this.editor.page.locator('.px2-embed-overlay:visible').count();
      const value = { ...snapshot, overlay_visible: overlay > 0, ready: snapshot.ready && !overlay };
      step.last_commit_observation = value;
      if (observations.length < 100) observations.push({ elapsed_ms: Date.now() - started, ...value });
      return value;
    }, step.baseline, { timeoutMs: this.mode.commitTimeoutMs });
    } catch (error) {
      if (error.code === 'AI_COMMIT_UNCONFIRMED') {
        this.state.product_observations ??= [];
        const observation = { kind: 'direct-apply-missing-block', step: step.key, observed_at: new Date().toISOString(),
          baseline: step.baseline, last_observation: step.last_commit_observation };
        this.state.product_observations.push(observation);
        observation.screenshot = await this.shot(`${step.key}-missing-block`, step);
        try {
          await this.editor.openCustomPage((this.currentPage ?? this.state.page).name);
          await this.assertOwnedIdentity();
          observation.reopened_snapshot = await wait(async () => {
          const value = await this.snapshot(); return value.ready ? value : false;
        }, 15000, 'Missing-block diagnostic canvas did not load').catch(() => null);
          observation.reopened_screenshot = await this.shot(`${step.key}-missing-block-reopened`, step);
        } catch (diagnosticError) { observation.diagnostic_error = diagnosticError.message; }
      }
      throw error;
    } finally {
      step.commit_wait_ms = Date.now() - started;
      observations.push({ elapsed_ms: step.commit_wait_ms, ...step.last_commit_observation });
      step.commit_observations = observations; await this.persist();
    }
    step.commit_observations = observations; step.committed_block_id = committed.addedId;
    await this.verifyCommittedContent(step, committed.addedId);
    step.application_status = 'applied'; step.editor_verified = true;
    await this.shot(`${step.key}-committed`, step); await this.persist();
  }
  async verifyCommittedContent(step, id) {
    return this.waitToken(id, step.edited_token ?? step.content_token ?? step.token);
  }
  async saveAndPreview(step, token = step.edited_token ?? step.content_token ?? step.token) {
    await this.assertOwnedIdentity();
    try { step.save_evidence = await this.editor.savePage(); }
    catch (error) {
      // AI Apply saves immediately; a clean Save button may emit no response.
      await this.editor.openCustomPage((this.currentPage ?? this.state.page).name);
      await this.waitToken(step.committed_block_id, token);
      step.save_evidence = { evidence: 'reopen', warning: error.message };
    }
    step.saved = true; await this.persist();
    await this.editor.openCustomPage((this.currentPage ?? this.state.page).name);
    await this.waitToken(step.committed_block_id, token);
    step.reopen_verified = true; await this.shot(`${step.key}-saved-reopened`, step);
    step.assertions_passed = true;
    const link = this.editor.page.locator('.clickToPreview a').first();
    const href = await link.getAttribute('href');
    let target = upgradeHttpUrl(previewTarget(href, this.editor.page.url()), this.config.network?.httpsUpgradeHosts);
    step.preview_target = target;
    let downgradeLoop = false;
    // First try the HTTPS form of the final redirect destination directly.
    // The context shim remains available for HTTP resources or later hops.
    if (this.config.network?.httpsUpgradeHosts?.length) {
      const response = await this.editor.page.context().request.get(target, { maxRedirects: 0, timeout: this.mode.commitTimeoutMs });
      try {
        const location = response.headers().location;
        if (response.status() >= 300 && response.status() < 400 && location) {
          const redirected = new URL(location, target).href;
          const upgraded = upgradeHttpUrl(redirected, this.config.network.httpsUpgradeHosts);
          if (upgraded !== redirected) {
            downgradeLoop = upgraded === target;
            target = upgraded;
            step.preview_direct_https = { status: response.status(), host: new URL(target).host, path: new URL(target).pathname };
          }
        }
      } finally { await response.dispose(); }
    }
    // Read the editor's own preview link in a dedicated tab. The legacy
    // toolbar suppresses native popup navigation in some headless sessions.
    const preview = await this.editor.page.context().newPage();
    const navigationUrls = [];
    preview.on('request', request => { if (request.isNavigationRequest()) navigationUrls.push(request.url()); });
    try {
      if (downgradeLoop) throw Object.assign(new Error('HTTPS preview redirects to the same HTTP URL; port 80 is blocked in this environment and the HTTPS upgrade would loop.'), { code: 'HTTPS_UPGRADE_DOWNGRADE_LOOP' });
      await preview.goto(target, { waitUntil: 'domcontentloaded', timeout: this.mode.commitTimeoutMs });
      await wait(async () => {
        for (const frame of preview.frames()) {
          if ((await frame.locator('body').innerText().catch(() => '')).includes(token)) return true;
        }
        return false;
      }, this.mode.commitTimeoutMs, `Preview missing ${token}`);
      const file = path.join(this.paths.report, `${step.key}-preview.png`);
      await preview.screenshot({ path: file }); step.evidence.push(file); step.preview_verified = true; step.preview_status = 'passed';
    } catch (error) {
      const failedUrls = [preview.url(), target, ...navigationUrls];
      step.preview_status = previewFailureStatus(error, failedUrls);
      step.preview_message = step.preview_status === 'blocked-environment' ? error.code === 'HTTPS_UPGRADE_DOWNGRADE_LOOP' ? error.message : 'HTTP preview navigation timed out: this environment blocks outbound TCP port 80. Enable LEADONG_HTTPS_UPGRADE_HOSTS for the preview host.' : error.message;
      step.preview_failure_details = { host: new URL(target).host, path: new URL(target).pathname, error: error.message };
      const file = path.join(this.paths.report, `${step.key}-preview-unavailable.png`);
      if (await preview.screenshot({ path: file, timeout: 5000 }).then(() => true).catch(() => false)) step.evidence.push(file);
      await this.persist(); throw error;
    } finally { await preview.close(); }
    await this.persist();
  }
  async cleanup() {
    assertFlowState(this.state, this.config, this.flow, this.runId);
    const pages = [this.state.page, ...this.state.steps.map(step => step.page).filter(Boolean)];
    for (const page of pages) {
      this.currentPage = page;
      if (page.cleanup_status === 'completed') continue;
      if (!page.creation_receipt) {
        if (page.create_status !== 'pending') throw new Error('Ambiguous creation without receipt; refusing cleanup');
        page.cleanup_status = 'completed'; await this.persist(); continue;
      }
      if (await this.editor.customPageExists(page.name)) {
        await this.editor.openCustomPage(page.name); await this.assertOwnedIdentity();
        const deleted = await this.editor.deleteCustomPage(page.name, { apply: true });
        if (!deleted.applied) throw new Error('Owned page deletion unconfirmed');
        await wait(async () => !await this.editor.customPageExists(page.name), 15000, 'Owned page deletion unconfirmed');
      }
      page.cleanup_status = 'completed'; await this.persist();
    }
    this.finishAttempt('passed'); await this.persist();
  }
  finishAttempt(status, failure = '') {
    const attempt = this.state.attempts?.at(-1);
    if (attempt) Object.assign(attempt, { status, failure, ended_at: new Date().toISOString(), duration_ms: Date.now() - Date.parse(attempt.started_at) });
  }
  async complete() {
    this.state.status = 'passed'; this.state.ended_at = new Date().toISOString();
    this.state.duration_ms = Date.parse(this.state.ended_at) - Date.parse(this.state.started_at);
    this.state.failure_reason = ''; this.finishAttempt('passed'); await this.persist(); return this.state;
  }
}
