#!/usr/bin/env node
import path from 'node:path';
import { mkdir,open,readFile,unlink } from 'node:fs/promises';
import { loadConfig } from './config.mjs';
import { launchEditorBrowser,LeadongEditor } from './editor.mjs';
import { AiStateStore } from './ai-state.mjs';
import { parseCliArgs } from './cli-args.mjs';
import { readCompositeJson,writeCompositeJson } from './ai-composite-state.mjs';
import { assertCompositeProductsState,compositeProductsConfig,compositeProductsPassed,compositeProductsPaths } from './ai-composite-products-state.mjs';
import { AiCompositeProductsAutomation } from './ai-composite-products-runner.mjs';
import { writeCompositeProductsReport } from './composite-products-report.mjs';

async function acquireLock(file){
  await mkdir(path.dirname(file),{recursive:true});
  for(let attempt=0;attempt<2;attempt++){
    try{const h=await open(file,'wx');await h.writeFile(JSON.stringify({pid:process.pid}));await h.close();return async()=>unlink(file).catch(()=>{});}
    catch(e){if(e.code!=='EEXIST')throw e;const lock=JSON.parse(await readFile(file,'utf8'));let alive=true;try{process.kill(lock.pid,0);}catch(error){if(error.code==='ESRCH')alive=false;}
      if(alive)throw new Error('Products 系统页已有自动化执行，拒绝并发清理或生成');await unlink(file);}
  }
  throw new Error('无法取得 Products 系统页执行锁');
}

async function main(){
  const options=parseCliArgs(process.argv.slice(2)),command=options._[0]||'status';
  if(!['run','resume','status'].includes(command))throw new Error('未知复合区块 Products 命令');
  const config=await loadConfig(options.config||'config/run.json');
  const mode=config.ai.compositeRegression.productCategoryRegression;if(!mode?.enabled||mode.systemPage!=='Products')throw new Error('Products 分类联动专项未正确启用');
  const activePath=compositeProductsPaths(config,'placeholder').active,active=await readCompositeJson(activePath);
  const runId=options['run-id']||(command==='run'?`composite-products-${new Date().toISOString().replace(/[-:.TZ]/g,'').slice(0,14)}`:active?.runId);
  if(!runId)throw new Error('没有可恢复的 Products 分类联动运行');
  const paths=compositeProductsPaths(config,runId);let existing=await readCompositeJson(paths.state);
  if(command==='status'){
    if(!existing)throw new Error('找不到该运行状态');assertCompositeProductsState(existing,config,runId);await writeCompositeProductsReport(existing,paths);
    console.log(JSON.stringify({ok:compositeProductsPassed(existing),runId,stateFile:paths.state,reportFile:paths.report,page:existing.page,linkage:existing.linkage},null,2));return;
  }
  if(!options.apply)throw new Error('此专项会修改并发布 Products 系统页，需要 --apply');
  if(command==='run'){
    if(existing)throw new Error('运行 ID 已存在，请使用 resume');
    if(active?.runId){const previous=await readCompositeJson(compositeProductsPaths(config,active.runId).state);if(previous&&!compositeProductsPassed(previous))throw new Error('上轮尚未完成，请先恢复，避免删除正在生成或应用的区块');}
  }else{
    if(!existing)throw new Error('找不到需要恢复的运行状态');assertCompositeProductsState(existing,config,runId);
    if(compositeProductsPassed(existing)){console.log(JSON.stringify({ok:true,runId,message:'已完成，不重复生成或删除',reportFile:paths.report}));return;}
  }
  const release=await acquireLock(`${paths.ownership}.lock`);let context,automation;
  const start=Date.now(),prior=existing?.duration_ms||0;
  try{
    await writeCompositeJson(activePath,{runId,stateFile:paths.state});
    const scoped=compositeProductsConfig(config,runId,paths.state);
    const launched=await launchEditorBrowser(scoped,{headless:options.headless===true,isolatedProfile:false,slowMo:0});context=launched.context;
    const editor=new LeadongEditor(launched.page,scoped);await editor.goto();
    automation=new AiCompositeProductsAutomation(editor,scoped,new AiStateStore(paths.state),paths);
    const persistBase=automation.persist.bind(automation);
    automation.persist=async()=>{automation.state.duration_ms=prior+Date.now()-start;await persistBase();await writeCompositeProductsReport(automation.state,paths);};
    await automation.run();
    if(!compositeProductsPassed(automation.state))process.exitCode=1;
  }catch(error){
    if(automation?.state){automation.state.status='failed';automation.state.page.failure_reason=error.message;
      await mkdir(paths.artifacts,{recursive:true});await automation.editor.page.screenshot({path:path.join(paths.artifacts,'failure.png'),fullPage:false}).catch(()=>{});
      await automation.persist();}
    process.exitCode=1;console.error(`Products 分类联动失败：${error.message.split('\n')[0]}`);
  }finally{
    if(automation?.state){automation.state.duration_ms=prior+Date.now()-start;await automation.persist();
      console.log(JSON.stringify({ok:compositeProductsPassed(automation.state),runId,stateFile:paths.state,reportFile:paths.report,
        durationMs:automation.state.duration_ms,blockId:automation.state.types[0].committed_block_id,failureReason:automation.state.page.failure_reason||''},null,2));}
    if(context)await context.close();await release();
  }
}
main().catch(e=>{console.error(e.message.split('\n')[0]);process.exitCode=1;});
