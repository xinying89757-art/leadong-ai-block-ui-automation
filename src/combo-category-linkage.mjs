import path from 'node:path';
import {mkdir} from 'node:fs/promises';
import {DetailContentBrowser} from './ai-detail-content.mjs';
import {pollUntil} from './wait-utils.mjs';
const norm=x=>String(x??'').normalize('NFKC').replace(/\s+/g,' ').trim();
export const linkageModules={
 prod:{name:'产品',manage:'管理产品',category:'测试分类',dropdown:'dropdown_classification_prod_new',search:'search_prod_new',group:'ai-groupProduct',list:'ai-productlist',items:'li.prodlist-site-block',title:'a[title]',titleAttr:'title',titleCell:2},
 article:{name:'文章',manage:'管理文章',category:'测试文章分类',dropdown:'dropdown_classification_article_searchProd',search:'search_article',group:'ai-articleGroup',list:'ai-articlelist',items:'li.artclelist-site-block',title:'.article-title a',titleCell:1},
 video:{name:'视频',manage:'管理视频',category:'视频分类1',select:'#videoGroupId',searchText:'搜索',group:'ai-videoGroup',list:'ai-videoList',items:'li.block_video_item',title:'.video_item_title a',titleCell:2},
 gallery:{name:'图册',manage:'管理图册',category:'图册分类1',select:'#searchGalleryCateId',search:'search_gallery',group:'ai-galleryGroup',list:'ai-galleryList',items:'li.block_listTemp_item',title:'.listTemp_item_title a',titleCell:1},
 download:{name:'下载',manage:'管理下载文件',category:'下载分类1',select:'#searchCateId',search:'search_file',group:'ai-downloadGroup',list:'ai-downloadlist',items:'li.download-site-block',title:'.download-name',titleCell:1},
 faq:{name:'FAQ',manage:'管理FAQ',category:'FAQ分类1',select:'#searchFAQCateId',search:'search_faq',group:'ai-faqGroup',list:'ai-faqList',items:'li.faq-item',title:'.faq-question',titleCell:1},
};
export function assertCategoryContent(actual,expected,before){
 const names=xs=>xs.map(x=>norm(x.name));const a=names(actual),e=names(expected),b=names(before);
 if(!e.length||new Set(e).size!==e.length)throw new Error('后台分类数据为空或同名内容有歧义');
 if(!b.some(x=>!e.includes(x)))throw new Error('分类点击前列表不能证明筛选变化');
 if(new Set(a).size!==a.length||a.length!==e.length||a.some(x=>!e.includes(x)))throw new Error(`分类内容不一致：预期 ${e.length} 条，实际 ${a.length} 条；多余 ${a.filter(x=>!e.includes(x)).join('、')}；缺失 ${e.filter(x=>!a.includes(x)).join('、')}`);
 for(const item of actual){const match=expected.find(x=>norm(x.name)===norm(item.name));if(item.id&&match.id&&item.id!==match.id)throw new Error('分类内容标题一致但稳定 ID 不匹配');}
 return {expected_count:e.length,actual_count:a.length,names:a,passed:true};
}
export function categoryTarget(href,base){const u=new URL(href,base),b=new URL(base);if(u.hostname!==b.hostname||!/^https?:$/.test(u.protocol))throw new Error('分类链接不属于本站');return u;}
const wait=(fn,ms,label)=>pollUntil(fn,{timeoutMs:ms,intervalMs:400,retryOnError:true,message:label});
export class ComboCategoryLinkage{
 constructor(editor,config,state,moduleId,persist){Object.assign(this,{editor,config,state,moduleId,persist});this.def=linkageModules[moduleId];if(!this.def)throw new Error('分类内容类型未配置');this.data=state.category_linkage??={catalog:{status:'pending'},preview:{status:'pending'},public:{status:'pending'}};this.dir=path.join(path.dirname(config.paths.aiStateFile),'category-linkage');this.timeout=60000;}
 rootSelector(){const id=this.state.types[0].committed_block_id;if(!/^[\w-]+$/.test(id||''))throw new Error('本轮组合区块稳定 ID 不明确');return '#'+id;}
 async catalog(){
  if(this.data.catalog.status==='passed')return;
  const helper=new DetailContentBrowser(this.editor.page.context(),this.config);let b;
  try{b=await helper.open();const u=new URL(b.url());u.search='?module='+this.moduleId;await b.goto(u.href,{waitUntil:'domcontentloaded'});const f=b.locator('iframe#'+this.moduleId).contentFrame();await f.getByRole('link',{name:this.def.manage,exact:true}).click();
   const listReady = async()=>/共\s*[\d,]+\s*条记录/.test(await f.locator('body').innerText());
   try { await wait(listReady,5000,'后台内容列表尚未加载'); }
   catch { await f.getByRole('link',{name:this.def.manage,exact:true}).click(); await wait(listReady,this.timeout,'后台内容列表未加载'); }
   if(this.def.dropdown){const trigger=f.locator(`[action="${this.def.dropdown}"]`).first();await trigger.click();const options=f.locator('.imitateSelect:visible li[valueid]');const target=options.filter({hasText:this.def.category});await wait(async()=>await target.count()===1,this.timeout,'后台分类筛选项未唯一匹配');const text=norm(await target.innerText()).split(/->|→/).at(-1).trim();if(text!==this.def.category)throw new Error('后台分类名称不匹配');await target.click();}
   else{let select=this.def.select?f.locator(this.def.select):f.locator('select').filter({has:f.locator('option',{hasText:this.def.category})});if(!this.def.select){const sels=f.locator('select');for(let i=0;i<await sels.count();i++){if(await sels.nth(i).locator('option').filter({hasText:this.def.category}).count()){select=sels.nth(i);break;}}}const options=await select.locator('option').evaluateAll(ns=>ns.map(n=>({label:n.textContent.trim(),value:n.value})));const found=options.filter(x=>x.label===this.def.category);if(found.length!==1)throw new Error('后台分类选择不唯一');await select.selectOption(found[0].value);}
   if(this.moduleId==='article')await f.locator('#articleStatus').selectOption('1');if(this.moduleId==='prod')await f.locator('#searchShowFlag').selectOption('1');
   const search=this.def.search?f.locator(`[action="${this.def.search}"]`).first():f.getByText(this.def.searchText||'查询',{exact:true}).first();await search.click();
   const rows=f.locator('tr').filter({has:f.locator('input[name="dataId"],a[action="gallery_edit"],a[action="download_file_edit"]')});
   let stable='',since=0;const result=await wait(async()=>{const text=await f.locator('body').innerText();const total=Number(text.match(/共\s*([\d,]+)\s*条记录/)?.[1]?.replaceAll(',',''));const records=await rows.evaluateAll((ns,def)=>ns.filter(n=>n.getClientRects().length).map(n=>{const cells=n.querySelectorAll('td');return {id:n.querySelector('input[name=dataId]')?.value||n.getAttribute('galleryid')||'',name:(cells[def.titleCell]?.innerText||'').replace(/\s+/g,' ').trim(),rowText:n.innerText.replace(/\s+/g,' ').trim()};}),this.def);
     if(!total||records.length!==total||records.some(r=>!r.rowText.includes(this.def.category)))return false;const key=JSON.stringify(records);if(key!==stable){stable=key;since=Date.now();return false;}return Date.now()-since>1000?records:false;
   },this.timeout,'后台筛选结果不完整、尚未稳定或未匹配目标分类');
   await mkdir(this.dir,{recursive:true});const shot=path.join(this.dir,'backend.png');await b.screenshot({path:shot});Object.assign(this.data.catalog,{status:'passed',failure_reason:'',category:this.def.category,records:result,screenshot:shot,checked_at:new Date().toISOString()});
  }catch(e){this.data.catalog.status='failed';this.data.catalog.failure_reason=e.message;if(b&&!b.isClosed()){await mkdir(this.dir,{recursive:true});this.data.catalog.screenshot=path.join(this.dir,'backend-failure.png');await b.screenshot({path:this.data.catalog.screenshot}).catch(()=>{});}throw e;}finally{await this.persist();await helper.close();}
 }
 async records(root){const list=root.locator(`[data-block-uuid="${this.def.list}"]`);if(await list.count()!==1)throw new Error('对应列表组件不唯一');return list.locator(this.def.items).evaluateAll((nodes,d)=>nodes.filter(n=>n.getClientRects().length>0).map(n=>{const title=n.querySelector(d.title);return {name:(d.titleAttr?title?.getAttribute(d.titleAttr):title?.textContent||'')?.replace(/\s+/g,' ').trim()||'',id:n.getAttribute('data-pid')||n.getAttribute('data-video-id')||''};}),this.def);}
 async stage(stage){
  if(this.data[stage].status==='passed')return;const result=this.data[stage];result.status='running';await this.persist();let owner;const popups=[];const onPage=p=>popups.push(p);const context=this.editor.page.context();
  try{
   if(stage==='preview'){await this.editor.dismissBlockingDialogs();const link=this.editor.page.locator('.clickToPreview:visible a[target="_blank"][href]').first();const popup=context.waitForEvent('page',{timeout:15000});await link.click();owner=await popup;}else{owner=await context.newPage();await owner.goto(this.state.page.publicUrl,{waitUntil:'domcontentloaded'});}
   await owner.waitForLoadState('domcontentloaded').catch(()=>{});const source=await wait(async()=>{for(const f of owner.frames()){const root=f.locator(this.rootSelector());if(await root.isVisible().catch(()=>false))return{f,root};}return false;},this.timeout,'目标页本轮组合区块未加载');
   const before=await wait(async()=>{const r=await this.records(source.root);return r.length?r:false;},this.timeout,'分类点击前列表未加载');const group=source.root.locator(`[data-block-uuid="${this.def.group}"]`);const links=group.locator('a[href]');const entries=await links.evaluateAll(ns=>ns.map((n,i)=>({i,name:n.textContent.trim(),href:n.getAttribute('href')})));const match=entries.filter(x=>norm(x.name)===this.def.category);if(match.length!==1)throw new Error('前台分类链接未唯一匹配');const target=categoryTarget(match[0].href,this.config.publicBaseUrl);const sourceHost=new URL(source.f.url()).hostname;
   result.category=this.def.category;result.before=before;result.target_path=target.pathname;await this.persist();await source.root.screenshot({path:path.join(this.dir,`${stage}-before.png`)});context.on('page',onPage);
   try{await links.nth(match[0].i).click({timeout:5000});}catch(e){if(!/Timeout|intercepts/.test(e.message))throw e;await links.nth(match[0].i).press('Enter');result.interaction_method='keyboard-fallback';}
   let signature='',since=0;const evidence=await wait(async()=>{const candidates=[];for(const p of [owner,...popups].filter(p=>!p.isClosed()))for(const f of p.frames()){let u;try{u=new URL(f.url());}catch{continue;}if(u.pathname!==target.pathname||![sourceHost,target.hostname].includes(u.hostname))continue;const root=f.locator(this.rootSelector());if(await root.isVisible().catch(()=>false))candidates.push({f,root});}if(candidates.length!==1)return false;const {root}=candidates[0];const actual=await this.records(root);const evidence=assertCategoryContent(actual,this.data.catalog.records,before);const key=JSON.stringify(actual);if(key!==signature){signature=key;since=Date.now();return false;}if(Date.now()-since<1500)return false;const screenshot=path.join(this.dir,`${stage}-after.png`);await root.screenshot({path:screenshot});return{...evidence,actual,screenshot};},this.timeout,'点击分类后数据核对失败或页面未稳定');Object.assign(result,{status:'passed',...evidence,finished_at:new Date().toISOString(),failure_reason:''});
  }catch(e){result.status='failed';result.failure_reason=e.message;if(owner&&!owner.isClosed()){result.screenshot=path.join(this.dir,`${stage}-failure.png`);await owner.screenshot({path:result.screenshot}).catch(()=>{});}throw e;}finally{context.off('page',onPage);for(const p of new Set([owner,...popups]))if(p&&!p.isClosed())await p.close().catch(()=>{});await this.persist();}
 }
 async run(){await this.catalog();for(const stage of ['preview','public']){try{await this.stage(stage);}catch{}}this.data.status=['catalog','preview','public'].every(k=>this.data[k].status==='passed')?'passed':'failed';if(this.data.status==='passed')this.data.failure_reason='';await this.persist();return this.data;}
}
