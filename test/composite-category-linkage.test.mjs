import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { createCompositeProductsState,compositeProductsConfig,compositeProductsPaths,assertCompositeProductsState,
  compositeProductsPassed,ownedCompositeMatches,sameSiteCategoryUrl,validateCategoryMembership } from '../src/ai-composite-products-state.mjs';
import { categoryProducts,matchProductCategoryFilter,CompositeCategoryLinkage } from '../src/composite-category-linkage.mjs';
import { chromium } from 'playwright';
import { AiCompositeProductsAutomation } from '../src/ai-composite-products-runner.mjs';
import { writeCompositeJson } from '../src/ai-composite-state.mjs';

test('分类联动从 Products 系统页生成并固定测试分类，不复用自定义页状态',async()=>{
  const config=await loadConfig();const runId='products-unit';
  const scoped=compositeProductsConfig(config,runId,'state');
  const state=createCompositeProductsState(config,runId,{id:'Products-id',name:'Products'});
  assert.equal(state.page.name,'Products');assert.equal(state.page.path,'system:Products');
  assert.equal(new URL(state.page.publicUrl).pathname,'/products.html');
  assert.equal(state.linkage.category_name,'测试分类');
  assert.match(scoped.ai.prompts['复合区块'],/current category page context/);
  assert.doesNotThrow(()=>assertCompositeProductsState(state,config,runId));
  assert.throws(()=>assertCompositeProductsState({...state,mode:'ai'},config,runId),/不匹配/);
  assert.throws(()=>assertCompositeProductsState({...state,page:{...state.page,name:'Product Category'}},config,runId),/不匹配/);
  assert.notEqual(compositeProductsPaths(config,runId).state,compositeProductsPaths(config,'other').state);
});

test('只匹配本站 Products 上轮所有权区块，归属不明或重复则禁止删除',async()=>{
  const config=await loadConfig();const owner={site_name:config.siteName,site_language:config.siteLanguage,system_page:'Products',system_page_id:'p',identity:{id:'owned'}};
  const candidates=[{identity:{id:'manual'}},{identity:{id:'owned'}}];
  assert.equal(ownedCompositeMatches(candidates,owner,config,'p').length,1);
  assert.deepEqual(ownedCompositeMatches(candidates,null,config,'p'),[]);
  assert.throws(()=>ownedCompositeMatches(candidates,{...owner,site_name:'another-site'},config,'p'),/禁止删除/);
  assert.throws(()=>ownedCompositeMatches(candidates,owner,config,'different-page'),/禁止删除/);
  assert.throws(()=>ownedCompositeMatches([...candidates,{identity:{id:'owned'}}],owner,config,'p'),/多个/);
});

test('分类产品必须按稳定 ID 精确匹配，列表不变、混入其他分类或缺失产品不能通过',()=>{
  const expected=[{id:'target',name:'测试产品'}],baseline=[...expected,{id:'other',name:'测试产品'}];
  assert.equal(validateCategoryMembership(expected,expected,baseline).exact_match,true);
  for(const cards of [baseline,[],[{id:'other'}],[...expected,...expected]])assert.throws(()=>validateCategoryMembership(cards,expected,baseline));
  assert.throws(()=>validateCategoryMembership(expected,expected,expected),/无法区分/);
  assert.deepEqual(categoryProducts([{id:'1',categories:['父类->测试分类']},{id:'2',categories:['测试分类扩展']}],'测试分类').map(p=>p.id),['1']);
});

test('后台产品分类筛选唯一匹配“测试分类”，支持路径选项并拒绝重复候选',()=>{
  const options=[{visible:true,label:'父分类 -> 测试分类',value:'leaf',index:1},{visible:true,label:'其他分类',value:'other',index:2}];
  assert.deepEqual(matchProductCategoryFilter(options,'测试分类'),options[0]);
  assert.throws(()=>matchProductCategoryFilter([...options,{...options[0],index:3}],'测试分类'),/唯一匹配失败/);
  assert.throws(()=>matchProductCategoryFilter(options.map(c=>({...c,visible:false})),'测试分类'),/唯一匹配失败/);
});

