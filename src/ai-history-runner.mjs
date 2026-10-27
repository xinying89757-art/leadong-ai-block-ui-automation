import { NewFlowAutomation, wait, visible } from './ai-new-flow-runner.mjs';
import { fillAndVerify } from './wait-utils.mjs';
import { readHistoryCards } from './ai-history-reuse-runner.mjs';
import { parseHistoryBadge, assertHistoryIncrement } from './ai-new-flow-state.mjs';
import { parseGenerationHistoryRecord, assertHistoryRecords, selectRecoverableFailure, continuationOutcome } from './ai-history-state.mjs';

export class AiHistoryAutomation extends NewFlowAutomation {
  constructor(editor, config, runId) { super(editor, config, runId, 'history'); }
  async openHistory({ refresh = false } = {}) {
    if (refresh) {
      await this.base.closeAiResult();
      await this.editor.page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
      await this.editor.openCustomPage(this.state.page.name); await this.assertOwnedIdentity();
    }
    const frame = await this.base.openAiDialog();
    const trigger = frame.locator(this.config.selectors.aiHistoryTriggerSelector);
    if (!String(await trigger.getAttribute('class')).includes('active')) await trigger.click();
    await frame.locator(this.config.selectors.aiHistoryCardSelector).first().waitFor({state:'visible',timeout:15000});
    return frame;
  }
  async count(frame) { return parseHistoryBadge(await frame.locator(this.config.selectors.aiHistoryTriggerSelector).innerText()); }
  async readAll(frame) {
    const records = [], seen = new Set(); let unchanged = 0;
    const total = await this.count(frame);
    for (let page = 0; page < 60; page++) {
      const cards = await readHistoryCards(frame, this.config);
      const before = records.length;
      for (const {text,id} of cards) {
        const record = parseGenerationHistoryRecord(text,id), key = id || `${record.timestamp}:${record.prompt}`;
        if (!seen.has(key)) { records.push(record); seen.add(key); }
      }
      if (records.length >= total) break;
      unchanged = before === records.length ? unchanged + 1 : 0;
      if (unchanged >= 3) break;
      await frame.locator(this.config.selectors.aiHistoryCardSelector).last().evaluate(node=>{
        for (let parent=node.parentElement;parent;parent=parent.parentElement) {
          if (parent.scrollHeight>parent.clientHeight+2 && /auto|scroll/.test(getComputedStyle(parent).overflowY)) {
            parent.scrollTop=parent.scrollHeight;parent.dispatchEvent(new Event('scroll'));return;
          }
        }
      });
      await this.editor.page.waitForTimeout(1000);
    }
    if (records.length !== total) throw new Error(`History pagination incomplete: loaded ${records.length} of badge ${total}`);
    return records;
  }
  async matchingCard(frame, record) {
    for (let attempt=0;attempt<60;attempt++) {
      const cards = await readHistoryCards(frame,this.config);
      const found = cards.filter(({text,id})=> record.id ? id===record.id : text.includes(record.prompt)&&text.includes(record.timestamp));
      if (found.length>1) throw new Error('History record identity ambiguous');
      if (found.length===1) return found[0].card;
      await frame.locator(this.config.selectors.aiHistoryCardSelector).last().scrollIntoViewIfNeeded();
      await this.editor.page.waitForTimeout(500);
    }
    throw new Error('Selected history record not found');
  }
  async generateOwned(step) {
    let frame;
    if (step.generation_status==='pending') {
      frame=await this.base.openAiDialog(); await this.prepare(frame,this.mode.mode);
      step.history_before=await this.count(frame);
      step.prompt=`Create an English static image-and-text solar block with the exact heading "${step.token}" and a Learn More button.`;
      await fillAndVerify(frame.locator(this.config.selectors.aiPromptSelector).first(),step.prompt);
      await this.startCharge(frame,step,'generate');
      step.generation_status='running';await this.persist();
      await this.base.submitBlockGeneration(frame,frame.locator(this.config.selectors.aiGenerateSelector),step.prompt,step);
      const result=await this.base.waitForGeneration(frame,step.prompt,step.history_before,this.mode.generationTimeoutMs,step);
      frame=result.frame??frame;step.generation_status='succeeded';await this.persist();
      await this.charge(frame,step,'generate',this.generationMode(this.mode.mode).expectedCost);
    } else {
      frame=await this.openHistory({refresh:true});
      const card=frame.locator(this.config.selectors.aiHistoryCardSelector).filter({hasText:step.prompt});
      await wait(async()=>await card.count()===1&&(await card.innerText()).includes('已完成'),this.mode.generationTimeoutMs,'Owned history generation has not completed');
      step.generation_status='succeeded';
      if (!step.charges[0].passed) await this.charge(frame,step,'generate',this.generationMode(this.mode.mode).expectedCost);
    }
    frame=await this.openHistory({refresh:true});
    step.history_after=await this.count(frame);assertHistoryIncrement(step.history_before,step.history_after);
    await this.shot('generation-history-increment',step);step.status='passed';await this.persist();
  }
  async inspectRecords(step, generated) {
    const frame=await this.openHistory({refresh:true});
    step.records=await this.readAll(frame);
    assertHistoryRecords(step.records,this.config.ai.generationModes);
    const own=step.records.filter(record=>record.prompt===generated.prompt);
    if (own.length!==1||own[0].status!=='completed') throw new Error('Own completed history row not unique');
    step.owned_record=own[0];step.row_count=step.records.length;step.order_verified=true;
    await this.shot('history-records-badges-and-order',step);step.status='passed';await this.persist();
  }
  async verifyCommittedContent(step, id) {
    // A new wrapper and cleared overlay confirm the owned-page insertion.
    // Persist through the ordinary toolbar, then assert actual rendered content
    // after a full reload, rather than relying on the in-memory editor alone.
    await this.assertOwnedIdentity();
    step.save_policy='Save the confirmed new owned wrapper, reload, then assert its heading';
    try { step.save_evidence=await this.editor.savePage(); }
    catch (error) { step.save_evidence={warning:error.message}; }
    await this.shot('history-insert-after-toolbar-save',step);
    await this.editor.page.reload({waitUntil:'domcontentloaded',timeout:60000});
    await this.editor.openCustomPage(this.state.page.name);await this.assertOwnedIdentity();
    await this.waitToken(id,step.content_token ?? step.token);
    step.saved=true;step.reopen_verified=true;
    return true;
  }
  async insertOwned(step, generated, records) {
    if (step.application_status==='applying') await this.finishCommit(step);
    else if (step.application_status!=='applied') {
      const frame=await this.openHistory({refresh:true});
      const card=await this.matchingCard(frame,records.owned_record);
      // Tokens in persisted state remain deterministic; use the generation token
      // only as the expected content token during the shared commit operation.
      step.content_token=generated.token;
      step.points_before=await this.points.read(frame);step.baseline=await this.snapshot();
      step.insertion_started_at=new Date().toISOString();await this.persist();await this.assertOwnedIdentity();
      this.pendingResult={mode:'history',frame,control:card.getByRole('button',{name:/插入/})};
      await this.shot('owned-history-insert',step);
      await this.fullscreen(frame,step);await this.applyNew(frame,step);
    }
    if (!step.saved) {
      await this.waitToken(step.committed_block_id,generated.token);
      step.save_evidence=await this.editor.savePage();step.saved=true;await this.persist();
    }
    const frame=await this.base.openAiDialog();
    step.points_after=await this.points.read(frame);
    if (step.points_before!==step.points_after) throw new Error('History insertion charged extra credits');
    await this.creditShot(frame,'history-insertion-no-charge',step,step.points_after);
    await this.base.closeAiResult();
    await this.editor.page.reload({waitUntil:'domcontentloaded',timeout:60000});
    await this.editor.openCustomPage(this.state.page.name);await this.waitToken(step.committed_block_id,generated.token);
    step.reopen_verified=true;step.status='passed';await this.shot('inserted-owned-history-canvas',step);await this.persist();
  }
  async continueFailed(step, records) {
    const frame=await this.openHistory({refresh:true});
    const currentRecords=await this.readAll(frame);
    const candidate=step.record??selectRecoverableFailure(currentRecords);
    if (!candidate) {
      step.status='skipped';step.skip_reason='skipped: no failed record available';
      step.details='Inspected all loaded history rows. No genuine recoverable combo failure exists; no synthetic failure or response interception used.';
      await this.persist();return;
    }
    const card=await this.matchingCard(frame,candidate);
    await this.assertOwnedIdentity();
    step.scope_evidence={page:this.state.page.name,page_id:this.state.page.creation_receipt.id,action:'generation continuation only; no existing page insertion or publish'};
    step.record=candidate;
    if (!step.continuation_started_at) {
      step.points_before=await this.points.read(frame);step.history_before=await this.count(frame);step.baseline=await this.snapshot();
      await card.scrollIntoViewIfNeeded();
      step.continuation_started_at=new Date().toISOString();step.generation_status='running';await this.persist();
      await this.shot('failed-row-before-continue',step);
      await card.getByRole('button',{name:'继续生成',exact:true}).click();
      step.clicked=true;step.continue_loading_observed=await card.getByRole('button',{name:'继续生成',exact:true}).isDisabled().catch(()=>false);await this.shot('immediately-after-continue',step);await this.persist();
    }
    // Keep the client orchestration alive. Closing/reloading a composite job
    // while it runs can abandon its recoverable composition progress.
    let resultAppeared=false;
    if (!step.result_appeared) {
      await wait(async()=>{
        const result=frame.getByRole('button',{name:/^应用(?:模块|区块)$/});
        if (await visible(result) && await result.isEnabled()) {
          resultAppeared=true;step.result_appeared=true;step.resume_verified=true;
          await this.shot('continued-result-appeared',step);return true;
        }
        const sourceCard=frame.locator(this.config.selectors.aiHistoryCardSelector).filter({hasText:candidate.timestamp}).filter({hasText:candidate.prompt});
        const continueButton=sourceCard.getByRole('button',{name:'继续生成',exact:true});
        if (await visible(continueButton)) {
          if (await continueButton.isDisabled()) step.continue_loading_observed=true;
          else if (step.continue_loading_observed && step.resume_verified) {
            step.terminal_error='Continuation resumed, then returned to the same recoverable 生成失败 record';
            await this.shot('continuation-returned-failed',step);return true;
          }
        }
        const text=await frame.locator('body').innerText();
        if (/AI正在生成|正在生成区块|生成中/.test(text)) {
          if (!step.resume_verified) await this.shot('continuation-in-progress',step);
          step.resume_verified=true;step.progress_observed=true;await this.persist();
        }
        const errors=await frame.locator('.el-message--error:visible,.el-notification--error:visible,[role="alert"]:visible').allInnerTexts();
        if (step.resume_verified && errors.some(message=>/失败|错误/.test(message))) {
          step.terminal_error=errors.join(' ').slice(0,500);return true;
        }
        const historyActive=String(await frame.locator(this.config.selectors.aiHistoryTriggerSelector).getAttribute('class')).includes('active');
        const rows=historyActive ? await readHistoryCards(frame,this.config) : [];
        if (rows.length) {
          let parsed;
          try { parsed=rows.map(({text,id})=>parseGenerationHistoryRecord(text,id)); }
          catch (error) { step.transient_history_parse_error=error.message;return false; }
          const outcome=continuationOutcome(parsed,candidate,step.continuation_started_at);
          if (outcome?.resumed) {
            step.resume_verified=true;
            if (['completed','failed'].includes(outcome.record.status)) return true;
          }
        }
        return false;
      },this.mode.continuationTimeoutMs ?? this.mode.generationTimeoutMs,'Continuation did not reach a usable result or terminal record within the bounded wait');
    }
    const trigger=frame.locator(this.config.selectors.aiHistoryTriggerSelector);
    if (!String(await trigger.getAttribute('class')).includes('active')) await trigger.click();
    const current=await this.readAll(frame);
    const outcome=continuationOutcome(current,candidate,step.continuation_started_at);
    step.resumed_record=outcome?.record??null;step.continuation_source=outcome?.source??'result-view';
    step.history_after=await this.count(frame);
    if (step.history_before!==undefined && outcome?.source==='new-continuation-record') assertHistoryIncrement(step.history_before,step.history_after);
    step.points_after=await this.points.read(frame);step.points_charged=step.points_before-step.points_after;
    await this.creditShot(frame,'continue-generation-credits',step,step.points_after);
    await this.assertOwnedIdentity();step.after_snapshot=await this.snapshot();
    await this.shot('continuation-result-and-history',step);
    step.generation_status=step.result_appeared?'result-visible':outcome?.record.status??'resumed';
    if (!step.resume_verified) throw new Error('Continuation did not resume');
    if (step.terminal_error) {
      this.state.product_observations ??= [];
      this.state.product_observations.push({kind:'continued-generation-failed-again',step:step.key,error:step.terminal_error,screenshot:step.evidence.at(-1)});
    }
    step.status='passed';await this.persist();
  }
  async run() {
    await this.ownPage();
    const [generation,records,insertion,continuation]=this.state.steps;
    // The insert step keeps its deterministic identity token; shared operations
    // accept a separate expected heading without changing the state identity.
    for (const step of this.state.steps) {
      if (['passed','skipped'].includes(step.status)) continue;
      this.activeStep=step;step.status='running';step.failure_reason='';await this.persist();
      try {
        if (step===generation) await this.generateOwned(step);
        else if (step===records) await this.inspectRecords(step,generation);
        else if (step===insertion) await this.insertOwned(step,generation,records);
        else await this.continueFailed(step,records);
      } catch (error) {
        step.status='failed';step.failure_reason=error.message;
        if (step===continuation && step.continuation_started_at) {
          if (step.generation_status==='running') step.generation_status='uncertain';
          // Preserve final credit evidence before closing the in-flight UI.
          try {
            await this.assertOwnedIdentity();
            const ui=this.base.aiFrame();
            step.points_after=await this.points.read(ui);step.points_charged=step.points_before-step.points_after;
            await this.creditShot(ui,'continuation-timeout-credits',step,step.points_after);
          } catch(captureError) {step.failure_credit_capture=captureError.message;}
        }
        await this.shot(`${step.key}-failure`,step).catch(()=>{});await this.persist();
        if (step===generation || step===records || /ownership|identity|collision|receipt|ambiguous|authentication/i.test(error.message)) throw error;
        await this.base.closeAiResult().catch(()=>{});
      }
    }
    const failed=this.state.steps.filter(step=>!['passed','skipped'].includes(step.status));
    if (failed.length) throw new Error(failed.map(step=>`${step.key}: ${step.failure_reason}`).join('; '));
    await this.base.closeAiResult();return this.complete();
  }
}
