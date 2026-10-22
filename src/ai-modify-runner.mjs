import { NewFlowAutomation, visible, wait } from './ai-new-flow-runner.mjs';
import { assertModification, resumeStepAction } from './ai-modify-state.mjs';
import { fillAndVerify } from './wait-utils.mjs';
export class AiModifyAutomation extends NewFlowAutomation {
  constructor(editor, config, runId) { super(editor, config, runId, 'modify'); }
  async openModify(id) {
    await this.assertOwnedIdentity();
    const { frame, block } = await this.block(id);
    await block.scrollIntoViewIfNeeded();
    const box = await block.boundingBox();
    if (!box) throw new Error('Owned block has no canvas bounds');
    // The AI mask deliberately intercepts Locator.hover/click on the section.
    // A native pointer selects that mask and reveals its actual toolbar.
    await this.editor.page.mouse.move(box.x + Math.min(40, box.width / 2), box.y + Math.min(40, box.height / 2));
    await this.editor.page.mouse.click(box.x + Math.min(40, box.width / 2), box.y + Math.min(40, box.height / 2));
    const wrapperId = await block.evaluate(node => node.closest('.siteblocks-setting-wrap, .backstage-blocksEditor-wrap')?.id || '');
    if (!wrapperId) throw new Error('Owned AI block wrapper missing');
    const controls = frame.locator('.ai-block-ai-modify-btn').filter({ visible: true });
    const matching = await wait(async () => {
      for (const control of await controls.all()) if (await control.getAttribute('data-id') === wrapperId) return control;
      return false;
    }, 15000, 'Owned block AI modification toolbar missing');
    await matching.click();
    const ui = await wait(() => this.base.aiFrame(), 15000, 'Modification editor frame missing');
    const input = ui.getByPlaceholder(/描述你想要修改的内容/);
    await input.waitFor({ state: 'visible', timeout: 15000 });
    const chip = await ui.locator('.block-category-trigger').innerText();
    if (!chip.includes('静态图文')) throw new Error('Modification dialog has wrong block type');
    return ui;
  }
  async waitForModification(frame, step) {
    const started = Date.now(); let historyOpened = false;
    return wait(async () => {
      const apply = frame.getByRole('button', { name: '应用区块', exact: true });
      if (!historyOpened && await visible(apply) && await apply.isEnabled()) return { mode: 'module', frame, control: apply };
      if (Date.now() - started < 30000) return false;
      if (!historyOpened) {
        const regenerate = frame.getByRole('button', { name: '重新生成', exact: true });
        if (await visible(apply) && await apply.isDisabled() && await visible(regenerate) && await regenerate.isEnabled()) {
          step.blank_result_screenshot = await this.shot(`${step.key}-blank-disabled-result`, step);
        }
        const trigger = frame.locator(this.config.selectors.aiHistoryTriggerSelector);
        if (!(await trigger.getAttribute('class')).includes('active')) await trigger.click();
        historyOpened = true;
      }
      const cards = frame.locator(this.config.selectors.aiHistoryCardSelector).filter({ hasText: step.prompt });
      const count = await cards.count();
      if (count > 1) throw new Error('Modification history is ambiguous');
      if (!count) return false;
      const text = await cards.innerText();
      if (/生成失败|已自动退还/.test(text)) throw new Error('Platform reported modification generation failure');
      const insert = cards.getByRole('button', { name: /插入/ });
      if (!await visible(insert) || !await insert.isEnabled()) return false;
      step.history_record_text = text;
      step.application_source = 'owned-history';
      if (step.blank_result_screenshot) {
        this.state.product_observations ??= [];
        this.state.product_observations.push({ kind: 'completed-modification-blank-disabled-result', step: step.key,
          screenshot: step.blank_result_screenshot, history_status: text.includes('已完成') ? '已完成' : 'observed' });
      }
      await this.shot(`${step.key}-completed-history`, step);
      return { mode: 'history', frame, control: insert };
    }, this.mode.generationTimeoutMs, 'Modification result did not become usable');
  }
  async modify(step, previous) {
    let frame;
    step.before_block_id ??= previous.committed_block_id;
    step.before_text ??= await (await this.block(step.before_block_id)).block.innerText();
    step.baseline ??= await this.snapshot();
    step.prompt ||= `把标题改成 ${step.token}。Use exactly "${step.token}" as the English heading, remove the old heading "${previous.token}", and preserve the other content in this block.`;
    if (step.generation_status === 'pending') {
      frame = await this.openModify(step.before_block_id);
      this.base.aiConfig.generationMode = this.generationMode(step.key).label;
      await this.base.selectGenerationMode(frame);
      await fillAndVerify(frame.getByPlaceholder(/描述你想要修改的内容/), step.prompt);
      await this.startCharge(frame, step, 'modify');
      step.generation_status = 'running'; await this.persist();
      await frame.getByRole('button', { name: '开始修改', exact: true }).click();
      const generated = await this.waitForModification(frame, step);
      frame = generated.frame ?? frame; this.pendingResult = generated;
      step.generation_status = 'succeeded'; await this.persist();
      await this.charge(frame, step, 'modify', this.generationMode(step.key).expectedCost);
      await this.shot(`${step.key}-modify-result`, step);
    } else {
      frame = await this.openModify(step.before_block_id);
      frame = await this.recoverOwnedHistory(step, frame);
    }
    await this.fullscreen(frame, step);
    step.application_status = 'applying'; await this.persist();
    await frame.locator('.header-container').getByRole('button', { name: '应用', exact: true }).click();
    await this.finishModification(step, previous);
  }
  async finishModification(step, previous) {
    const committed = await wait(async () => {
      const snapshot = await this.snapshot();
      if (!snapshot.ready || snapshot.count !== step.baseline.count || snapshot.ids.length !== 1) return false;
      if (await this.editor.page.locator('.px2-embed-overlay:visible').count()) return false;
      const text = await this.tokenInBlock(snapshot.ids[0], step.token).catch(() => false);
      return text ? { snapshot, text } : false;
    }, this.mode.commitTimeoutMs, 'Modified block did not reach committed canvas');
    assertModification(step.before_text, committed.text, step.token, previous.token);
    step.after_text = committed.text; step.committed_block_id = committed.snapshot.ids[0];
    step.after_snapshot = committed.snapshot; step.application_status = 'applied'; step.editor_verified = true;
    await this.shot(`${step.key}-modified-canvas`, step); await this.persist();
  }
  async run() {
    await this.ownPage();
    for (let index = 0; index < this.state.steps.length; index++) {
      const step = this.state.steps[index], previous = this.state.steps[index - 1];
      const action = resumeStepAction(step); if (action === 'skip') continue;
      this.activeStep = step; step.status = 'running'; step.failure_reason = ''; await this.persist();
      if (action === 'verify-commit') {
        if (!index) await this.finishCommit(step); else await this.finishModification(step, previous);
      } else if (step.application_status !== 'applied') {
        if (!index) {
          const frame = action === 'generate' ? await this.generate(step, 'quick') : await this.recoverOwnedHistory(step); await this.fullscreen(frame, step); await this.applyNew(frame, step);
        } else await this.modify(step, previous);
      }
      if (!index) {
        step.save_evidence = await this.editor.savePage(); step.saved = true;
      } else {
        try { await this.saveAndPreview(step); step.preview_failure = ''; }
        catch (error) { step.preview_failure = error.message; await this.shot(`${step.key}-preview-failure`, step); }
      }
      step.status = step.preview_failure ? 'failed' : 'passed'; await this.persist();
    }
    const failures = this.state.steps.filter(step => step.status !== 'passed');
    if (failures.length) throw new Error(failures.map(step => `${step.key}: ${step.preview_failure || step.failure_reason}`).join('; '));
    return this.complete();
  }
}