test('分类链接拒绝外站、非分类页和脚本 URL，支持本站分类路径',()=>{
  const base='http://site.example';
  assert.equal(sameSiteCategoryUrl('/--pl123.html',base).path,'/--pl123.html');
  for(const href of ['https://other.example/--pl123.html','/products.html','javascript:void(0)'])assert.throws(()=>sameSiteCategoryUrl(href,base));
});

test('预览窗口未产生 page 事件时使用已核实的入口地址，不产生未捕获 Promise 拒绝',async()=>{
  const calls=[],preview={goto:async url=>calls.push(url)};
  const context={pages:()=>[],waitForEvent:()=>Promise.reject(new Error('no popup')),newPage:async()=>preview};
  const trigger={getAttribute:async()=> 'http://website.leadong.com/phoenix/pagebuilder/preview',click:async()=>calls.push('click')};
  const links={count:async()=>1,first:()=>trigger};
  const editor={dismissBlockingDialogs:async()=>calls.push('dismiss'),page:{locator:selector=>{assert.equal(selector,'.clickToPreview:visible a[target="_blank"][href]');return links;},url:()=> 'https://website.leadong.com/phoenix/pagebuilder/layout',context:()=>context}};
  const state={linkage:{preview:{}}};const config={timeouts:{actionMs:1000},ai:{compositeRegression:{productCategoryRegression:{}}}};
  const runner=new CompositeCategoryLinkage(editor,config,state,{},async()=>{});
  assert.equal(await runner.openPreview(),preview);
  assert.equal(state.linkage.preview.opening_source,'validated-preview-href');
  assert.deepEqual(calls,['dismiss','dismiss','click','http://website.leadong.com/phoenix/pagebuilder/preview']);
});

test('Products 再运行前只清理上轮区块，删除后保存但不单独发布，恢复不再次删除',async()=>{
  const config=await loadConfig();const runId='cleanup-unit';const scoped=compositeProductsConfig(config,runId,'state');
  const temp=await mkdtemp(path.join(os.tmpdir(),'composite-owned-'));
  try{
    const paths={ownership:path.join(temp,'owner.json')};
    const owner={site_name:config.siteName,site_language:config.siteLanguage,system_page:'Products',system_page_id:'p',run_id:'previous',identity:{id:'owned'},status:'applied'};
    await writeCompositeJson(paths.ownership,owner);
    let candidates=[{identity:{id:'manual'}},{identity:{id:'owned'}}];const calls=[];
    const editor={describeAiBlockWrappers:async()=>candidates,deleteAiBlock:async args=>{calls.push(args.identity.id);candidates=candidates.filter(c=>c.identity.id!==args.identity.id);return {applied:true};},
      savePage:async()=>calls.push('save'),publishSite:async()=>assert.fail('清理后不应单独发布')};
    const automation=new AiCompositeProductsAutomation(editor,scoped,{},paths);
    automation.state=createCompositeProductsState(config,runId,{id:'p',name:'Products'});automation.page=automation.state.page;
    automation.persist=async()=>{};automation.canvasSnapshot=async()=>({ids:candidates.map(c=>c.identity.id)});
    await automation.cleanupPrevious();await automation.cleanupPrevious();
    assert.deepEqual(calls,['owned','save']);assert.equal(candidates[0].identity.id,'manual');
    assert.equal(automation.state.cleanup.previous_run_id,'previous');
    // Completion retains the current block. Only a later run's preparation may delete it.
    assert.equal(automation.state.cleanup.status,'passed');
    const unknown=new AiCompositeProductsAutomation(editor,scoped,{}, {ownership:path.join(temp,'missing-owner.json')});
    unknown.state=createCompositeProductsState(config,runId,{id:'p',name:'Products'});unknown.page=unknown.state.page;
    unknown.persist=async()=>{};unknown.canvasSnapshot=automation.canvasSnapshot;
    await assert.rejects(()=>unknown.cleanupPrevious(),/无法确认归属/);
    assert.deepEqual(calls,['owned','save']);
  }finally{await rm(temp,{recursive:true,force:true});}
});

