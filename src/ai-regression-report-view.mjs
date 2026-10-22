const LABELS = { passed: "通过", failed: "失败", blocked: "阻断", running: "运行中", pending: "未执行", paused: "已暂停" };
const statusKey = (value) => Object.hasOwn(LABELS, value) ? value : "blocked";
const statusLabel = (value) => LABELS[statusKey(value)];
const escapeHtml = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");

// Whitelist business descriptions rather than excerpting prompts or locator logs.
export function businessFailure(value) {
  const text = String(value ?? "").replace(/\u001b\[[0-9;]*m/g, "");
  if (!text) return "";
  if (/页面身份.*不匹配|页面 ID.*不匹配/.test(text)) return '实际页面身份与测试目标不匹配，已停止保存和发布。';
  if (/页面创建.*(?:失败|待确认)/.test(text)) return '页面创建未成功确认，未重复提交创建。';
  if (/页面.*切换.*(?:失败|超时)/.test(text)) return '测试页面已创建，但编辑器切换未成功确认。';
  if (/仍在生成|生成.*待确认/.test(text)) return '记录仍在生成或结果待确认，未按生成失败处理。';
  if (/结果未确认/.test(text)) return "结果未确认，无法唯一关联本轮最终记录。";
  if (/数据不可用/.test(text)) return "数据不可用，无法确认执行结果。";
  if (/页面数量.*(?:最大限制|上限)|页面名额/.test(text)) return "站点页面数量已达到上限，需要释放页面名额或提高上限。";
  if (/authorization|cookie|password|passwd|access_token|token\s*[:=]/i.test(text)) return "错误信息包含敏感内容，已隐藏。";
  if (/产品筛选.*公开页.*(?:占位|未.*筛选字段)/.test(text)) return "产品筛选已全选，但公开页仍显示占位提示，设置效果未通过。";
  if (/当前页面与测试目标不一致/.test(text)) return "生成内容已加载，但未确认切换到本轮测试页，已停止保存和发布。";
  if (/生成失败/.test(text) && /退还|退款/.test(text)) return /已确认.*退款|确认点数全部退还/.test(text)
    ? "AI 生成失败，已核对全额退款。" : "AI 生成失败，平台显示自动退款，余额仍需核对。";
  if (/自定义页面/.test(text) && /超时|Timeout|失败/i.test(text)) return "打开自定义页面列表超时。";
  if (/公开页|前台/.test(text) && /超时|未.*(?:显示|渲染)|失败/.test(text)) return "公开页未在规定时间内显示本轮内容。";
  if (/应用后未.*(?:编辑器|检测)/.test(text)) {
    const type = text.match(/(?:类型\s*|检测到\s*)(静态图文|产品列表|文章列表|视频列表|图册列表|下载列表|FAQ\s*列表|产品分类|文章分类|视频分类|图册分类|下载分类|FAQ\s*分类|产品筛选|导航)/)?.[1];
    return type ? `应用后未在编辑器中检测到${type}区块。` : "应用后未在编辑器中检测到新增区块。";
  }
  if (/生成.*(?:等待超时|超时)/.test(text)) return "生成结果等待超时。";
  const partial = text.match(/(\d+)\s*\/\s*(\d+)\s*区块完成/);
  if (partial) return `整页生成未完成：${partial[2]} 个区块中完成 ${partial[1]} 个。`;
  if (/余额不足|点数不足/.test(text)) return "可用点数不足，已停止后续生成。";
  if (/扣点|扣除|点数/.test(text)) return "点数扣除校验未通过或扣点结果未确认。";
  if (/登录/.test(text)) return "登录验证未通过，未继续操作站点。";
  if (/域名|站点.*(?:匹配|不符)|语言.*(?:匹配|不符)/.test(text)) return "站点或语言校验未通过，已停止操作。";
  if (/全选|筛选字段/.test(text)) return "产品筛选全选设置未成功确认。";
  if (/导航/.test(text)) return "导航配置或链接验证未通过。";
  if (/生成记录.*(?:匹配|唯一)|记录.*(?:多条|找不到)/.test(text)) return "无法唯一匹配本轮生成记录。";
  if (/应用.*(?:不确定|未确认)/.test(text)) return "区块应用结果未确认，需人工检查。";
  if (/加载.*(?:超时|未完成)/.test(text)) return "生成内容未在规定时间内加载完成。";
  if (/预览/.test(text)) return "预览未成功展示本轮内容。";
  if (/保存/.test(text)) return "页面保存未成功确认。";
  if (/发布/.test(text)) return "发布未在规定时间内完成。";
  if (/生成.*失败/.test(text)) return "AI 生成失败，未继续应用。";
  if (/应用/.test(text)) return "生成内容应用未成功完成。";
  if (/上传|图片输入/.test(text)) return "测试图片上传未成功确认。";
  if (/网址|输入/.test(text)) return "输入内容设置未成功确认。";
  return "流程未完成，具体原因需进一步确认。";
}

const step = (label, value, failurePattern) => ({ label, value, failurePattern });
function stepStatus(value) {
  if (value === true || ["succeeded", "applied", "passed", "verified", "completed", "accepted"].includes(value)) return "passed";
  if (value === "failed") return "failed";
  if (["uncertain", "blocked"].includes(value)) return "blocked";
  if (["running", "generating", "applying", "creating", "checking"].includes(value)) return "running";
  return "pending";
}

export function readableCheck(item) {
  const d = item.details || {};
  if (d.reason) return { ...item, steps: [], status: "blocked" };
  const specs = [];
  if (['page-create', 'page-switch'].includes(d.pageFailureStep)) specs.push(step(d.pageFailureStep === 'page-create' ? '页面创建' : '页面切换', 'failed'));
  if (Object.hasOwn(d, "inputStatus")) specs.push(step("输入设置", d.inputStatus, /上传|输入|网址/));
  if (Object.hasOwn(d, "generation")) specs.push(step("生成", d.generation, /生成.*(?:失败|超时)/));
  if (Object.hasOwn(d, "historyReopened")) specs.push(step("重新打开记录", d.historyReopened, /重新打开|记录.*打开/), step("匹配记录", d.historyMatch, /记录.*匹配|唯一/));
  if (d.type === "产品筛选") specs.push(step("全选设置", d.filterSelectAll, /全选|筛选字段/), step("设置应用", d.filterSettings, /筛选.*应用/));
  if (d.type === "导航") specs.push(step("选择两张页面", d.navigationSelectedCount === 2, /导航.*(?:选择|数量)/), step("添加导航", d.navigationAdd, /导航.*添加/), step("保存导航", d.navigationSave, /导航.*保存/));
  if (Object.hasOwn(d, "pointsStatus")) specs.push(step("扣点验证", d.pointsStatus, /点数|扣点|扣除/));
  if (Object.hasOwn(d, "application") || Object.hasOwn(d, "applied")) specs.push(step(Object.hasOwn(d, "historyReopened") ? "从记录添加" : "应用", d.application ?? d.applied, /应用.*(?:失败|超时|不确定)|加载|自定义页面|添加/));
  if (Object.hasOwn(d, "blockIncrement")) specs.push(step("新增一个区块", d.blockIncrement, /数量|新增/));
  specs.push(step("编辑器", d.editor, /编辑器|应用后未.*检测/), step("保存", d.saved, /保存.*(?:失败|超时|未)/), step("预览", d.preview, /预览.*(?:失败|超时|未)/),
    step("发布", d.publishStatus || (d.published === true ? true : "pending"), /发布.*(?:失败|超时)/),
    step("公开页验证", d.published, /(?:公开页|前台).*(?:超时|失败|未)/));
  if (d.type === "导航" || Object.hasOwn(d, "navigation")) specs.push(step("导航链接", d.navigation, /导航|链接/));
  let interrupted = false;
  let precedingComplete = true;
  let dataUnavailable = false;
  const steps = specs.map(({ label, value, failurePattern }) => {
    let status = stepStatus(value);
    // Default false is not a failure. Preserve actual positive evidence even after
    // another check fails (e.g. non-blocking point discrepancies).
    if (status !== "passed") {
      if (interrupted) status = "pending";
      else if (!['blocked', 'running'].includes(status) && failurePattern?.test(d.failure || "")) status = "failed";
      else if (value == null && precedingComplete) { status = "blocked"; dataUnavailable = true; }
    }
    if (!interrupted && label === "扣点验证" && status === "passed" && (!Number.isFinite(d.expectedCost) || !Number.isFinite(d.actualCost))) {
      status = "blocked"; dataUnavailable = true;
    }
    if (["failed", "blocked"].includes(status)) interrupted = true;
    if (status !== "passed") precedingComplete = false;
    return { label, status };
  });
  const status = steps.every((entry) => entry.status === "passed") ? "passed"
    : ["failed", "blocked", "running"].find((key) => steps.some((entry) => entry.status === key)) || "pending";
  return { ...item, status, steps, details: { ...d, dataUnavailable }, resultLabel: status === "pending" && steps.some((entry) => entry.status === "passed") ? "未完成" : statusLabel(status) };
}

function safePageUrl(value) {
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return "";
    for (const key of [...url.searchParams.keys()]) if (/authorization|cookie|password|token|account|login/i.test(key)) url.searchParams.delete(key);
    return url.href;
  } catch { return ""; }
}

