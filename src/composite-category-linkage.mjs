import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { DetailContentBrowser } from './ai-detail-content.mjs';
import { sameSiteCategoryUrl,validateCategoryMembership } from './ai-composite-products-state.mjs';

const norm=value=>String(value||'').normalize('NFKC').replace(/\s+/g,' ').trim();
const GROUP='[data-block-uuid="ai-groupProduct"]';
const LIST='[data-block-uuid="ai-productlist"]';

async function waitUntil(check,timeout,label){
  const end=Date.now()+timeout;let last;
  while(Date.now()<end){try{const value=await check();if(value)return value;}catch(e){last=e;}
    await new Promise(r=>setTimeout(r,300));}
  throw new Error(`${label}等待超时${last?`：${last.message}`:''}`);
}

export function categoryProducts(catalog,categoryName){
  const name=norm(categoryName);
  const selected=catalog.filter(product=>product.categories.some(value=>value.split(/->|→/).map(norm).includes(name)));
  if(!selected.length)throw new Error('后台目标分类无产品或分类归属数据不可用');
  return selected;
}

export function matchProductCategoryFilter(options,categoryName){
  const wanted=norm(categoryName);
  const candidates=options.filter(option=>{
    const parts=norm(option.label).split(/\s*(?:->|→|＞|\/|›)\s*/);
    return option.visible&&parts.at(-1)===wanted;
  });
  if(candidates.length!==1)throw new Error(`后台产品分类筛选项“${categoryName}”唯一匹配失败：${candidates.length} 个`);
  return candidates[0];
}

export async function compositeProductCards(root){
  const lists=root.locator(LIST);
  if(await lists.count()!==1)throw new Error('本轮复合区块中的产品列表组件不唯一');
  return lists.locator('li.prodlist-site-block').evaluateAll(nodes=>nodes.filter(n=>n.getClientRects().length>0).map(n=>({
    id:n.getAttribute('data-pid')||'',name:(n.querySelector('.titleLabel,.prodlist-site-block-name')?.textContent||'').replace(/\s+/g,' ').trim(),
    href:n.querySelector('a[href*="-pd"]')?.getAttribute('href')||''})));
}

export class CompositeCategoryLinkage{
  constructor(editor,config,state,paths,persist){Object.assign(this,{editor,config,state,paths,persist});this.mode=config.ai.compositeRegression.productCategoryRegression;}

