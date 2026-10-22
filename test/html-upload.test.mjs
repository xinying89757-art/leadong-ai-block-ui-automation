import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, projectRoot } from '../src/config.mjs';
import { compareHtmlRendering, htmlUploadPassed, htmlUploadPaths, htmlUploadResumeAction, newHtmlUploadState,
  parseUploadResponse, uniqueUploadRecord, validateHtmlFile, validateHtmlUploadConfig } from '../src/html-upload-state.mjs';
import { HtmlUploadAutomation } from '../src/html-upload-runner.mjs';

test('HTML 上传测试文件固化在项目内，页面、状态及报告按 runId 隔离',async()=>{
  const config=await loadConfig(); validateHtmlUploadConfig(config.htmlUploadRegression);
  const file=path.resolve(projectRoot,config.htmlUploadRegression.filePath);
  const metadata=validateHtmlFile(file,await readFile(file));
  const first=newHtmlUploadState(config,'html-upload-test-a',file,metadata);
  const second=newHtmlUploadState(config,'html-upload-test-b',file,metadata);
  assert.notEqual(first.page.name,second.page.name); assert.notEqual(first.page.path,second.page.path);
  assert.notEqual(htmlUploadPaths(config,first.run_id).state,htmlUploadPaths(config,second.run_id).state);
  assert.match(htmlUploadPaths(config,first.run_id).artifacts,/output\/playwright\/html-upload/);
  assert.equal(htmlUploadPassed(first),false);
  assert.throws(()=>validateHtmlFile('wrong.txt',Buffer.from('<html></html>')),/html/);
});

test('HTML 上传恢复只复用已确认任务或页面，回执未知时禁止重复上传',()=>{
  assert.equal(htmlUploadResumeAction({upload:{status:'pending'},page:{}}),'upload');
  assert.throws(()=>htmlUploadResumeAction({upload:{submitted_at:'now'},page:{}}),/禁止重复上传/);
  assert.equal(htmlUploadResumeAction({upload:{record_id:'record-1'},page:{}}),'recover-upload-record');
  assert.equal(htmlUploadResumeAction({creation_submitted_at:'now',upload:{},page:{}}),'recover-created-page');
  assert.equal(htmlUploadResumeAction({upload:{record_id:'record-1'},page:{id:'page-1'}}),'verify-existing-page');
  assert.throws(()=>uniqueUploadRecord([{id:'a'},{id:'a'}],'a'),/唯一/);
  assert.throws(()=>uniqueUploadRecord([{id:'other'}],'a'),/唯一/);
  assert.equal(uniqueUploadRecord([{id:'other'},{id:'target'}],'target').index,1);
});

test('HTML 上传识别业务失败、后台处理中和成功回执，不以 HTTP 成功代替业务成功',()=>{
  assert.throws(()=>parseUploadResponse({code:500,data:{}},true),/业务失败/);
  assert.throws(()=>parseUploadResponse({code:200,data:{status:'failed',message:'invalid html'}},true),/解析失败/);
  assert.equal(parseUploadResponse({code:200,data:{pageRecordId:'r',status:'generating'}},true).record_id,'r');
  assert.equal(parseUploadResponse({code:200,data:{pageRecordId:'r',status:'success',blocksTotal:1,blocksDone:1}},true).blocks_done,1);
});

const snapshot=()=>({text:'测试页面 正文',width:1280,structure:['main','h1','p','svg'],links:[{text:'联系',href:'#contact'}],media:[{tag:'svg',paths:['M0 0L10 10']}],broken_images:0,
  samples:[{label:'h1 标题',style:{color:'rgb(0, 0, 0)',fontSize:'27px'},rect:{x:12,y:20,width:300,height:32}}]});
test('HTML 三处展示对比覆盖文本、图表、样式与布局，允许少量小数像素差',()=>{
  const source=snapshot(); assert.equal(compareHtmlRendering(source,snapshot()).passed,true);
  const near=snapshot(); near.samples[0].rect.x+=1.2;
  assert.equal(compareHtmlRendering(source,near,2).passed,true);
  for(const mutate of [s=>s.text+='缺失',s=>s.media[0].paths=['M1 1'],s=>s.samples[0].style.fontSize='12px',s=>s.samples[0].rect.x+=10,s=>s.broken_images=1]){
    const actual=snapshot(); mutate(actual); assert.equal(compareHtmlRendering(source,actual).passed,false);
  }
  assert.equal(compareHtmlRendering(null,null).passed,false);
});

test('上传创建回执立即持久化，等待自动切换及内容插入，期间不主动切页或保存',async()=>{
  const events=[];
  const editor={ pageSettingsDialog:async()=>({}),fillPageSettings:async()=>events.push('fill'),
    submitPageSettings:async()=>{events.push('submit');return {id:'created-page'};},
    waitForPageLoaded:async()=>events.push('wait-auto-handoff'),
    openCustomPage:async()=>assert.fail('导入尚未完成，禁止主动切页'),savePage:async()=>assert.fail('导入尚未完成，禁止保存') };
  const automation=new HtmlUploadAutomation(editor,{htmlUploadRegression:{}},{page:{name:'test',path:'/test.html'}},{},async()=>events.push('persist'));
  await automation.createPage();
  assert.deepEqual(events,['fill','persist','submit','persist','wait-auto-handoff']);
  assert.equal(editor.insertionPending,true);
  assert.equal(automation.state.page.id,'created-page');
});
