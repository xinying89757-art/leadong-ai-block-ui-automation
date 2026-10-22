import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { AiCompositeRegressionAutomation } from './ai-composite-runner.mjs';
import { createCompositeProductsState,assertCompositeProductsState,ownedCompositeMatches,compositeProductsPassed } from './ai-composite-products-state.mjs';
import { readCompositeJson,writeCompositeJson } from './ai-composite-state.mjs';
import { markTypeFailed } from './ai-state.mjs';
import { prepareCompositeGenerationRetry } from './ai-composite-runner.mjs';

export class AiCompositeProductsAutomation extends AiCompositeRegressionAutomation {
  constructor(editor,config,store,paths){super(editor,config,store,0);this.paths=paths;this.mode=config.ai.compositeRegression.productCategoryRegression;}

  async initialize() {
    // A timed-out generation may leave the AI history overlay open in the persistent
    // browser profile. Close the overlay before switching system pages; the server-side
    // generation record remains available and can be reopened for safe recovery.
    if(await this.editor.page.locator('.px2-embed-overlay:visible').count().catch(()=>0)) await this.closeAiResult();
    await this.editor.openSystemPage(this.mode.systemPage);
    const actual=await this.editor.currentPageIdentity();
    if(actual.name!==this.mode.systemPage||!actual.id) throw new Error('Products 系统页身份无法确认');
    const existing=await this.store.load();
    this.state=existing?assertCompositeProductsState(existing,this.config,this.config.ai.runId):createCompositeProductsState(this.config,this.config.ai.runId,actual);
    this.page=this.state.page;
    if(this.state.status==='failed'&&this.page.failure_reason){
      this.state.previous_failures??=[];
      this.state.previous_failures.push({reason:this.page.failure_reason,at:new Date().toISOString()});
    }
    this.state.status='running';this.page.failure_reason='';
    if(this.page.target_identity.id!==actual.id) throw new Error('Products 系统页 ID 与本轮记录不一致，停止操作');
    await this.persist();
    const record=this.state.types[0];
    if(record.apply_status==='applied'){
      if(!await this.verifyEditorType(record.type)) throw new Error('已应用复合区块在 Products 页不存在，禁止重复生成');
    }else{
      if(record.application_attempted) throw new Error('上次应用结果不确定，停止以避免重复插入');
    }
    return this.state;
  }

  async cleanupPrevious(){
    const cleanup=this.state.cleanup;
    if(cleanup.status==='passed') return;
    const ownership=await readCompositeJson(this.paths.ownership);
    const candidates=await this.editor.describeAiBlockWrappers();
    if(!ownership&&candidates.length)throw new Error('Products 存在无法确认归属的 AI 区块，停止新增，避免重复');
    if(ownership?.identity?.id&&(await this.canvasSnapshot()).ids.filter(id=>id===ownership.identity.id).length>1)throw new Error('Products 上轮区块稳定 ID 出现多个，禁止删除');
    const matches=ownedCompositeMatches(candidates,ownership,this.config,this.page.target_identity.id);
    if(ownership?.status==='removed'){
      if(matches.length) throw new Error('上轮区块记录为已删除，但页面仍存在该区块');
    }else if(ownership){
      if(!matches.length&&!(cleanup.status==='deleting'&&cleanup.previous_identity?.id===ownership.identity.id)) throw new Error('未唯一找到上轮自动化区块，禁止新增和猜测删除');
      cleanup.status='deleting';cleanup.previous_run_id=ownership.run_id;cleanup.previous_identity=ownership.identity;
      await this.persist();
      if(matches.length){
        const result=await this.editor.deleteAiBlock({identity:ownership.identity,apply:true});
        if(!result.applied) throw new Error('上轮复合区块删除未确认');
      }
      const remaining=await this.editor.describeAiBlockWrappers();
      if(ownedCompositeMatches(remaining,ownership,this.config,this.page.target_identity.id).length) throw new Error('上轮区块删除后仍存在');
      await this.editor.savePage();
      await writeCompositeJson(this.paths.ownership,{...ownership,status:'removed',removed_by_run_id:this.config.ai.runId,removed_at:new Date().toISOString()});
    }
    cleanup.status='passed';cleanup.finished_at=new Date().toISOString();
    this.page.baseline_ai_ids=(await this.canvasSnapshot()).ids;
    await this.persist();
  }

