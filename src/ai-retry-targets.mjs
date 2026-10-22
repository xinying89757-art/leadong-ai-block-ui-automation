import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export function itemRetryRunId(runId, key) {
  return `${runId.slice(0, 60)}-r1-${createHash('sha256').update(key).digest('hex').slice(0, 10)}`;
}

const yes = value => value === true;
const firstMissing = entries => entries.find(([, passed]) => !passed)?.[0] || '';

// Shared page checks are checkpoints, not evidence that every generation failed.
export function retryItemFromState(descriptor, state) {
  const unavailable = { ...descriptor, status: 'blocked', failure_step: 'unconfirmed',
    failure_reason: '结果未确认：状态缺失或目标记录不唯一', evidence: { reason: '结果未确认' } };
  if (!state || (!state.page && descriptor.kind !== 'history')) return unavailable;
  let page = state.page, record, history;
  if (['block', 'detail'].includes(descriptor.kind)) {
    const matches = (state.types || []).filter(item => item.type === descriptor.target);
    if (matches.length !== 1) return unavailable;
    record = matches[0];
  } else if (['mode', 'input'].includes(descriptor.kind)) {
    const field = descriptor.kind === 'mode' ? 'mode' : 'input_mode';
    const matches = (state.records || []).filter(item => item[field] === descriptor.target);
    if (matches.length !== 1) return unavailable;
    record = matches[0];
  } else if (descriptor.kind === 'history') {
    const section = state[descriptor.target];
    if (!section?.page || !section?.generation) return unavailable;
    page = section.page; record = section.generation; history = section.history;
  } else record = state.generation;
  if (!record || !page) return unavailable;
  const generation = record.generation_status, application = record.apply_status || record.application_status;
  const editor = yes(record.editor_verified ?? page.editor_verified);
  const preview = yes(record.preview_verified ?? page.preview_verified);
  const published = yes(record.published_verified ?? page.published_verified);
  const filter = record.filter_settings, nav = record.navigation_settings;
  const selectedPages = nav?.selected_pages || [];
  const selectedKeys = selectedPages.map(page => page.path || page.url || page.publicUrl || page.name).filter(Boolean);
  const settingsPassed = descriptor.target === '产品筛选'
    ? yes(filter?.select_all_checked) && yes(filter?.fields_verified) && filter?.apply_status === 'succeeded'
    : descriptor.target === '导航'
      ? nav?.selected_count === 2 && selectedKeys.length === 2 && new Set(selectedKeys).size === 2 &&
        nav?.add_status === 'succeeded' && nav?.save_status === 'succeeded' : true;
  const fields = [
    ...(['block', 'mode', 'input'].includes(descriptor.kind) && ['page-create', 'page-switch'].includes(page.failure_step)
      ? [[page.failure_step, false]] : []),
    ...(descriptor.kind === 'input' ? [['input', record.input_status === 'succeeded']] : []),
    ['generation', generation === 'succeeded'],
    ...(history ? [['history', history.application_source === 'history' && history.reopened === true && history.match_status === 'succeeded']] : []),
    ...(['mode', 'input'].includes(descriptor.kind) ? [['points', record.points_status === 'passed' &&
      Number.isFinite(record.expected_cost) && Number.isFinite(record.actual_cost) && record.actual_cost === record.expected_cost]] : []),
    ['application', application === 'applied'], ['settings', settingsPassed],
    ['editor', editor], ['save', yes(page.saved)], ['preview', preview], ['public', published],
    ...(descriptor.kind === 'history' && descriptor.target === 'block' ? [['block-increment',
      state.block.block_count_after - state.block.block_count_before === 1]] : []),
    ...(descriptor.target === '产品筛选' ? [['public-settings', yes(filter?.public_display_verified)]] : []),
    ...(descriptor.target === '导航' ? [['links', yes(page.public_navigation_verified)]] : []),
  ];
  const step = firstMissing(fields);
  const reason = record.failure_reason || record.input_failure_reason || record.points_failure_reason ||
    filter?.failure_reason || nav?.failure_reason || page.failure_reason || page.publish_failure_reason || '';
  return { ...descriptor, source_run_id: state.run_id, page: structuredClone(page),
    status: step ? 'failed' : 'passed', failure_step: step, failure_reason: step ? reason || `必要步骤未通过：${step}` : '',
    generation_status: generation, application_status: application, committed_block_id: record.committed_block_id || '',
    evidence: { type: record.type || descriptor.target, page: page.name, publicUrl: page.publicUrl,
      pageFailureStep: page.failure_step, applicationSource: record.application_source,
      generation, application, editor, saved: page.saved, preview, published, publishStatus: page.publish_status,
      failure: step ? reason : '', screenshot: record.failure_screenshot || page.failure_screenshot ||
        history?.failure_screenshot || state.generation?.failure_screenshot || '',
      ...(filter ? { filterSelectAll: filter.select_all_checked, filterSettings: filter.apply_status } : {}),
      ...(nav ? { navigationSelectedCount: nav.selected_count, navigationAdd: nav.add_status,
        navigationSave: nav.save_status, navigation: page.public_navigation_verified } : {}),
      ...(['mode', 'input'].includes(descriptor.kind) ? { pointsStatus: record.points_status,
        expectedCost: record.expected_cost, actualCost: record.actual_cost } : {}),
      ...(descriptor.kind === 'input' ? { inputStatus: record.input_status } : {}),
      ...(history ? { historyReopened: history.reopened, historyMatch: history.match_status,
        applicationSource: history.application_source,
        ...(descriptor.target === 'block' ? { blockIncrement: state.block.block_count_after - state.block.block_count_before === 1 } : {}) } : {}),
    },
  };
}

