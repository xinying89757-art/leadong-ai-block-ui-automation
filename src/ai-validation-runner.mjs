import path from 'node:path';
import {NewFlowAutomation,wait,visible} from './ai-new-flow-runner.mjs';
import {resolveProjectPath} from './config.mjs';
import {fillAndVerify} from './wait-utils.mjs';
import {parseHistoryBadge} from './ai-new-flow-state.mjs';
import {assertNoChargeEvidence,parseUsageRecord,selectMatchingUsageRecord,usageRecordsFallbackUrl} from './ai-validation-state.mjs';
import {writeOversizePng} from './validation-fixtures.mjs';

export class AiValidationAutomation extends NewFlowAutomation {
  constructor(editor,config,runId) {super(editor,config,runId,'validation');}
  async freshForm(inputMode='文字描述') {
    await this.base.closeAiResult();
    await this.ownPage();
    let frame=await this.base.openAiDialog();
    try {await this.assertOwnedIdentity();} catch {
      await this.base.closeAiResult();await this.ownPage();frame=await this.base.openAiDialog();await this.assertOwnedIdentity();
    }
    this.base.aiConfig.inputMode='文字描述';await this.prepare(frame,this.mode.mode);
    this.base.aiConfig.inputMode=inputMode;await this.base.selectInputMode(frame);
    await wait(async()=>!await frame.locator('.el-message--error:visible,.el-notification--error:visible').count(),5000,'Previous validation toast did not close').catch(()=>{});
    return frame;
  }
  async observation(frame) {
    return {points:await this.points.read(frame),history:parseHistoryBadge(await frame.locator(this.config.selectors.aiHistoryTriggerSelector).innerText())};
  }
  async messages(frame) {
    return (await frame.locator('.el-message:visible,.el-form-item__error:visible,[role="alert"]:visible,.upload-error:visible,.error-text:visible').allInnerTexts()).join(' ').slice(0,1000);
  }
  async fileState(frame) {
    const input=frame.locator(this.config.selectors.aiUploadFileSelector).first();
    const thumbnails=frame.locator(`${this.config.selectors.aiUploadPreviewSelector},img[src^="blob:"]`);
    let thumbnailsVisible=0;for(const item of await thumbnails.all())if(await visible(item))thumbnailsVisible++;
    return {file_count:await input.count()?await input.evaluate(element=>element.files?.length??0):0,thumbnail_count:thumbnailsVisible,generate_disabled:await frame.locator(this.config.selectors.aiGenerateSelector).isDisabled()};
  }
  async checkInput(step) {
    if (step.unexpected_generation && step.generation_status !== 'pending') throw new Error('This invalid input already triggered a generation; resume will not repeat its charged operation. See the recorded request, balance and history evidence.');
    const image=['gif','bmp','oversize','valid-png'].includes(step.key),url=step.key.startsWith('invalid-url-');
    const frame=await this.freshForm(image?'上传图片':url?'提供网址':'文字描述');
    step.scope_before=await this.editor.currentPageIdentity();await this.assertOwnedIdentity();
    step.before=await this.observation(frame);step.points_before=step.before.points;step.history_before=step.before.history;
    step.input_prompt=`Validation ${this.runId} ${step.key}: Create an English solar company hero block.`;
    await this.creditShot(frame,`${step.key}-before-credits`,step,step.points_before);
    const requests=[];
    const onRequest=request=>{
      const payload=request.postData()??'';
      if(request.method()==='POST'&&/generat/i.test(new URL(request.url()).pathname)&&(step.key==='empty-prompt'||payload.includes(step.input_prompt)||payload.includes(JSON.stringify(step.input_prompt).slice(1,-1)))) {
        requests.push({path:new URL(request.url()).pathname,at:new Date().toISOString()});
      }
    };
    this.editor.page.on('request',onRequest);
    let rejected=false;
    try {
      const generate=frame.locator(this.config.selectors.aiGenerateSelector);
      if(image) {
        await fillAndVerify(frame.locator(this.config.selectors.aiPlainPromptSelector).first(),step.input_prompt);
        let file;
        if(step.key==='oversize') {
          step.runtime_fixture=await writeOversizePng(resolveProjectPath(`tmp/validation/${this.runId}/oversize.png`));file=step.runtime_fixture.file;
        } else file=resolveProjectPath(step.key==='valid-png'?'fixtures/images/test-image.png':`fixtures/validation/tiny.${step.key}`);
        step.fixture=file;
        await frame.locator(this.config.selectors.aiUploadFileSelector).first().setInputFiles(file);
        await this.editor.page.waitForTimeout(1000);
        if(step.key==='valid-png') {
          await wait(async()=>{
            const state=await this.fileState(frame);return state.thumbnail_count>0||state.file_count>0&&!state.generate_disabled;
          },30000,'Valid PNG was not accepted');
          step.file_state=await this.fileState(frame);step.accepted=true;
        } else {
          rejected=await wait(async()=>{
            step.validation_message=await this.messages(frame);step.file_state=await this.fileState(frame);
            return /格式|类型|大小|5\s*M|JPG|PNG|WEBP|不支持|超过|too large|unsupported/i.test(step.validation_message);
          },5000,'No explicit upload rejection').catch(()=>false);
          if(!rejected) {
            step.file_state=await this.fileState(frame);
            rejected=step.file_state.file_count===0&&step.file_state.thumbnail_count===0;
          }
        }
      } else {
        if(url) {
          const values={'invalid-url-text':'not a url','invalid-url-ftp':'ftp://x','invalid-url-host':'http://'};
          step.input_url=values[step.key];await frame.locator(this.config.selectors.aiUrlSelector).fill(step.input_url);
          await fillAndVerify(frame.locator(this.config.selectors.aiPlainPromptSelector).first(),step.input_prompt);
          await frame.locator(this.config.selectors.aiUrlSelector).press('Tab');
        } else await frame.locator(this.config.selectors.aiPromptSelector).first().fill('');
        step.generate_disabled=await generate.isDisabled();
        step.validation_message=await this.messages(frame);
        if(!step.generate_disabled&&!step.validation_message) {
          await generate.click();await this.editor.page.waitForTimeout(1500);
          step.validation_message=await this.messages(frame);
          step.generate_disabled=await generate.isDisabled();
        }
        rejected=step.generate_disabled||Boolean(step.validation_message);
      }
      await this.shot(`${step.key}-input-validation`,step);
      await this.editor.page.waitForTimeout(1000);
    } finally {this.editor.page.off('request',onRequest);}
    step.generation_requests=requests;
    if(requests.length) {
      step.generation_status='running';step.unexpected_generation=true;await this.persist();
      try {
        await this.base.waitForGeneration(frame,step.input_prompt,step.history_before,this.mode.generationTimeoutMs,step);
        step.generation_status='succeeded';
      } catch(error) {
        if(error.code==='GENERATION_FAILED')step.generation_status='failed';
        else {step.generation_status='uncertain';throw Object.assign(new Error('Unexpected invalid-input generation did not settle; refusing more charged operations'),{code:'VALIDATION_GENERATION_UNCONFIRMED'});}
      }
    }
    const current=this.base.aiFrame()??frame;
    await this.assertOwnedIdentity();step.scope_after=await this.editor.currentPageIdentity();
    step.after=await this.observation(current);step.points_after=step.after.points;step.history_after=step.after.history;step.points_charged=step.points_before-step.points_after;
    await this.creditShot(current,`${step.key}-after-credits`,step,step.points_after);await this.persist();
    assertNoChargeEvidence(step.before,step.after);
    if(requests.length)throw new Error('Invalid input triggered a generation request');
    if(step.key!=='valid-png'&&!rejected)throw new Error(`${step.key}: invalid input was accepted without a validation error or disabled Generate`);
    step.rejection_verified=step.key!=='valid-png'?rejected:undefined;step.status='passed';await this.persist();
  }
  async usageRows(page) {
    const parsed=[],unparsed=[];
    for(const frame of page.frames()) {
      const tables=frame.locator('table:visible');
      const frameHeaders=await frame.locator('table:visible thead th').allInnerTexts().catch(()=>[]);
      for(const table of await tables.all()) {
        const ownHeaders=await table.locator('thead th').allInnerTexts();
        const headers=ownHeaders.length?ownHeaders:frameHeaders;
        const rows=await table.locator('tbody tr').evaluateAll(nodes=>nodes.map(node=>[...node.querySelectorAll('td')].map(cell=>cell.innerText)));
        for(const cells of rows)try{parsed.push(parseUsageRecord(cells,headers));}catch{unparsed.push({headers,cells});}
      }
      const rows=await frame.locator('[role="row"]:visible,.usage-record-item:visible,.credit-record-item:visible').allInnerTexts();
      for(const text of rows)try{parsed.push(parseUsageRecord(text));}catch{unparsed.push(text);}
    }
    return {parsed,unparsed};
  }
  async verifyUsage(frame,step) {
    const gear=frame.locator('button.ai-settings-trigger'),panel=frame.locator('.ai-settings-panel');
    if(!await visible(panel))await gear.click();
    await panel.waitFor({state:'visible'});
    const before=new Set(this.editor.page.context().pages());
    step.usage_link=await panel.getByText('查看使用记录',{exact:true}).evaluate(element=>{const a=element.closest('a');if(!a?.href)return {kind:'handler'};const url=new URL(a.href,location.href);return {host:url.host,path:url.pathname,protocol:url.protocol};});
    await panel.getByText('查看使用记录',{exact:true}).click();
    let usagePage=this.editor.page,fallbackAttempted=false;
    let usageFailure;
    try { await wait(async()=>{
      usagePage=this.editor.page.context().pages().find(page=>!before.has(page))??this.editor.page;
      try {const url=new URL(usagePage.url());step.usage_destination={host:url.host,path:url.pathname,protocol:url.protocol};}catch{}
      if(await usagePage.getByText('403 Forbidden',{exact:true}).isVisible().catch(()=>false)) {
        const fallback=!fallbackAttempted && usageRecordsFallbackUrl(usagePage.url(),this.mode.usageRecordsFallbackHost,this.config.editorUrl);
        if(fallback) {
          fallbackAttempted=true;
          const screenshot=path.join(this.paths.report,'usage-original-403.png');await usagePage.screenshot({path:screenshot,timeout:5000});step.evidence.push(screenshot);
          step.usage_workaround={from_host:new URL(usagePage.url()).host,to_host:new URL(fallback).host,path:new URL(fallback).pathname,reason:'bare-domain viewer returned 403'};
          this.state.product_observations ??= [];this.state.product_observations.push({kind:'usage-record-link-403',step:step.key,screenshot,...step.usage_workaround});
          await this.persist();
          await usagePage.goto(fallback,{waitUntil:'domcontentloaded',timeout:20000}).catch(()=>{throw new Error('Usage viewer fallback navigation failed');});
          step.usage_status='fallback-loaded';return false;
        }
        step.usage_status='blocked-access';throw new Error('Usage records returned 403 Forbidden; access is blocked');
      }
      let rows;
      try {rows=await this.usageRows(usagePage);}catch{step.usage_load_retries=(step.usage_load_retries??0)+1;return false;}
      step.usage_rows=rows.parsed;step.unparsed_usage_rows=rows.unparsed;
      try {
        step.usage_record=selectMatchingUsageRecord(rows.parsed,{startedAt:step.generation_submitted_at,endedAt:step.generation_completed_at,expectedCost:this.generationMode(this.mode.mode).expectedCost});
        return true;
      }catch{return false;}
    },30000,'Matching usage record not found by time/type/points'); } catch(error) {usageFailure=error;}
    const file=path.join(this.paths.report,usageFailure?'usage-records-unmatched.png':'matching-usage-record.png');
    if(await usagePage.screenshot({path:file,timeout:10000}).then(()=>true).catch(()=>false))step.evidence.push(file);
    if(usagePage!==this.editor.page)await usagePage.close();
    else {
      for(const candidate of this.editor.page.frames()) {
        const close=candidate.locator('.el-dialog:visible .el-dialog__headerbtn,.el-drawer:visible .el-drawer__close-btn');
        if(await close.count())await close.first().click();
      }
    }
    await this.persist();
    if(usageFailure)throw usageFailure;
  }
  async credits(step) {
    let frame;
    if(step.generation_status==='pending') {
      frame=await this.freshForm();
      step.prompt=`Create an English solar hero with the exact heading "${step.token}" and a Learn More button.`;
      await fillAndVerify(frame.locator(this.config.selectors.aiPromptSelector).first(),step.prompt);
      await this.assertOwnedIdentity();step.scope_before=await this.editor.currentPageIdentity();
      await this.startCharge(frame,step,'quick-generate');
      step.generation_status='running';await this.persist();
      await this.base.submitBlockGeneration(frame,frame.locator(this.config.selectors.aiGenerateSelector),step.prompt,step);
      const result=await this.base.waitForGeneration(frame,step.prompt,0,this.mode.generationTimeoutMs,step);frame=result.frame??frame;
      await this.assertOwnedIdentity();step.scope_after=await this.editor.currentPageIdentity();
      step.generation_status='succeeded';step.generation_completed_at=new Date().toISOString();await this.persist();
      await this.charge(frame,step,'quick-generate',this.generationMode(this.mode.mode).expectedCost);
    } else {
      frame=await this.recoverOwnedHistory(step);step.generation_completed_at??=new Date().toISOString();
    }
    await this.shot('quick-generation-credit-result',step);
    await this.verifyUsage(frame,step);step.status='passed';await this.persist();
  }
  async run() {
    await this.ownPage();
    for(const step of this.state.steps) {
      if(step.status==='passed')continue;
      this.activeStep=step;step.status='running';step.failure_reason='';await this.persist();
      try {
        if(step.key==='credits')await this.credits(step);else await this.checkInput(step);
      } catch(error) {
        step.status='failed';step.failure_reason=error.message;await this.shot(`${step.key}-failure`,step).catch(()=>{});await this.persist();
        if(error.code==='VALIDATION_GENERATION_UNCONFIRMED'||/ownership|identity|collision|receipt|authentication/i.test(error.message))throw error;
        await this.base.closeAiResult().catch(()=>{});
      }
    }
    const failed=this.state.steps.filter(step=>step.status!=='passed');
    if(failed.length)throw new Error(failed.map(step=>`${step.key}: ${step.failure_reason}`).join('; '));
    await this.base.closeAiResult();return this.complete();
  }
}
