import path from 'node:path';
import { createHash } from 'node:crypto';
import { compositeScopedConfig } from './ai-composite-state.mjs';
import { createInitialAiState } from './ai-state.mjs';

export function compositeProductsPaths(config, runId) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(runId || '')) throw new Error('运行 ID 无效');
  const root = path.join(config.paths.aiLifecycleDir,'runs',runId,'ai-composite-products');
  const scope=createHash('sha256').update(`${config.siteName}|${config.siteLanguage}|Products`).digest('hex').slice(0,16);
  return {root,state:path.join(root,'state.json'),active:path.join(config.paths.aiLifecycleDir,`composite-products-active-${scope}.json`),
    ownership:path.join(config.paths.aiLifecycleDir,'composite-products-ownership',`${scope}.json`),
    artifacts:path.resolve(config.paths.artifactsDir,'..','..','output','playwright','composite-products',runId),
    report:path.resolve(config.paths.aiRegressionReportsDir,'..','composite-products',runId,'report.html')};
}

export function compositeProductsConfig(config,runId,stateFile) {
  const scoped=compositeScopedConfig(config,runId,stateFile);
  scoped.ai.prompts['复合区块'] += ' This composite block will be inserted into the existing Products system page. Bind the real product category and product list components to the current category page context. Category links must navigate to the corresponding site product category URL and the product list on that page must show products belonging to that category. Preserve the existing system page content.';
  return scoped;
}

export function createCompositeProductsState(config,runId,identity) {
  const mode=config.ai.compositeRegression.productCategoryRegression;
  const scoped=compositeProductsConfig(config,runId,'');
  const state=createInitialAiState(scoped,{number:0,name:mode.systemPage,path:`system:${mode.systemPage}`,
    publicUrl:new URL(mode.publicPath,config.publicBaseUrl).href,target_identity:identity});
  state.mode='ai-composite-products';state.duration_ms=0;state.attempts=[];
  state.linkage={category_name:mode.categoryName,catalog:{status:'pending'},preview:{status:'pending'},public:{status:'pending'}};
  state.cleanup={status:'pending',previous_run_id:'',previous_identity:null};
  return state;
}

export function ownedCompositeMatches(candidates,ownership,config,pageId) {
  if(!ownership) return [];
  if(ownership.site_name!==config.siteName||ownership.site_language!==config.siteLanguage||ownership.system_page!=='Products'||
    ownership.system_page_id!==pageId||!ownership.identity?.id) throw new Error('上轮复合区块所有权与 Products 系统页不匹配，禁止删除');
  const matches=candidates.filter(x=>x.identity.id===ownership.identity.id);
  if(matches.length>1) throw new Error('上轮自动化复合区块匹配到多个，禁止删除');
  return matches;
}

export function assertCompositeProductsState(state,config,runId) {
  const mode=config.ai.compositeRegression.productCategoryRegression;
  if(state?.mode!=='ai-composite-products'||state.run_id!==runId||state.site_name!==config.siteName||state.site_language!==config.siteLanguage||
    state.page?.name!==mode.systemPage||state.page?.path!==`system:${mode.systemPage}`||state.types?.length!==1||state.types[0].type!=='复合区块') {
    throw new Error('复合区块分类联动状态与目标站点、Products 系统页或运行 ID 不匹配');
  }
  if(state.linkage?.category_name!==mode.categoryName) throw new Error('恢复时不能更换目标分类，请沿用原配置');
  return state;
}

export function compositeProductsPassed(state) {
  const record=state?.types?.[0];
  return state?.cleanup?.status==='passed'&&record?.apply_status==='applied'&&record.editor_verified===true&&Boolean(record.committed_block_id)&&
    state.page.saved===true&&state.page.persisted_verified===true&&state.page.preview_render_verified===true&&state.page.preview_verified===true&&state.page.published_verified===true&&
    state.linkage.catalog.status==='passed'&&state.linkage.preview.status==='passed'&&state.linkage.public.status==='passed'&&
    state.linkage.preview.evidence?.exact_match===true&&state.linkage.public.evidence?.exact_match===true;
}

export function sameSiteCategoryUrl(href,baseUrl) {
  const url=new URL(href,baseUrl),base=new URL(baseUrl);
  if(!/^https?:$/.test(url.protocol)||url.hostname!==base.hostname||!/-pl\d+\.html$/.test(url.pathname)) throw new Error('产品分类链接不属于当前站点或不是分类页面');
  return {url:url.href,path:url.pathname,category_token:url.pathname.match(/-pl(\d+)\.html$/)[1]};
}

export function validateCategoryMembership(cards,expected,baseline) {
  const ids=cards.map(x=>x.id),expectedIds=expected.map(x=>x.id);
  if(!expectedIds.length) throw new Error('后台目标分类没有可验证的已上架产品');
  if(!ids.length||ids.some(id=>!id)||new Set(ids).size!==ids.length) throw new Error('分类产品列表为空、产品 ID 缺失或重复');
  if(new Set(expectedIds).size!==expectedIds.length) throw new Error('后台预期产品 ID 重复');
  const extra=ids.filter(id=>!expectedIds.includes(id)),missing=expectedIds.filter(id=>!ids.includes(id));
  if(extra.length||missing.length) throw new Error(`分类产品不匹配：缺少 ${missing.length} 个，混入其他分类 ${extra.length} 个`);
  if(!baseline.some(x=>!expectedIds.includes(x.id))) throw new Error('分类测试数据无法区分全部产品与目标分类，不能证明筛选生效');
  return {passed:true,exact_match:true,expected_ids:expectedIds,actual_ids:ids,expected_count:expectedIds.length,actual_count:ids.length,
    excluded_ids:baseline.map(x=>x.id).filter(id=>!expectedIds.includes(id))};
}
