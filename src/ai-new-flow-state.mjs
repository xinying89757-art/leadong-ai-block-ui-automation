import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { readHistoryReuseJson, writeHistoryReuseJson } from './ai-history-reuse-state.mjs';
export const readFlowJson = readHistoryReuseJson;
export const writeFlowJson = writeHistoryReuseJson;
export function validateRunId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) throw new Error('Invalid run-id: use 1–80 letters, digits, hyphens or underscores');
  return value;
}
export function flowConfig(config, flow) {
  if (!['modify', 'result-actions'].includes(flow)) throw new Error('Unknown flow');
  const value = config.ai[flow === 'modify' ? 'modifyRegression' : 'resultActionsRegression'];
  if (!value?.enabled) throw new Error(`${flow} is disabled`);
  for (const key of ['generationTimeoutMs', 'commitTimeoutMs']) if (!Number.isInteger(value[key]) || value[key] <= 0) throw new Error(`Invalid ${key}`);
  const keys = flow === 'modify' ? value.modes : [value.mode];
  if (!Array.isArray(keys) || !keys.length || new Set(keys).size !== keys.length || keys.some(key => !config.ai.generationModes.some(mode => mode.key === key))) throw new Error('Invalid generation modes');
  if (!value.pageNamePrefix?.startsWith(flow === 'modify' ? 'AI修改回归-' : 'AI结果页回归-') || !value.pagePathPrefix?.startsWith(`ai-${flow}-regression-`)) throw new Error('Unsafe page prefix');
  return value;
}
export function flowPaths(config, flow, runId) {
  if (!['modify', 'result-actions'].includes(flow)) throw new Error('Unknown flow');
  validateRunId(runId);
  return { state: path.join(config.paths.aiLifecycleDir, 'runs', runId, `ai-${flow}`, 'state.json'),
    active: path.join(config.paths.aiLifecycleDir, `${flow}-active.json`),
    report: path.resolve('reports', `ai-${flow}`, runId) };
}
export function flowPage(config, flow, runId) {
  const mode = flowConfig(config, flow); validateRunId(runId);
  return { name: `${mode.pageNamePrefix}${runId}`, path: `/${mode.pagePathPrefix}${runId}` };
}
export function createFlowState(config, flow, runId) {
  const mode = flowConfig(config, flow);
  const keys = flow === 'modify' ? ['seed', ...mode.modes] : ['return-modify', 'regenerate-apply', 'exit-discard', 'exit-apply'];
  const state = { version: 1, flow, run_id: validateRunId(runId), site_name: config.siteName, site_language: config.siteLanguage,
    created_at: new Date().toISOString(), status: 'pending', page: { ...flowPage(config, flow, runId), create_status: 'pending', cleanup_status: 'pending' },
    steps: keys.map((key, index) => ({ key, status: 'pending', token: `AI${flow === 'modify' ? 'Modify' : 'Result'}${index}${runId.replace(/[-_]/g, '')}`, generation_status: 'pending', application_status: 'pending', evidence: [] })), evidence: [], diagnostics: [] };
  if (flow === 'result-actions') for (const step of state.steps.slice(1)) step.page = {
    name: `${mode.pageNamePrefix}${step.key}-${runId}`, path: `/${mode.pagePathPrefix}${step.key}-${runId}`,
    create_status: 'pending', cleanup_status: 'pending' };
  return state;
}
export function assertFlowState(state, config, flow, runId) {
  const expected = createFlowState(config, flow, runId);
  if (state?.version !== 1 || state.flow !== flow || state.run_id !== runId || state.site_name !== config.siteName || state.site_language !== config.siteLanguage) throw new Error('State identity mismatch');
  if (state.page?.name !== expected.page.name || state.page?.path !== expected.page.path) throw new Error('Page ownership mismatch');
  if (state.steps?.length !== expected.steps.length || state.steps.some((step, i) => step.key !== expected.steps[i].key || step.token !== expected.steps[i].token)) throw new Error('Step configuration mismatch');
  for (let i = 0; i < state.steps.length; i++) {
    const page = state.steps[i].page, expectedPage = expected.steps[i].page;
    if (page && (!expectedPage || page.name !== expectedPage.name || page.path !== expectedPage.path)) throw new Error('Step page ownership mismatch');
  }
  return true;
}
export function assertCreditDelta(before, after, expected) {
  if (![before, after, expected].every(Number.isFinite) || before < 0 || after < 0 || expected <= 0 || before - after !== expected) throw new Error(`Credit delta mismatch: ${before} → ${after}; expected ${expected}`);
  return { before, after, expected_cost: expected, actual_cost: before - after, passed: true };
}
export function assertPromptPreserved(expected, actual) {
  if (actual !== expected) throw new Error('返回修改 did not preserve the original prompt');
  return true;
}
export function assertHistoryIncrement(before, after) {
  if (!Number.isInteger(before) || before < 0 || after !== before + 1) throw new Error(`History count mismatch: ${before} → ${after}; expected +1`);
  return true;
}
export function assertModification(before, after, token, oldToken) {
  if (!after.includes(token) || before === after || oldToken && after.includes(oldToken)) throw new Error(`Modified block does not contain only the new heading ${token}`);
  return true;
}
export function resumeStepAction(step) {
  if (step.status === 'passed') return 'skip';
  if (step.application_status === 'applying') return 'verify-commit';
  if (step.application_status === 'discarding') return 'verify-discard';
  if (step.generation_status === 'pending') return 'generate';
  return 'recover';
}
export function renderFlowReport(state) {
  const rows = state.steps.map(step => `| ${step.key} | ${step.status} | ${(step.charges ?? []).map(c => `${c.before} → ${c.after ?? 'pending'} (${c.actual_cost ?? 'pending'})`).join('; ')} | ${String(step.failure_reason || step.preview_failure || '').replace(/\s+/g, ' ')} |`);
  return `# AI ${state.flow}: ${state.run_id}\n\nStatus: ${state.status}\n\nDuration: ${state.duration_ms ?? 'running'} ms\n\n${state.failure_reason || ''}\n\nPage: ${state.page.name} (${state.page.path})\n\n| Step | Status | Points | Failure |\n| --- | --- | --- | --- |\n${rows.join('\n')}\n\n${state.conclusion ?? ''}\n\nEvidence:\n${[...state.evidence, ...state.steps.flatMap(step => step.evidence)].map(file => `- ${file}`).join('\n')}\n`;
}
export function parseHistoryBadge(text) {
  const match = String(text ?? '').match(/生成记录\s*(\d+)\s*$/);
  if (!match) throw new Error('Invalid history badge');
  return Number(match[1]);
}