export async function readRetrySource(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

export async function collectStageItems(config, suite, stage) {
  // Follow explicit result associations, never a global "latest" pointer.
  const base = path.join(config.paths.aiLifecycleDir, 'runs', stage.result?.childRunId || stage.child_run_id || suite.run_id);
  const result = stage.result || {};
  const descriptors = [];
  const blocks = (number, types, file) => types.forEach(type => descriptors.push({
    key: `page-${number}:${type}`, kind: 'block', target: type, page_number: number,
    label: `区块页面 ${String(number).padStart(3, '0')} / ${type}`, source_file: file,
  }));
  if (stage.key === 'blocks-page-001') blocks(1, config.ai.types, result.stateFile || path.join(base, 'ai-state.json'));
  if (stage.key === 'blocks-pages-002-003') for (const page of config.ai.followupPages || []) {
    const matched = (result.pages || []).filter(item => Number(item.page) === page.number);
    const file = matched.length === 1 && matched[0].stateFile ||
      (page.number === 2 && result.stateFile) || path.join(base, 'ai-remaining', `page-${String(page.number).padStart(3, '0')}.json`);
    blocks(page.number, page.types, matched.length > 1 ? '' : file);
  }
  if (stage.key === 'details') for (const detail of config.ai.detailPages || []) {
    const matched = (result.pages || []).filter(item => item.type === detail.type);
    descriptors.push({ key: `detail:${detail.type}`, kind: 'detail', target: detail.type, label: `详情 / ${detail.type}`,
      source_file: matched.length > 1 ? '' : matched[0]?.stateFile || path.join(base, 'ai-detail', `${detail.moduleId}.json`) });
  }
  if (stage.key === 'mode-points') for (const mode of config.ai.modePointRegression.modes) descriptors.push({
    key: `mode:${mode.key}`, kind: 'mode', target: mode.key, label: `生成模式 / ${mode.label}`,
    source_file: result.stateFile || path.join(base, 'ai-mode-points/state.json'),
  });
  if (stage.key === 'input-modes') for (const mode of config.ai.inputModeRegression.inputModes) descriptors.push({
    key: `input:${mode.key}`, kind: 'input', target: mode.key, label: `输入方式 / ${mode.label}`,
    source_file: result.stateFile || path.join(base, 'ai-input-modes/state.json'),
  });
  if (stage.key === 'full-page') {
    let file = result.stateFile || path.join(base, 'ai-full-page/state.json');
    if (!result.stateFile) {
      const ids = [...String(stage.failure_reason || '').matchAll(/新运行\s+([a-zA-Z0-9_-]{1,80})(?=\s|$)/g)].map(match => match[1]);
      const unique = [...new Set(ids)];
      if (unique.length > 1) file = '';
      if (unique.length === 1) {
        const candidate = path.join(config.paths.aiLifecycleDir, 'runs', unique[0], 'ai-full-page/state.json');
        const child = await readRetrySource(candidate);
        file = child?.retry?.previous_run_id === (result.childRunId || stage.child_run_id || suite.run_id) ? candidate : '';
      }
    }
    descriptors.push({ key: 'full-page', kind: 'full-page', target: 'full-page', label: '整页生成', source_file: file });
  }
  if (stage.key === 'history-reuse') for (const target of ['full_page', 'block']) descriptors.push({
    key: `history:${target}`, kind: 'history', target,
    label: target === 'full_page' ? '整页生成记录复用' : '区块生成记录复用',
    source_file: result.stateFile || path.join(base, 'ai-history-reuse/state.json'),
  });
  const cache = new Map();
  return Promise.all(descriptors.map(async item => {
    if (!cache.has(item.source_file)) cache.set(item.source_file, readRetrySource(item.source_file));
    return retryItemFromState(item, await cache.get(item.source_file));
  }));
}

export function retryCanRegenerate(item) {
  // Details cannot be moved to another page or duplicated on a system page.
  return item.kind !== 'detail' && !['unconfirmed', 'page-create', 'page-switch'].includes(item.failure_step) &&
    !(item.failure_step === 'generation' && ['running', 'uncertain'].includes(item.generation_status));
}

export function retryIsCheckpointOnly(item) {
  return ['page-create', 'page-switch', 'save', 'preview', 'public', 'links', 'public-settings'].includes(item.failure_step);
}

export function assertRetrySource(config, item, state) {
  if (!state || state.run_id !== item.source_run_id || state.site_name !== config.siteName || state.site_language !== config.siteLanguage) {
    throw new Error('重试来源的运行、站点或语言不匹配，拒绝误操作');
  }
  const page = item.kind === 'history' ? state[item.target]?.page : state.page;
  if (item.page && (page?.name !== item.page.name || page?.path !== item.page.path || page?.publicUrl !== item.page.publicUrl)) {
    throw new Error('重试目标页面身份不一致');
  }
}