  async registerOwnership(){
    const record=this.state.types[0];
    const candidates=(await this.editor.describeAiBlockWrappers()).filter(x=>x.identity.id===record.committed_block_id);
    if(candidates.length!==1) throw new Error('本轮新增复合区块没有唯一稳定 ID，无法登记所有权');
    const ownership={version:1,site_name:this.config.siteName,site_language:this.config.siteLanguage,system_page:this.mode.systemPage,
      system_page_id:this.page.target_identity.id,run_id:this.config.ai.runId,type:'复合区块',identity:candidates[0].identity,status:'applied',applied_at:new Date().toISOString()};
    await writeCompositeJson(this.paths.ownership,ownership);
    this.state.ownership=ownership;
    await this.persist();
  }

  async afterFinalApply(context){await super.afterFinalApply(context);await this.registerOwnership();}

  async generateOnProducts(){
    const record=this.state.types[0];
    if(record.apply_status==='applied') return;
    if(this.state.cleanup.status!=='passed') throw new Error('尚未确认运行前清理检查点，禁止生成');
    const last=record.generation_attempts?.at(-1);
    if(record.generation_status==='failed'&&last?.explicit_platform_failure&&Number(record.generation_attempt_number||1)<this.config.ai.compositeRegression.maxGenerationAttempts){
      prepareCompositeGenerationRetry(record,new Error(last.failure_reason||'平台明确生成失败'));await this.persist();
    }
    const submitted=record.generation_submit_confirmed===true||Boolean(record.generation_submitted_at);
    if(submitted&&!this.canResumeSubmittedGeneration(record)) throw new Error('生成已提交但状态不确定，仅允许恢复已确认任务，不重复生成');
    try{await this.generateAndApply(record);}catch(error){markTypeFailed(record,error);await this.persist();throw error;}
  }

  async saveAndReopen(){
    const record=this.state.types[0];
    record.editor_verified=await this.verifyEditorType(record.type);
    if(!record.editor_verified) throw new Error('本轮复合区块未在 Products 页显示');
    this.page.editor_verified=true;
    if(!this.page.saved){await this.editor.savePage();this.page.saved=true;await this.persist();}
    if(!this.page.persisted_verified){
      await this.editor.page.reload({waitUntil:'domcontentloaded'});
      await this.editor.waitForCanvasReady();await this.editor.openSystemPage(this.mode.systemPage);
      if(!await this.verifyEditorType(record.type)) throw new Error('保存后重新打开 Products，未检测到本轮复合区块');
      const current=await this.canvasSnapshot();
      if(!this.page.baseline_ai_ids.every(id=>current.ids.includes(id))) throw new Error('Products 原有区块发生缺失');
      this.page.persisted_verified=true;await this.persist();
    }
    await mkdir(this.paths.artifacts,{recursive:true});
    await this.editor.page.screenshot({path:path.join(this.paths.artifacts,'editor.png'),fullPage:false});
  }

  async run(){
    await this.initialize();
    const { CompositeCategoryLinkage }=await import('./composite-category-linkage.mjs');
    const linkage=new CompositeCategoryLinkage(this.editor,this.config,this.state,this.paths,()=>this.persist());
    await linkage.catalog();
    if(this.state.types[0].apply_status!=='applied')await this.cleanupPrevious();
    await this.generateOnProducts();await this.saveAndReopen();
    if(!this.page.preview_render_verified)await linkage.previewRender();
    if(this.page.publish_status!=='accepted'){
      this.page.publish_status='running';await this.persist();
      await this.editor.publishSite();this.page.publish_status='accepted';await this.persist();
    }
    if(this.state.linkage.preview.status!=='passed') await linkage.preview();
    if(this.state.linkage.public.status!=='passed') await linkage.public();
    if(compositeProductsPassed(this.state)){
      this.state.status='passed';this.page.failure_reason='';this.state.types[0].failure_reason='';
      const ownership=await readCompositeJson(this.paths.ownership);
      if(ownership?.run_id===this.config.ai.runId) await writeCompositeJson(this.paths.ownership,{...ownership,published_verified:true});
      await this.persist();
    }
    return this.state;
  }
}