export async function createExclusiveFlowState(file, state) {
  await mkdir(path.dirname(file), { recursive: true });
  try { await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx' }); }
  catch (error) { if (error.code === 'EEXIST') throw new Error(`Run ${state.run_id} already exists; use resume`); throw error; }
}
export function previewTarget(href, editorUrl) {
  if (!href) throw new Error('Missing preview link');
  const origin = new URL(editorUrl), target = new URL(href, editorUrl);
  if (target.host !== origin.host || !/^\/phoenix\/pagebuilder\/preview(?:\/|$)/.test(target.pathname)) throw new Error('Unexpected preview destination');
  target.protocol = origin.protocol; return target.toString();
}
export function assertDiscardedSnapshot(before, after) {
  if (!before || !after || !Number.isInteger(before.count) || before.count !== after.count ||
      before.ids.length !== before.count || JSON.stringify(before.ids) !== JSON.stringify(after.ids)) throw new Error('Discard changed committed block identities');
  return true;
}
export function selectOwnedHistoryRecord(texts, expectedCount) {
  if (!Number.isInteger(expectedCount) || expectedCount < 1 || texts.length !== expectedCount) throw new Error('Owned generation history is ambiguous');
  const records = texts.map((text, index) => {
    const timestamp = text.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/)?.[0];
    if (!timestamp) throw new Error('Owned history record has no readable timestamp');
    return { index, timestamp, text };
  }).sort((a,b) => b.timestamp.localeCompare(a.timestamp));
  if (records.length > 1 && records[0].timestamp === records[1].timestamp) throw new Error('Owned history timestamps are ambiguous');
  if (/生成失败|已自动退还/.test(records[0].text)) throw new Error('Owned generation failed on the platform');
  return { index: records[0].index, timestamp: records[0].timestamp };
}