function checkHtml(item) {
  const d = item.details || {};
  const steps = (item.steps || []).map((entry) => `<span class="chain-step status-${statusKey(entry.status)}">${escapeHtml(entry.label)}${statusLabel(entry.status)}</span>`).join('<span class="arrow" aria-hidden="true">→</span>');
  const url = safePageUrl(d.publicUrl);
  const pointEvidence = Number.isFinite(d.expectedCost) ? `预期扣除 ${d.expectedCost} 点，${Number.isFinite(d.actualCost) ? `实际扣除 ${d.actualCost} 点` : "实际扣除数据不可用"}` : "";
  const applicationSource = d.applicationSource === 'history' ? '应用来源：本轮生成记录' : d.applicationSource === 'current-result' ? '应用来源：当前生成结果' : '';
  const points = [pointEvidence, applicationSource].filter(Boolean).join('；');
  const reason = businessFailure(d.failure || d.reason);
  const attempts = (d.attempts || []).map(attempt => {
    const reason = businessFailure(attempt.failure || attempt.reason);
    const points = Number.isFinite(attempt.expectedCost) ? `预期扣除 ${attempt.expectedCost} 点，实际扣除 ${Number.isFinite(attempt.actualCost) ? attempt.actualCost : '未确认'} 点` : '';
    const screenshot = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(String(attempt.screenshot || ''))
      ? `<button class="screenshot-thumb" type="button" aria-label="放大${escapeHtml(attempt.label)}截图"><img src="${attempt.screenshot}" alt="${escapeHtml(attempt.label)}截图" loading="lazy"><span>点击放大截图</span></button>`
      : attempt.screenshot ? '<p class="unavailable">截图不可用</p>' : '';
    return `<div><p><strong>${escapeHtml(attempt.label)}</strong> · ${statusLabel(attempt.status)}</p>${reason ? `<p>${escapeHtml(reason)}</p>` : ''}${points ? `<p>${escapeHtml(points)}</p>` : ''}${screenshot}</div>`;
  }).join('');
  const screenshot = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(String(d.screenshot || ""))
    ? `<button class="screenshot-thumb" type="button" aria-label="放大${escapeHtml(item.label)}截图"><img src="${d.screenshot}" alt="${escapeHtml(item.label)}的失败截图" loading="lazy"><span>点击放大截图</span></button>`
    : d.screenshot ? '<p class="unavailable">截图不可用</p>' : "";
  return `<li class="check"><div class="check-heading"><span class="dot status-${statusKey(item.status)}"></span><strong>${escapeHtml(item.label)}</strong><span class="status-chip status-${statusKey(item.status)}">${escapeHtml(item.resultLabel || statusLabel(item.status))}</span></div>${steps ? `<div class="chain">${steps}</div>` : ""}${reason ? `<p class="reason">${escapeHtml(reason)}</p>` : ""}${d.dataUnavailable ? '<p class="unavailable">数据不可用，部分步骤无法确认。</p>' : ""}${d.originalPageUnchanged ? '<p class="warning">失败项已在独立页面补测；原页保留，不代表原页完整链路已修复。</p>' : ''}${d.polishWarning ? '<p class="warning">提示词润色失败，已记录并使用原始提示词继续。</p>' : ""}${points ? `<p class="evidence">${escapeHtml(points)}</p>` : ""}${Number(d.retries) > 0 ? `<p class="evidence">已精准重试 ${Number(d.retries)} 次。</p>` : ""}${url ? `<a class="page-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">查看测试页面</a>` : ""}${screenshot}${attempts ? `<details class="attempts"><summary>查看首次执行与重试证据</summary>${attempts}</details>` : ''}</li>`;
}