test('有页面展示标记但分类交互未验证时，专项不得通过',async()=>{
  const config=await loadConfig(),s=createCompositeProductsState(config,'check-unit',{id:'p',name:'Products'});
  Object.assign(s.types[0],{apply_status:'applied',editor_verified:true,committed_block_id:'new'});
  Object.assign(s.page,{saved:true,persisted_verified:true,preview_render_verified:true,preview_verified:true,published_verified:true});
  s.cleanup.status='passed';
  s.linkage.catalog.status='passed';s.linkage.preview={status:'passed',evidence:{exact_match:true}};s.linkage.public={status:'passed',evidence:{exact_match:true}};
  assert.equal(compositeProductsPassed(s),true);s.linkage.public.status='pending';assert.equal(compositeProductsPassed(s),false);
});

test('本地浏览器验证真实点击分类跳转，并拒绝拿原生列表替代本轮复合区块',async()=>{
  const temp=await mkdtemp(path.join(os.tmpdir(),'composite-click-'));
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const cards=ids=>`<div data-block-uuid="ai-productlist"><ul>${ids.map(id=>`<li class="prodlist-site-block" data-pid="${id}"><a class="titleLabel" href="/p-pd123.html">产品${id}</a></li>`).join('')}</ul></div>`;
    const block=ids=>`<div id="round-block"><div data-block-uuid="ai-groupProduct"><a href="/test-pl123.html">测试分类</a></div>${cards(ids)}</div>`;
    for(const scenario of ['correct','wrong-products','native-only','overlaid']){
      const page=await browser.newPage();
      await page.route('http://fixture.test/**',async route=>{
        const category=new URL(route.request().url()).pathname==='/test-pl123.html';
        let html=category?(scenario==='correct'||scenario==='overlaid'?block(['target']):scenario==='wrong-products'?block(['other']):cards(['target'])):block(['target','other']);
        if(!category&&scenario==='overlaid')html=html.replace('<a href="/test-pl123.html">测试分类</a>','<span style="position:relative;display:inline-block"><a href="/test-pl123.html">测试分类</a><i style="position:absolute;inset:0;z-index:2"></i></span>');
        await route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:`<!doctype html><meta charset="utf-8"><body>${html}</body>`});
      });
      await page.goto('http://fixture.test/products.html');
      const state={types:[{committed_block_id:'round-block'}],page:{},linkage:{public:{status:'pending'},catalog:{products:[{id:'target'},{id:'other'}],expected_products:[{id:'target'}]}}};
      const config={publicBaseUrl:'http://fixture.test',ai:{compositeRegression:{productCategoryRegression:{categoryName:'测试分类',publicPath:'/products.html',interactionTimeoutMs:1200,stableMs:100}}}};
      const linkage=new CompositeCategoryLinkage({page},config,state,{artifacts:path.join(temp,scenario)},async()=>{});
      if(scenario==='correct'||scenario==='overlaid'){
        const evidence=await linkage.clickAndCheck(page,()=>[page.mainFrame()],'public');
        assert.equal(evidence.exact_match,true);assert.deepEqual(evidence.actual_ids,['target']);
        assert.equal(evidence.interaction_method,scenario==='overlaid'?'keyboard-fallback':'pointer');
        assert.equal(new URL(page.url()).pathname,'/test-pl123.html');
      }else{
        await assert.rejects(()=>linkage.clickAndCheck(page,()=>[page.mainFrame()],'public'),/分类点击后产品验证未通过/);
        assert.equal(state.linkage.public.status,'failed');
      }
      await page.close();
    }
  }finally{await browser.close();await rm(temp,{recursive:true,force:true});}
});