  async catalog(){
    if(this.state.linkage.catalog.status==='passed')return this.state.linkage.catalog;
    const record=this.state.linkage.catalog;record.status='running';await this.persist();
    const helper=new DetailContentBrowser(this.editor.page.context(),this.config);
    let backendPage;
    try{
      const page=await helper.open();const url=new URL(page.url());url.pathname='/phoenix/website';url.search='?module=prod';
      backendPage=page;
      await page.goto(url.href,{waitUntil:'domcontentloaded'});
      await page.locator('iframe#prod').waitFor({state:'visible'});const frame=page.locator('iframe#prod').contentFrame();
      await frame.getByRole('link',{name:'管理产品',exact:true}).click();
      const rows=frame.locator('tr').filter({has:frame.locator('input[name="dataId"]')});
      await rows.first().waitFor({state:'visible',timeout:this.mode.interactionTimeoutMs});
      const parseTotal=async()=>{
        const text=await frame.locator('body').innerText();const value=text.match(/共\s*([\d,]+)\s*条记录/);
        return value?Number(value[1].replaceAll(',','')):false;
      };
      const beforeTotal=await waitUntil(parseTotal,this.mode.interactionTimeoutMs,'后台产品总数');
      const dropdown=frame.locator('a[action="dropdown_classification_prod_new"]');
      if(await dropdown.count()!==1)throw new Error('后台产品分类筛选下拉未唯一匹配');
      await dropdown.click();
      const options=frame.locator('.imitateSelect:visible li[valueid]');
      const match=await waitUntil(async()=>{
        const entries=await options.evaluateAll(nodes=>nodes.map((node,index)=>({index,label:node.innerText.replace(/\s+/g,' ').trim(),value:node.getAttribute('valueid')||'',visible:!!node.getClientRects().length})).filter(x=>x.value));
        try{return matchProductCategoryFilter(entries,this.mode.categoryName);}catch(e){if(/0 个/.test(e.message))return false;throw e;}
      },this.mode.interactionTimeoutMs,'后台产品分类筛选选项加载');
      await options.nth(match.index).click();
      const selected=await dropdown.innerText();const selectedId=await dropdown.getAttribute('value');
      if(norm(selected)!==norm(match.label)||!selectedId||selectedId!==match.value)throw new Error('后台产品分类筛选未选中目标分类');
      await frame.locator('a[action="search_prod_new"]').click();
      const total=await waitUntil(async()=>{
        const count=await parseTotal();if(count===false)return false;
        const rowCount=await rows.count();if(rowCount!==count||count>=beforeTotal)return false;
        const ids=await rows.evaluateAll(ns=>ns.map(n=>n.querySelector('input[name="dataId"]')?.value||''));
        return ids.length===count&&ids.every(Boolean)?count:false;
      },this.mode.interactionTimeoutMs,'产品分类筛选结果加载');
      if(await rows.count()<total){
        const hundred=frame.getByRole('link',{name:'100',exact:true});
        if(await hundred.count()===1)await hundred.click();
        await waitUntil(async()=>await rows.count()===total,this.mode.interactionTimeoutMs,'后台分类产品列表加载（当前专项最多支持单页 100 条）');
      }
      const products=[];
      for(let i=0;i<await rows.count();i++){
        const row=rows.nth(i);
        const data=await row.evaluate(n=>({id:n.querySelector('input[name="dataId"]')?.value||'',name:n.querySelector('a[prodid][title]')?.title||''}));
        if(!data.id||!data.name)throw new Error('后台分类筛选结果缺少产品 ID 或名称');
        data.categories=[this.mode.categoryName];
        products.push(data);
      }
      if(products.length!==total||new Set(products.map(p=>p.id)).size!==total)throw new Error('后台分类筛选结果不完整或产品 ID 重复');
      if(beforeTotal<=total)throw new Error('后台分类筛选没有缩小结果集，无法确认筛选已生效');
      const expected=products;
      Object.assign(record,{status:'passed',failure_reason:'',products,expected_products:expected,category_name:this.mode.categoryName,total,before_total:beforeTotal,filter_option:match.label,filter_id:match.value,captured_at:new Date().toISOString()});
      return record;
    }catch(e){record.status='failed';record.failure_reason=e.message;
      if(backendPage&&!backendPage.isClosed()){
        await mkdir(this.paths.artifacts,{recursive:true});record.screenshot=path.join(this.paths.artifacts,'catalog-failure.png');
        await backendPage.screenshot({path:record.screenshot,fullPage:false}).catch(()=>{});
      }
      throw e;}
    finally{await this.persist();await helper.close();}
  }

  async sourceRoot(frames){
    const id=this.state.types[0].committed_block_id;const candidates=[];
    if(!/^[A-Za-z0-9_-]+$/.test(id))throw new Error('本轮复合区块稳定 ID 缺失');
    for(const frame of frames){const root=frame.locator(`#${id}`);if(await root.count()===1&&await root.isVisible())candidates.push({frame,root});}
    if(candidates.length>1)throw new Error('目标页面存在多个本轮复合区块');
    return candidates[0]||false;
  }

