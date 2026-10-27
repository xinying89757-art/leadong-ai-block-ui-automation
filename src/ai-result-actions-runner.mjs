import { NewFlowAutomation, visible, wait } from './ai-new-flow-runner.mjs';
import { isTemporaryAiFrame } from './ai-canvas-commit.mjs';
import { assertDiscardedSnapshot, assertHistoryIncrement, assertPromptPreserved, parseHistoryBadge, resumeStepAction } from './ai-result-actions-state.mjs';
export class AiResultActionsAutomation extends NewFlowAutomation {
  constructor(editor, config, runId) { super(editor, config, runId, 'result-actions'); }
  async historyCount(frame) {
    return parseHistoryBadge(await frame.locator(this.config.selectors.aiHistoryTriggerSelector).innerText());
  }
  async regenerate(frame, step) {
    if (step.regenerated) return;
    const regenerate = frame.getByRole('button', { name: '重新生成', exact: true });
    step.history_before = await this.historyCount(frame);
    await this.startCharge(frame, step, 'regenerate');
    step.regeneration_status = 'running'; await this.persist();
    await regenerate.click();
    // Wait for a new result, rather than accepting the previous result button.
    await wait(async () => /生成中|正在生成/.test(await frame.locator('body').innerText()), 15000, 'Regeneration did not start');
    await wait(async () => {
      const again = frame.getByRole('button', { name: '重新生成', exact: true });
      return await visible(again) && await again.isEnabled();
    }, this.mode.generationTimeoutMs, 'Regeneration did not finish');
    await this.result(frame, { requireEnabled: false });
    step.history_after = await wait(async () => {
      const value = await this.historyCount(frame); return value === step.history_before + 1 ? value : false;
    }, 15000, 'Regeneration did not increment history count');
    assertHistoryIncrement(step.history_before, step.history_after);
    await this.charge(frame, step, 'regenerate', this.generationMode(this.mode.mode).expectedCost);
    step.regenerated = true; step.regeneration_status = 'succeeded'; await this.shot('regenerated', step);
  }
  async returnModify(frame, step) {
    await frame.getByRole('button', { name: '返回修改', exact: true }).click();
    const input = frame.locator(this.config.selectors.aiPromptSelector).first();
    await input.waitFor({ state: 'visible' });
    assertPromptPreserved(step.prompt, await input.inputValue());
    step.return_verified = true; await this.shot('prompt-preserved', step);
    await this.base.closeAiResult();
    const after = await this.snapshot();
    if (JSON.stringify(after.ids) !== JSON.stringify(step.baseline.ids)) throw new Error('Return modification unexpectedly committed a block');
    step.application_status = 'discarded'; await this.persist();
  }
  async changeHeading(step) {
    step.edited_token ??= `${step.token}Edited`;
    await wait(async () => {
      for (const frame of this.editor.page.frames()) {
        if (!isTemporaryAiFrame(frame)) continue;
        const heading = frame.locator('h1,h2,h3,h4').filter({ hasText: step.token }).first();
        if (!await visible(heading)) continue;
        await heading.dblclick();
        const editable = frame.locator('[contenteditable="true"]').filter({ hasText: step.token }).first();
        if (!await visible(editable)) continue;
        await editable.fill(step.edited_token);
        if ((await editable.innerText()).trim() !== step.edited_token) throw new Error('Edited heading was not fully entered');
        await editable.press('Tab');
        return true;
      }
      return false;
    }, 15000, 'Could not edit the generated heading through the UI');
    await this.shot(`${step.key}-edited`, step);
  }
  async exitChanged(frame, step) {
    await frame.locator('.header-container .close-icon-container').click();
    const dialog = frame.getByRole('dialog').filter({ hasText: '内容已更改' });
    await dialog.waitFor({ state: 'visible', timeout: 15000 });
    if (!(await dialog.innerText()).includes('是否应用后再退出')) throw new Error('Missing changed-content confirmation');
    step.confirmation_verified = true; await this.shot(`${step.key}-confirmation`, step);
    if (step.key === 'exit-apply') await this.applyNew(frame, step, { confirmation: true });
    else {
      step.application_status = 'discarding'; await this.persist();
      await dialog.getByRole('button', { name: '退出', exact: true }).click();
      await wait(async () => !await this.editor.page.locator('.px2-embed-overlay:visible').count(), 15000, 'Editor overlay did not close');
      const after = await this.snapshot();
      assertDiscardedSnapshot(step.baseline, after);
      for (const canvas of this.editor.canvasContexts()) if ((await canvas.locator('#backstage-bodyArea').innerText()).includes(step.edited_token)) throw new Error('Discarded edit appeared in the committed canvas');
      step.application_status = 'discarded'; step.discard_verified = true;
      await this.editor.openCustomPage((this.currentPage ?? this.state.page).name);
      const persisted = await this.snapshot();
      assertDiscardedSnapshot(step.baseline, persisted);
      await this.shot(`${step.key}-discarded`, step);
    }
  }
  async recoverGeneration(step) {
    if (step.key === 'return-modify' && !step.return_verified) throw new Error('Return-modify result context was lost before its assertion; refusing an unrecorded duplicate generation');
    const frame = await this.recoverOwnedHistory(step);
    if (step.key === 'regenerate-apply' && !step.regenerated) {
      if (step.regeneration_status === 'running') {
        step.history_after = await this.historyCount(frame);
        assertHistoryIncrement(step.history_before, step.history_after);
        step.regenerated = true; step.regeneration_status = 'succeeded'; await this.persist();
      } else throw new Error('Regeneration was not started before context loss; recovered history cannot prove the result-page button action');
    }
    return frame;
  }
  async run() {
    if (this.state.page.cleanup_status === 'completed') throw new Error('Run was cleaned up');
    for (const step of this.state.steps) {
      this.currentPage = step.page ?? this.state.page;
      const action = resumeStepAction(step); if (action === 'skip') continue;
      this.activeStep = step; step.status = 'running'; step.failure_reason = ''; await this.persist();
      try {
        await this.ownPage();
        if (action === 'verify-discard') {
          assertDiscardedSnapshot(step.baseline, await this.snapshot());
          for (const canvas of this.editor.canvasContexts()) if ((await canvas.locator('#backstage-bodyArea').innerText()).includes(step.edited_token)) throw new Error('Discarded edit persisted');
          step.application_status = 'discarded'; step.discard_verified = true;
        } else if (action === 'verify-commit') await this.finishCommit(step);
        else if (step.application_status !== 'applied' && step.application_status !== 'discarded') {
          const frame = action === 'generate' ? await this.generate(step, this.mode.mode) : await this.recoverGeneration(step);
          if (step.key === 'regenerate-apply') await this.regenerate(frame, step);
          step.baseline ??= await this.snapshot(); await this.persist();
          if (step.key === 'return-modify') {
            await this.returnModify(frame, step); step.status = 'passed'; await this.persist(); continue;
          }
          await this.fullscreen(frame, step);
          if (step.key === 'regenerate-apply') await this.applyNew(frame, step);
          else { await this.changeHeading(step); await this.exitChanged(frame, step); }
        }
        if (step.application_status === 'applied') {
          try { await this.saveAndPreview(step); step.preview_failure = ''; }
          catch (error) { step.preview_failure = error.message; await this.shot(`${step.key}-preview-failure`, step); }
        }
        step.status = step.preview_failure ? 'failed' : 'passed'; await this.persist();
      } catch (error) {
        step.status = 'failed'; step.failure_reason = error.message;
        await this.shot(`${step.key}-failure`, step).catch(() => {}); await this.persist();
        // Isolate independent business failures after generation. Identity,
        // authentication and page-creation failures still stop the run.
        const isolatedBusinessFailure = step.baseline && step.generation_status === 'succeeded' &&
          !/identity|ownership|collision|receipt|ambiguous|authentication|登录|权限/i.test(error.message);
        if (error.code !== 'AI_COMMIT_UNCONFIRMED' && !isolatedBusinessFailure) throw error;
        const nextPage = await this.editor.page.context().newPage();
        this.editor.page = nextPage;
        await this.editor.goto(); this.attach(this.editor);
      }
    }
    this.state.conclusion = this.state.steps.some(step => step.application_status === 'applying')
      ? 'At least one Apply action did not add a committed block within the bounded wait after the overlay cleared. The page is isolated; no repeat Apply or top-level Save was attempted. See commit observations and independent diagnostic evidence.'
      : 'All completed application checks used the committed canvas, excluded temporary AI frames, waited for the overlay, and required exactly one new block with the heading. Preview outcomes are recorded separately.';
    const failedSteps = this.state.steps.filter(step => step.status !== 'passed');
    if (failedSteps.length) throw new Error(failedSteps.map(step => `${step.key}: ${step.preview_failure || step.failure_reason}`).join('; '));
    return this.complete();
  }
}