export function renderRegressionHtml(report, formatDuration) {
  const counts = Object.entries({ passed: report.passed || 0, failed: report.failed || 0, blocked: report.blocked || 0, running: report.running || 0, pending: report.pending || 0 });
  const total = counts.reduce((sum, [, count]) => sum + count, 0);
  const metrics = counts.map(([key, count]) => `<div class="metric"><span class="status-chip status-${key}">${statusLabel(key)}</span><strong>${count}</strong></div>`).join("");
  const stages = report.stages.map(stage => {
    const retryCount = stage.precise_retry ? stage.item_retry_count : stage.end_retry_count;
    const execution = stage.precise_retry
      ? `首次执行 ${Number(stage.initial_attempts || 0)} 次 · 精准重试 ${Number(retryCount || 0)} 项`
      : `执行 ${Number(stage.attempts || 0)} 次`;
    const retry = retryCount ? (stage.precise_retry ? `精准重试：${Number(retryCount)} 项` : `最终重试：${Number(retryCount)} 次`) : '';
    return `<details class="stage" ${["failed", "blocked"].includes(stage.status) ? "open" : ""}><summary><span class="status-chip status-${statusKey(stage.status)}">${retryCount && stage.status === 'passed' ? '重试后通过' : statusLabel(stage.status)}</span><strong>${escapeHtml(stage.label)}</strong><span class="muted">${formatDuration(stage.duration_ms)} · ${execution}</span></summary><div class="stage-meta">开始：${escapeHtml(stage.started_at || "未开始")}　结束：${escapeHtml(stage.completed_at || "未结束")}${retry ? `<p>${retry}${stage.initial_failure_reason ? `；首次问题：${escapeHtml(businessFailure(stage.initial_failure_reason))}` : ''}</p>` : ''}${stage.failure_reason ? `<p>${escapeHtml(businessFailure(stage.failure_reason))}</p>` : ""}</div><ul class="checks">${stage.checks.map(checkHtml).join("")}</ul></details>`;
  }).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>AI 全量回归报告 - ${escapeHtml(report.runId)}</title><style>
  :root{font:14px/1.65 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#233247;background:#f3f6fb}*{box-sizing:border-box}body{margin:0;padding:32px;max-width:1400px;margin-inline:auto}h1{margin:0;font-size:26px}.muted,.stage-meta,footer{color:#64748b}.hero{background:#fff;border:1px solid #dbe4ef;border-radius:16px;padding:24px}.badge,.status-chip{display:inline-flex;border-radius:999px;padding:3px 10px;font-size:12px;font-weight:700;white-space:nowrap}.status-passed{color:#166534;background:#dcfce7}.status-failed{color:#991b1b;background:#fee2e2}.status-blocked{color:#9a3412;background:#ffedd5}.status-running{color:#1d4ed8;background:#dbeafe}.status-pending,.status-paused{color:#475569;background:#e2e8f0}.summary{display:flex;gap:12px;flex-wrap:wrap;margin-top:20px}.metric{flex:1;min-width:110px;border:1px solid #e2e8f0;border-radius:12px;padding:12px 16px}.metric strong{display:block;font-size:26px;margin-top:5px}.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:8px;margin-top:14px}.stage{background:#fff;border:1px solid #dbe4ef;border-radius:12px;margin:12px 0;overflow:hidden}.stage summary{cursor:pointer;display:flex;gap:12px;align-items:center;padding:15px 18px}.stage summary strong{flex:1}.stage-meta{padding:0 18px 12px;font-size:12px}.stage-meta p{margin:4px 0}.checks{list-style:none;margin:0;padding:0 18px 16px}.check{padding:16px 12px;border-top:1px solid #e2e8f0}.check-heading{display:flex;align-items:center;gap:9px}.check-heading strong{flex:1}.dot{width:9px;height:9px;border-radius:50%;flex-shrink:0}.dot.status-passed{background:#16a34a}.dot.status-failed{background:#dc2626}.dot.status-blocked{background:#ea580c}.dot.status-running{background:#2563eb}.dot.status-pending{background:#94a3b8}.chain{display:flex;gap:5px;align-items:center;flex-wrap:wrap;margin:12px 0}.chain-step{padding:3px 8px;border-radius:5px;font-size:12px;white-space:nowrap}.arrow{color:#94a3b8}.reason{color:#991b1b;margin:8px 0}.warning{color:#9a3412}.evidence{color:#475569;font-size:13px}.page-link{display:inline-block;color:#1763cb;border:1px solid #bfd5ef;padding:5px 12px;border-radius:6px;text-decoration:none}.screenshot-thumb{display:block;background:#fff;border:1px solid #cbd5e1;border-radius:8px;margin-top:12px;padding:6px;max-width:480px;width:100%;cursor:zoom-in;color:#475569}.screenshot-thumb img{width:100%;max-height:260px;object-fit:contain;display:block}.screenshot-thumb span{display:block;padding-top:5px}.unavailable{color:#64748b}.section-title{font-size:19px;margin-top:28px}footer{font-size:12px;margin-top:22px}dialog{width:min(96vw,1500px);max-width:96vw;max-height:94vh;border:0;border-radius:10px;padding:16px;background:#fff}dialog::backdrop{background:#071323cc}.viewer-header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}.viewer-close{cursor:pointer;border:1px solid #cbd5e1;background:#fff;border-radius:5px;padding:6px 15px}dialog img{display:block;width:100%;max-height:78vh;object-fit:contain}.viewer-image[hidden]{display:none}@media(max-width:650px){body{padding:12px}.hero{padding:16px}h1{font-size:21px}.stage summary{flex-wrap:wrap;padding:12px}.stage summary strong{min-width:60%}.checks{padding:0 8px 10px}.chain{gap:4px}}
  </style></head><body><section class="hero"><h1>AI 全量回归测试报告 <span class="badge status-${statusKey(report.status)}">${statusLabel(report.status)}</span></h1><p class="muted">${escapeHtml(report.runId)}</p><div class="meta"><div>站点：${escapeHtml(report.siteName)}</div><div>语言：${escapeHtml(report.siteLanguage)}</div><div>开始：${escapeHtml(report.createdAt || "未开始")}</div><div>${report.completedAt ? "结束" : "结果更新时间"}：${escapeHtml(report.completedAt || report.updatedAt || "未结束")}</div><div>累计执行耗时：<strong>${escapeHtml(report.duration)}</strong></div><div>业务测试点：${total} 个 · 通过率：${total ? Math.round((report.passed || 0) / total * 100) : 0}%</div></div><div class="summary">${metrics}</div></section><h2 class="section-title">阶段与测试点</h2>${stages}<footer>按业务测试点统计，链路步骤不重复计数。灰色步骤表示未执行或尚无完成证据。</footer>
  <dialog id="screenshot-viewer" aria-label="失败截图放大查看"><div class="viewer-header"><strong id="viewer-title">失败截图</strong><button class="viewer-close" type="button">关闭</button></div><img class="viewer-image" alt="放大的失败截图"><p class="viewer-error" hidden>截图不可用</p></dialog>
  <script>(()=>{const viewer=document.getElementById('screenshot-viewer');const expanded=viewer.querySelector('img');const error=viewer.querySelector('.viewer-error');document.querySelectorAll('.screenshot-thumb').forEach(button=>{const thumb=button.querySelector('img');const unavailable=()=>{const note=document.createElement('p');note.className='unavailable';note.textContent='截图不可用';button.replaceWith(note)};thumb.addEventListener('error',unavailable);if(thumb.complete&&thumb.naturalWidth===0)unavailable();button.addEventListener('click',()=>{expanded.hidden=false;error.hidden=true;expanded.src=thumb.src;document.getElementById('viewer-title').textContent=thumb.alt;viewer.showModal()})});expanded.addEventListener('error',()=>{expanded.hidden=true;error.hidden=false});viewer.querySelector('.viewer-close').addEventListener('click',()=>viewer.close());viewer.addEventListener('click',event=>{if(event.target===viewer){const bounds=viewer.getBoundingClientRect();if(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom)viewer.close()}});viewer.addEventListener('keydown',event=>{if(event.key==='Escape')viewer.close()});viewer.addEventListener('close',()=>expanded.removeAttribute('src'))})();</script></body></html>`;
}