  async clickAndCheck(owner,sourceFrames,stage){
    const record=this.state.linkage[stage];record.status='running';record.started_at=new Date().toISOString();await this.persist();
    const popupPages=[];const onPage=p=>popupPages.push(p);owner.context().on('page',onPage);
    try{
      const source=await waitUntil(()=>this.sourceRoot(sourceFrames()),this.mode.interactionTimeoutMs,'Products 本轮复合区块');
      let beforeKey='',beforeStable=0;
      const expectedIds=this.state.linkage.catalog.expected_products.map(p=>p.id);
      const before=await waitUntil(async()=>{
        const cards=await compositeProductCards(source.root),key=JSON.stringify(cards.map(p=>p.id));
        if(!cards.length||!cards.some(p=>!expectedIds.includes(p.id)))return false;
        if(key!==beforeKey){beforeKey=key;beforeStable=Date.now();return false;}
        return Date.now()-beforeStable>=this.mode.stableMs?cards:false;
      },this.mode.interactionTimeoutMs,'分类点击前产品列表完整加载');
      const group=source.root.locator(GROUP);if(await group.count()!==1)throw new Error('本轮复合区块产品分类组件不唯一');
      const entries=await group.locator('a[href]').evaluateAll(ns=>ns.map((n,index)=>({index,name:n.textContent.replace(/\s+/g,' ').trim(),href:n.getAttribute('href')})).filter(n=>n.name));
      const target=entries.filter(e=>norm(e.name)===norm(this.mode.categoryName));
      if(target.length!==1)throw new Error('复合区块中的目标分类文字链接未唯一匹配');
      const expected=sameSiteCategoryUrl(target[0].href,this.config.publicBaseUrl);
      const originalHost=new URL(source.frame.url()).hostname;
      const beforePath=new URL(source.frame.url()).pathname;
      if(beforePath!==this.mode.publicPath)throw new Error('分类点击起点不是 Products 页面');
      await mkdir(this.paths.artifacts,{recursive:true});
      await source.root.screenshot({path:path.join(this.paths.artifacts,`${stage}-before.png`),animations:'disabled'});
      const targetLink=group.locator('a[href]').nth(target[0].index);
      record.source={path:beforePath,block_id:this.state.types[0].committed_block_id,before_products:before,category_name:target[0].name,category_path:expected.path};await this.persist();
      // The generated group can visually overlap sibling category hitboxes. Focus the exact
      // visible link and try a real pointer click first; if another category covers it,
      // activate the same native link with Enter and retain that fallback in the evidence.
      let interactionMethod='pointer';
      try{await targetLink.click({timeout:Math.min(2500,this.config.timeouts?.actionMs||2500)});}
      catch(error){
        let alreadyNavigated=false;try{alreadyNavigated=new URL(source.frame.url()).pathname===expected.path;}catch{}
        if(alreadyNavigated)interactionMethod='pointer-navigation-after-timeout';
        else if(/intercepts pointer events|Timeout/i.test(error.message)){
          await targetLink.press('Enter',{timeout:this.config.timeouts?.actionMs||10000});
          interactionMethod='keyboard-fallback';record.source.pointer_issue=error.message.split('\n').find(line=>line.includes('intercepts pointer events'))?.trim()||'分类链接无法通过鼠标命中';
        }else throw error;
      }
      record.source.interaction_method=interactionMethod;await this.persist();
      const end=Date.now()+this.mode.interactionTimeoutMs;let stableSince=0,signature='',lastError,result;
      while(Date.now()<end){
        try{
          const matches=[];
          for(const p of [owner,...popupPages].filter(p=>!p.isClosed()))for(const frame of p.frames()){
            let url;try{url=new URL(frame.url());}catch{continue;}
            if(url.pathname===expected.path&&[originalHost,new URL(this.config.publicBaseUrl).hostname].includes(url.hostname))matches.push({p,frame,url});
          }
          if(matches.length>1)throw new Error('分类点击打开多个相同目标页，无法唯一验证');
          if(matches.length!==1){await owner.waitForTimeout(250);continue;}
          const {p,frame,url}=matches[0];
          const surface=await this.sourceRoot([frame]);
          if(!surface)throw new Error('分类页未渲染 Products 模板中的本轮复合区块');
          const cards=await compositeProductCards(surface.root);
          // The backend category filter supplies the expected product set, but
          // it is not the unfiltered baseline. Use the live Products-page
          // snapshot captured immediately before clicking the category link to
          // prove that navigation actually narrows the list.
          const evidence=validateCategoryMembership(cards,this.state.linkage.catalog.expected_products,record.source.before_products);
          // Prove the new block is filtered, not an unrelated native list on the same system page.
          const baselineIds=before.map(x=>x.id),afterIds=cards.map(x=>x.id);
          if(!baselineIds.some(id=>!afterIds.includes(id)))throw new Error('本轮产品列表点击分类前后未发生可区分变化');
          const key=JSON.stringify(afterIds);
          if(key!==signature){signature=key;stableSince=Date.now();}
          if(Date.now()-stableSince>=this.mode.stableMs){
            const screenshot=path.join(this.paths.artifacts,`${stage}-after.png`);
            await surface.root.screenshot({path:screenshot,animations:'disabled'});
            result={...evidence,category_name:this.mode.categoryName,category_path:url.pathname,block_id:this.state.types[0].committed_block_id,
              navigation:'category-products-page',interaction_method:interactionMethod,pointer_issue:record.source.pointer_issue||'',before_ids:baselineIds,products:cards,screenshot,checked_at:new Date().toISOString()};break;
          }
        }catch(e){lastError=e;stableSince=0;signature='';}
        await owner.waitForTimeout(300);
      }
      if(!result)throw new Error(`分类点击后产品验证未通过：${lastError?.message||'未进入本站目标分类页'}`);
      Object.assign(record,{status:'passed',evidence:result,failure_reason:'',finished_at:new Date().toISOString()});
      if(stage==='preview')this.state.page.preview_verified=true;
      else this.state.page.published_verified=true;
      await this.persist();return result;
    }catch(e){record.status='failed';record.failure_reason=e.message;
      const screenshot=path.join(this.paths.artifacts,`${stage}-failure.png`);await owner.screenshot({path:screenshot,fullPage:false}).catch(()=>{});record.screenshot=screenshot;
      await this.persist();throw e;
    }finally{owner.context().off('page',onPage);for(const p of popupPages)if(!p.isClosed())await p.close().catch(()=>{});}
  }

