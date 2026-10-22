import { readFile,mkdir,writeFile,rename } from 'node:fs/promises';
import path from 'node:path';
import { compositeProductsPassed } from './ai-composite-products-state.mjs';

const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export async function writeCompositeProductsReport(state,paths){
  const record=state.types[0],linkage=state.linkage;
  const items=[['运行前清理上轮自动化区块',state.cleanup.status==='passed',''],['Products 系统页生成复合区块',record.generation_status==='succeeded',record.failure_reason],
    ['应用及编辑器展示',record.apply_status==='applied'&&record.editor_verified,''],['保存并重新打开',state.page.saved&&state.page.persisted_verified,''],
    ['发布前预览内容展示',state.page.preview_render_verified,''],
    ['内容后台确认产品分类归属',linkage.catalog.status==='passed',linkage.catalog.failure_reason],
    ['预览：点击分类 → 目标分类页 → 本轮产品列表',linkage.preview.status==='passed',linkage.preview.failure_reason],
    ['公开页：点击分类 → 目标分类页 → 本轮产品列表',linkage.public.status==='passed',linkage.public.failure_reason]];
  const rows=items.map(([label,ok,reason])=>{
    if(ok)reason='';
    const status=ok?'passed':/待确认|仍在生成|状态不确定/.test(reason||'')?'blocked':reason?'failed':label==='Products 系统页生成复合区块'&&record.generation_status==='running'?'running':'pending';
    const labels={passed:'通过',failed:'失败',blocked:'待确认',running:'运行中',pending:'未执行'};
    return `<tr><td>${esc(label)}</td><td class="${status}">${labels[status]}</td><td>${esc((reason||'').split('\n')[0].slice(0,300))}</td></tr>`;
  }).join('');
  const images=[];
  for(const [file,label] of [['editor.png','Products 编辑器'],['preview-before.png','预览：点击前'],['preview-after.png','预览：点击后'],['public-before.png','公开页：点击前'],['public-after.png','公开页：点击后'],['catalog-failure.png','后台产品数据核对现场'],['preview-failure.png','预览失败现场'],['public-failure.png','公开页失败现场'],['failure.png','运行失败现场']]){
    try{const b=await readFile(path.join(paths.artifacts,file));images.push(`<figure><figcaption>${label}</figcaption><img alt="${label}" tabindex="0" src="data:image/png;base64,${b.toString('base64')}"></figure>`);}catch{}
  }
  const renderResult=(stage,label)=>{
    const result=linkage[stage],e=result.evidence;if(!e)return '';
    const method=e.interaction_method==='keyboard-fallback'?'鼠标点击被页面重叠元素挡住，改用键盘回车激活':e.interaction_method==='pointer-navigation-after-timeout'?'鼠标点击后页面已完成跳转':e.interaction_method==='pointer'?'鼠标点击':'';
    const beforeTotal=linkage.catalog.before_total;
    return `<p>${label}：分类“${esc(e.category_name)}”，后台筛选${beforeTotal?` ${beforeTotal} → ${e.expected_count} 个`:''}，预期 ${e.expected_count} 个产品，实际 ${e.actual_count} 个，产品 ID 集合${e.exact_match?'一致':'不一致'}。${e.products?.map(p=>esc(p.name)).join('、')||''}${method?`；${method}`:''}</p>`;
  };
  const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>复合区块产品分类交互回归</title><style>
body{font:15px/1.7 system-ui,sans-serif;background:#f4f7fb;color:#22344e;margin:0}main{max-width:1180px;background:white;margin:30px auto;padding:26px;border-radius:16px}h1{font-size:25px}.passed{color:#147745;background:#e3f6eb}.failed{color:#ad2432;background:#ffe5e8}.blocked{color:#9b5f05;background:#fff0d6}.running{color:#2467ba;background:#e1edff}.pending{color:#748092;background:#eef1f5}table{width:100%;border-collapse:collapse;margin:20px 0}td,th{padding:12px;text-align:left;border-bottom:1px solid #e4e9ef}a{color:#1266cc}.images{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:18px}figure{margin:0;background:#f4f7fb;padding:10px}figure img{width:100%;max-height:350px;object-fit:contain;cursor:zoom-in}dialog{border:0;border-radius:10px;max-width:94vw;max-height:94vh}dialog::backdrop{background:#132238b8}dialog img{max-width:88vw;max-height:80vh}button{padding:7px 18px;cursor:pointer}</style><main>
<h1>复合区块产品分类交互回归</h1><p class="${compositeProductsPassed(state)?'passed':state.status==='failed'?'failed':'pending'}">${compositeProductsPassed(state)?'全部通过':state.status==='failed'?'验证未通过':'执行中'}</p>
<p>运行：${esc(state.run_id)} ｜ 站点：${esc(state.site_name)} ｜ 系统页：Products<br>累计执行耗时：${Math.round((state.duration_ms||0)/1000)} 秒</p>
<p>生成复合区块 → 应用到 Products → 保存 → 检查预览内容 → 发布 → 分别从预览和公开页点击分类并核对产品</p><p><a href="${esc(state.page.publicUrl)}" target="_blank" rel="noopener">查看 Products 页面</a></p>
<table><thead><tr><th>测试点</th><th>结果</th><th>原因</th></tr></thead><tbody>${rows}</tbody></table>${renderResult('preview','预览')}${renderResult('public','公开页')}
<p>本轮保留区块供查看；下一轮开始前仅删除所有权记录唯一匹配的自动化区块，保留原有页面内容。</p><div class="images">${images.join('')}</div></main>
<dialog id="viewer"><button id="close">关闭</button><p><img id="large" alt="放大截图"></p></dialog><script>const v=document.getElementById('viewer');for(const img of document.querySelectorAll('figure img')){const open=()=>{document.getElementById('large').src=img.src;v.showModal()};img.onclick=open;img.onkeydown=e=>{if(e.key==='Enter')open()}}document.getElementById('close').onclick=()=>v.close();v.onclick=e=>{if(e.target===v)v.close()};</script></html>`;
  await mkdir(path.dirname(paths.report),{recursive:true});const temp=`${paths.report}.${process.pid}.tmp`;
  await writeFile(temp,html);await rename(temp,paths.report);return paths.report;
}
