import path from 'node:path';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { HTML_UPLOAD_STEPS, htmlUploadPassed } from './html-upload-state.mjs';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const names = { pending: '未执行', running: '运行中', passed: '通过', failed: '失败' };
export function shortUploadFailure(message) {
  const text = String(message || '').split('\n')[0];
  if (/Timeout|timeout.*exceeded/i.test(text)) return '界面操作或页面加载等待超时';
  return text.replace(/https?:\/\/\S+/g, '页面地址').replace(/(?:Authorization|Cookie|password|token)\s*[:=]\s*[^\s,;]+/gi, '[敏感信息已隐藏]').slice(0,350);
}

export async function writeHtmlUploadReport(state, paths) {
  const images = [];
  for (const [key, label] of [['editor','编辑器'],['persistence','保存后重新打开'],['preview','预览'],['public','公开页'],['failure','失败现场']]) {
    const file = state.evidence[key]?.screenshot;
    if (!file) continue;
    try {
      const buffer = await readFile(file);
      if (buffer.subarray(0,8).toString('hex') !== '89504e470d0a1a0a') throw new Error('invalid png');
      images.push(`<figure><figcaption>${label}</figcaption><img alt="${label}截图" tabindex="0" src="data:image/png;base64,${buffer.toString('base64')}" /></figure>`);
    } catch { images.push(`<p>${label}：截图不可用</p>`); }
  }
  const rows = HTML_UPLOAD_STEPS.map(([key,label]) => {
    const step = state.steps[key];
    return `<tr><td>${label}</td><td><span class="badge ${escape(step.status)}">${names[step.status] || '结果未确认'}</span></td><td>${escape(shortUploadFailure(step.failure_reason))}</td></tr>`;
  }).join('');
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HTML 上传页面回归报告</title>
<style>body{font:15px/1.6 system-ui,sans-serif;color:#20314a;background:#f4f7fb;margin:0}main{max-width:1200px;margin:32px auto;padding:24px;background:#fff;border-radius:16px}h1{margin-top:0;font-size:26px}.muted{color:#68758a}.badge{display:inline-block;border-radius:6px;padding:3px 12px}.passed{background:#daf5e5;color:#137541}.failed{background:#ffe0e1;color:#b02030}.pending{background:#eef1f5;color:#68758a}.running{background:#e1edff;color:#2467ba}table{width:100%;border-collapse:collapse;margin:24px 0}th,td{text-align:left;border-bottom:1px solid #e3e8ef;padding:12px}a{color:#1469cc}.shots{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:18px}figure{margin:0;background:#f4f7fb;padding:12px;border-radius:10px}figcaption{margin-bottom:8px}figure img{width:100%;max-height:360px;object-fit:contain;object-position:top;cursor:zoom-in}dialog{border:0;border-radius:10px;max-width:94vw;max-height:94vh;padding:18px}dialog::backdrop{background:#102030b8}dialog img{max-width:88vw;max-height:80vh;object-fit:contain}button{padding:8px 18px;cursor:pointer}pre{white-space:pre-wrap}</style>
<main><h1>HTML 上传页面回归报告</h1><p><span class="badge ${htmlUploadPassed(state)?'passed':escape(state.status)}">${htmlUploadPassed(state)?'全部通过':names[state.status] || '结果未确认'}</span></p>
<p class="muted">运行：${escape(state.run_id)} ｜ 站点：${escape(state.site_name)} ｜ 语言：${escape(state.site_language)}<br>累计执行耗时：${Math.round((state.duration_ms || 0)/1000)} 秒 ｜ 执行次数：${state.attempts.length}<br>测试文件：${escape(state.file.original_name)}</p>
<p>测试页面：${escape(state.page.name)}${state.page.id?` ｜ <a href="${escape(state.page.publicUrl)}" target="_blank" rel="noopener">查看发布页面</a>`:''}</p>
<p>展示一致性依据：统一内容区尺寸，核对正文、结构、链接、图片／图表、关键样式及布局。</p>
<table><thead><tr><th>测试点</th><th>结果</th><th>原因</th></tr></thead><tbody>${rows}</tbody></table>
${state.failure_reason?`<p class="failed badge">${escape(shortUploadFailure(state.failure_reason))}</p>`:''}<div class="shots">${images.join('')}</div></main>
<dialog id="lightbox"><button id="close">关闭</button><p><img id="large" alt="放大截图"></p></dialog><script>const box=document.getElementById('lightbox');for(const img of document.querySelectorAll('figure img')){const open=()=>{document.getElementById('large').src=img.src;box.showModal()};img.addEventListener('click',open);img.addEventListener('keydown',e=>{if(e.key==='Enter')open()})}document.getElementById('close').onclick=()=>box.close();box.addEventListener('click',e=>{if(e.target===box)box.close()});</script></html>`;
  for (const file of [paths.report, path.resolve(paths.report,'..','..','latest.html')]) {
    await mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, html);
    await rename(temp, file);
  }
  return paths.report;
}