  async openPreview(){
    await this.editor.dismissBlockingDialogs();await this.editor.dismissBlockingDialogs();
    // The menu item is an <li>; the preview destination lives on its nested anchor.
    const links=this.editor.page.locator('.clickToPreview:visible a[target="_blank"][href]');
    const linkCount=await links.count();
    if(linkCount!==1)throw new Error(`预览链接唯一匹配失败：${linkCount} 个`);
    const trigger=links.first();
    const href=await trigger.getAttribute('href');
    let target;try{target=new URL(href,this.editor.page.url());}catch{}
    if(!target||!/^https?:$/.test(target.protocol)||target.hostname!==new URL(this.editor.page.url()).hostname||!target.pathname.includes('/phoenix/pagebuilder/preview'))throw new Error('预览入口地址无法确认');
    const context=this.editor.page.context(),before=new Set(context.pages());
    // Handle timeout immediately; a rejected popup promise must not crash the process while click is still waiting.
    const opened=context.waitForEvent('page',{timeout:8000}).catch(()=>null);
    await trigger.click({timeout:this.config.timeouts.actionMs}).catch(()=>{});
    let page=await opened;
    if(!page)page=context.pages().find(p=>!before.has(p)&&!p.isClosed());
    if(!page){
      // Some builds reuse/close their named preview window after publishing. Open only the observed, validated UI href.
      page=await context.newPage();await page.goto(target.href,{waitUntil:'domcontentloaded'});
      this.state.linkage.preview.opening_source='validated-preview-href';
    }else this.state.linkage.preview.opening_source='ui-popup';
    return page;
  }

  async preview(){
    let page;
    this.state.linkage.preview.status='running';await this.persist();
    try{page=await this.openPreview();await page.waitForLoadState('domcontentloaded');return await this.clickAndCheck(page,()=>page.frames().filter(f=>{try{return new URL(f.url()).pathname===this.mode.publicPath;}catch{return false;}}),'preview');}
    catch(e){this.state.linkage.preview.status='failed';this.state.linkage.preview.failure_reason=e.message;await this.persist();throw e;}
    finally{if(page&&!page.isClosed())await page.close();}
  }

  async previewRender(){
    const page=await this.openPreview();
    try{
      await page.waitForLoadState('domcontentloaded');
      await waitUntil(async()=>{
        const frames=page.frames().filter(f=>{try{return new URL(f.url()).pathname===this.mode.publicPath;}catch{return false;}});
        const source=await this.sourceRoot(frames);
        if(!source)return false;
        return await source.root.locator(GROUP).count()===1&&(await compositeProductCards(source.root)).length>0;
      },this.mode.interactionTimeoutMs,'发布前预览复合区块展示');
      this.state.page.preview_render_verified=true;await this.persist();
    }finally{await page.close();}
  }

  async public(){
    const page=await this.editor.page.context().newPage();
    try{
      await page.waitForTimeout(this.config.ai.publishInitialWaitMs);
      const end=Date.now()+this.config.ai.publishTimeoutMs;
      await waitUntil(async()=>{
        const response=await page.goto(this.state.page.publicUrl,{waitUntil:'domcontentloaded',timeout:20000}).catch(()=>null);
        if(!response?.ok())return false;return this.sourceRoot([page.mainFrame()]);
      },Math.max(1000,end-Date.now()),'发布后本轮复合区块生效');
      return await this.clickAndCheck(page,()=>[page.mainFrame()],'public');
    }finally{await page.close();}
  }
}
