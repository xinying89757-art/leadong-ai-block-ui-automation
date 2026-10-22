#!/usr/bin/env node
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { loadConfig, projectRoot } from './config.mjs';
import { LeadongEditor, launchEditorBrowser } from './editor.mjs';
import { parseCliArgs } from './cli-args.mjs';
import { HtmlUploadAutomation } from './html-upload-runner.mjs';
import { writeHtmlUploadReport, shortUploadFailure } from './html-upload-report.mjs';
import { assertHtmlUploadState, htmlUploadPassed, htmlUploadPaths, htmlUploadResumeAction, newHtmlUploadState,
  readHtmlUploadState, validateHtmlFile, validateHtmlUploadConfig, writeHtmlUploadState } from './html-upload-state.mjs';

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  const command = options._[0] || 'status';
  if (!['run','resume','status'].includes(command)) throw new Error(`未知 HTML 上传命令：${command}`);
  const config = await loadConfig(options.config || 'config/run.json');
  validateHtmlUploadConfig(config.htmlUploadRegression);
  const activePath = htmlUploadPaths(config,'placeholder').active;
  const active = await readHtmlUploadState(activePath);
  const runId = options['run-id'] || (command === 'run' ? `html-upload-${new Date().toISOString().replace(/[-:.TZ]/g,'').slice(0,14)}` : active?.runId);
  if (!runId && command === 'status') { console.log(JSON.stringify({ok:false,message:'没有 HTML 上传运行状态'})); return; }
  const paths = htmlUploadPaths(config,runId);
  let state = await readHtmlUploadState(paths.state);
  if (command === 'run') {
    if (!options.apply) throw new Error('HTML 上传专项会新建、保存并发布页面，请使用 --apply');
    if (state) throw new Error('该 runId 已存在，请使用 resume，避免重复新建页面');
    const file = options.file ? path.resolve(String(options.file)) : path.resolve(projectRoot,config.htmlUploadRegression.filePath);
    const metadata = validateHtmlFile(file,await readFile(file));
    state = newHtmlUploadState(config,runId,file,metadata);
    await writeHtmlUploadState(paths.state,state);
    await writeHtmlUploadState(activePath,{runId,stateFile:paths.state});
  } else {
    if (!state) throw new Error('找不到指定运行的 HTML 上传状态');
    assertHtmlUploadState(state,config,runId);
  }
  if (command === 'status') {
    await writeHtmlUploadReport(state,paths);
    console.log(JSON.stringify({ok:htmlUploadPassed(state),runId,stateFile:paths.state,reportFile:paths.report,
      status:state.status,durationMs:state.duration_ms,page:state.page,steps:state.steps},null,2));
    return;
  }
  if (!options.apply) throw new Error('恢复 HTML 上传流程需要 --apply');
  const resumeAction = htmlUploadResumeAction(state);
  if (resumeAction === 'complete') {
    await writeHtmlUploadReport(state,paths);
    console.log(JSON.stringify({ok:true,runId,message:'该轮已完成，无需重复上传或发布',stateFile:paths.state,reportFile:paths.report},null,2)); return;
  }
  if (options.file && path.resolve(String(options.file)) !== state.file.path) throw new Error('恢复时不能更换测试文件');
  const actual = validateHtmlFile(state.file.path,await readFile(state.file.path));
  if (actual.sha256 !== state.file.sha256) throw new Error('测试文件已改变，禁止混用原运行状态');
  const start = Date.now(), previousDuration = state.duration_ms || 0;
  const attempt = { number:state.attempts.length+1,command,resume_action:resumeAction,started_at:new Date().toISOString(),status:'running' };
  state.attempts.push(attempt); state.status='running'; state.failure_reason='';
  let pendingWrite = Promise.resolve();
  const persist = () => {
    pendingWrite = pendingWrite.catch(()=>{}).then(async () => {
      state.updated_at = new Date().toISOString(); state.duration_ms = previousDuration+Date.now()-start;
      await writeHtmlUploadState(paths.state,state);
      await writeHtmlUploadReport(state,paths);
    });
    return pendingWrite;
  };
  let context, editor, automation;
  try {
    await persist();
    const browser = await launchEditorBrowser(config,{headless:options.headless===true,isolatedProfile:false,slowMo:0});
    context=browser.context; editor=new LeadongEditor(browser.page,config);
    await editor.goto(); await editor.waitForCanvasReady();
    state.page.publicUrl=new URL(state.page.path,config.publicBaseUrl).href;
    automation=new HtmlUploadAutomation(editor,config,state,paths,persist);
    await automation.run();
    attempt.status=htmlUploadPassed(state)?'passed':'failed';
  } catch(error) {
    state.status='failed'; state.failure_reason=shortUploadFailure(error.message); attempt.status='failed';
    state.failure_step=automation?.currentStep || state.failure_step || '进入目标站点';
    if (editor && !editor.page.isClosed()) {
      const screenshot=path.join(paths.artifacts,`failure-${attempt.number}.png`);
      await editor.page.screenshot({path:screenshot,fullPage:false}).catch(()=>{});
      state.evidence.failure={screenshot};
    }
    process.exitCode=1;
  } finally {
    attempt.finished_at=new Date().toISOString(); attempt.duration_ms=Date.now()-start; attempt.failure_reason=state.failure_reason;
    await persist();
    if(context) await context.close();
  }
  console.log(JSON.stringify({ok:htmlUploadPassed(state),runId,status:state.status,durationMs:state.duration_ms,
    page:state.page,stateFile:paths.state,reportFile:paths.report,failureStep:state.failure_step,failureReason:state.failure_reason},null,2));
}
main().catch(error=>{console.error(`HTML 上传专项失败：${shortUploadFailure(error.message)}`);process.exitCode=1;});
