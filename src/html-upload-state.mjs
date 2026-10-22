import path from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export const HTML_UPLOAD_STEPS = [
  ['source', '测试文件有效'], ['upload', 'HTML 上传和解析'], ['creation', '独立页面创建'],
  ['editor', '编辑器展示'], ['save', '页面保存'], ['persistence', '重新打开内容保留'],
  ['preview', '预览展示及与编辑器一致'], ['publish', '发布提交'],
  ['public', '公开页展示及三处一致'],
];

export function validateHtmlUploadConfig(mode) {
  if (!mode?.enabled) throw new Error('HTML 上传专项未启用');
  for (const key of ['filePath', 'pageNamePrefix', 'pagePathPrefix']) {
    if (typeof mode[key] !== 'string' || !mode[key].trim()) throw new Error(`HTML 上传配置缺少 ${key}`);
  }
  for (const key of ['uploadTimeoutMs', 'renderTimeoutMs', 'stableMs', 'contentWidth', 'contentHeight',
    'publishPollIntervalMs', 'publishTimeoutMs']) {
    if (!Number.isInteger(mode[key]) || mode[key] <= 0) throw new Error(`HTML 上传 ${key} 必须为正整数`);
  }
  for (const key of ['layoutTolerancePx', 'publishInitialWaitMs']) {
    if (!Number.isFinite(mode[key]) || mode[key] < 0) throw new Error(`HTML 上传 ${key} 必须非负`);
  }
  return mode;
}

export function validateHtmlFile(file, buffer) {
  if (!/\.html?$/i.test(file)) throw new Error('只支持 .html 或 .htm 测试文件');
  if (!buffer.length || buffer.length > 10 * 1024 * 1024) throw new Error('HTML 文件必须非空且不超过 10MB');
  if (!/<(?:html|body|main|div|section|article)\b/i.test(buffer.toString('utf8'))) throw new Error('文件没有有效 HTML 页面内容');
  return { sha256: createHash('sha256').update(buffer).digest('hex'), size: buffer.length };
}

export function htmlUploadPaths(config, runId) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(runId || '')) throw new Error('run-id 格式无效');
  const root = path.join(config.paths.aiLifecycleDir, 'runs', runId, 'html-upload');
  const reportRoot = path.resolve(config.paths.aiRegressionReportsDir, '..', 'html-upload', runId);
  return { root, state: path.join(root, 'state.json'), active: path.join(config.paths.aiLifecycleDir, 'html-upload-active.json'),
    artifacts: path.join(config.paths.artifactsDir, '..', '..', 'output', 'playwright', 'html-upload', runId),
    report: path.join(reportRoot, 'report.html') };
}

export function newHtmlUploadState(config, runId, filePath, metadata) {
  htmlUploadPaths(config, runId);
  const mode = config.htmlUploadRegression;
  const name = `${mode.pageNamePrefix}${runId}`;
  const pagePath = `/${mode.pagePathPrefix}${runId}.html`;
  return { version: 1, mode: 'html-upload', run_id: runId, site_name: config.siteName, site_language: config.siteLanguage,
    created_at: new Date().toISOString(), updated_at: '', duration_ms: 0, status: 'pending',
    file: { path: filePath, original_name: path.basename(filePath), upload_name: `${name}.html`, ...metadata },
    page: { name, path: pagePath, publicUrl: new URL(pagePath, config.publicBaseUrl).href, id: '', block_id: '', content_id: '' },
    upload: { status: 'pending', record_id: '', submitted_at: '', last_status: '', receipt: null },
    steps: Object.fromEntries(HTML_UPLOAD_STEPS.map(([key]) => [key, { status: 'pending' }])),
    evidence: {}, attempts: [], failure_reason: '', failure_step: '' };
}

export function assertHtmlUploadState(state, config, runId) {
  if (state?.mode !== 'html-upload' || state.run_id !== runId || state.site_name !== config.siteName ||
    state.site_language !== config.siteLanguage) throw new Error('HTML 上传状态与当前运行或站点不匹配');
  const expected = newHtmlUploadState(config, runId, state.file.path, {});
  if (state.page?.name !== expected.page.name || state.page?.path !== expected.page.path) throw new Error('HTML 上传测试页归属无法确认');
  return state;
}

export function htmlUploadPassed(state) {
  return HTML_UPLOAD_STEPS.every(([key]) => state?.steps?.[key]?.status === 'passed') &&
    Boolean(state.page.id && state.page.content_id && state.page.block_id) &&
    state.evidence.preview_comparison?.passed === true && state.evidence.public_comparison?.passed === true;
}

export function htmlUploadResumeAction(state) {
  if (htmlUploadPassed(state)) return 'complete';
  if (state.page?.id) return 'verify-existing-page';
  if (state.creation_submitted_at) return 'recover-created-page';
  if (state.upload?.record_id) return 'recover-upload-record';
  if (state.upload?.submitted_at) throw new Error('上传已提交但任务回执不确定，需核查历史记录，禁止重复上传');
  return 'upload';
}

export function uniqueUploadRecord(records, id) {
  const found = records.map((record, index) => ({ record, index })).filter(item => item.record.id === id);
  if (found.length !== 1) throw new Error('上传历史记录未唯一匹配本轮任务，禁止使用其他记录');
  return found[0];
}

export function parseUploadResponse(value, httpOk = true) {
  if (!httpOk || value?.code !== 200 || !value.data) throw new Error('HTML 上传接口返回业务失败');
  const data = value.data;
  if (/^(failed|error)$/i.test(data.status || '')) throw new Error(`HTML 解析失败：${String(data.message || data.error || '平台返回失败').slice(0,200)}`);
  return { record_id: data.pageRecordId || data.id || '', status: data.status || '', stage: data.stage || '',
    blocks_total: data.blocksTotal ?? data.blockCount ?? null, blocks_done: data.blocksDone ?? null,
    failed_count: data.failedCount ?? 0, file_name: data.fileName || '' };
}

// Compare rendered imported content, excluding the site's own header/footer and editor chrome.
export function compareHtmlRendering(reference, actual, tolerance = 2) {
  const differences = [];
  if (!reference || !actual) return { passed: false, differences: ['页面内容数据不可用'] };
  for (const [key, label] of [['text', '正文'], ['structure', '内容结构'], ['links', '链接'], ['media', '图片和图表']]) {
    if (JSON.stringify(reference[key]) !== JSON.stringify(actual[key])) differences.push(`${label}不一致`);
  }
  if (reference.broken_images || actual.broken_images) differences.push('存在未加载成功的图片');
  if (Math.abs(reference.width - actual.width) > tolerance) differences.push('内容宽度不一致');
  if (reference.samples?.length !== actual.samples?.length) differences.push('样式采样数量不一致');
  for (let i = 0; i < Math.max(reference.samples?.length || 0, actual.samples?.length || 0); i++) {
    const a = reference.samples?.[i], b = actual.samples?.[i];
    if (!a || !b) continue;
    const label = a.label || `内容 ${i+1}`;
    if (JSON.stringify(a.style) !== JSON.stringify(b.style)) differences.push(`${label} 样式不一致`);
    if (['x', 'y', 'width', 'height'].some(key => Math.abs(a.rect[key] - b.rect[key]) > tolerance)) differences.push(`${label} 布局不一致`);
  }
  return { passed: differences.length === 0, differences: [...new Set(differences)], checked_at: new Date().toISOString() };
}

export async function readHtmlUploadState(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
export async function writeHtmlUploadState(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, file);
}
