import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { loadConfig } from '../src/config.mjs';
import { createInitialAiState } from '../src/ai-state.mjs';
import { createRegressionState, writeRegressionJson, readRegressionJson } from '../src/ai-regression-state.mjs';
import { executeRegressionStages } from '../src/ai-regression-execution.mjs';
import { retryItemFromState, collectStageItems, itemRetryRunId, retryIsCheckpointOnly } from '../src/ai-retry-targets.mjs';
import { scopedRetryConfig, runRetryTarget, detailRetryAction } from '../src/ai-item-retry.mjs';
import { AiPagedAutomation } from '../src/ai-paged-runner.mjs';
import { AiHistoryReuseAutomation } from '../src/ai-history-reuse-runner.mjs';
import { normalizeRegressionReport, buildRegressionHtml, writeRegressionReport } from '../src/ai-regression-report.mjs';
import { createModePointsState } from '../src/ai-mode-points-state.mjs';
import { committedIdentityCount, committedIdentityEvidence } from '../src/ai-canvas-commit.mjs';
import { AiBlockAutomation } from '../src/ai-runner.mjs';
import { AiInputModesAutomation } from '../src/ai-input-modes-runner.mjs';
import { createInputModeState } from '../src/ai-input-modes-state.mjs';

function blockState(config, types, number = 3) {
  const state = createInitialAiState({ ...config, ai: { ...config.ai, runId: 'original', types } },
    { number, name: `测试-${number}`, path: `/test-${number}`, publicUrl: `https://example.test/test-${number}` });
  Object.assign(state.page, { saved: true, editor_verified: true, preview_verified: true, published_verified: true,
    public_navigation_verified: true, types: [...types] });
  for (const [index, record] of state.types.entries()) {
    Object.assign(record, { generation_status: 'succeeded', apply_status: 'applied', editor_verified: true,
      preview_verified: true, published_verified: true, committed_block_id: `block-${index}` });
    if (record.filter_settings) Object.assign(record.filter_settings, {
      select_all_checked: true, fields_verified: true, selection_status: 'succeeded', apply_status: 'succeeded', public_display_verified: true,
    });
    if (record.navigation_settings) Object.assign(record.navigation_settings, {
      selected_count: 2, selected_pages: [{ name: 'A' }, { name: 'B' }], add_status: 'succeeded', save_status: 'succeeded',
    });
  }
  return state;
}

function descriptor(target = '导航', file = 'fixture.json') {
  return { key: `page-3:${target}`, kind: 'block', target, page_number: 3, label: `区块页面 003 / ${target}`, source_file: file };
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ai-item-retry-'));
  const config = await loadConfig(); config.paths.aiLifecycleDir = root;
  return { root, config };
}

test('导航配置失败不能因页面和已应用标记而跳过，其他九项保持通过', async () => {
  const { root, config } = await fixture();
  const suite = createRegressionState(config, 'original');
  const stage = suite.stages[1]; stage.status = 'failed';
  const p2 = config.ai.followupPages[0], p3 = config.ai.followupPages[1];
  const second = blockState(config, p2.types, 2), third = blockState(config, p3.types, 3);
  third.types.at(-1).navigation_settings.save_status = 'failed';
  const f2 = path.join(root, 'p2.json'), f3 = path.join(root, 'p3.json');
  await writeRegressionJson(f2, second); await writeRegressionJson(f3, third);
  stage.result = { pages: [{ page: 2, stateFile: f2 }, { page: 3, stateFile: f3 }] };
  const items = await collectStageItems(config, suite, stage);
  assert.equal(items.filter(item => item.status === 'passed').length, 9);
  assert.deepEqual(items.filter(item => item.status !== 'passed').map(item => [item.target, item.failure_step]), [['导航', 'settings']]);
  suite.stages.forEach(other => { if (other !== stage) other.status = 'passed'; });
  const calls = [];
  await executeRegressionStages(suite, config.ai.regressionSuite, {
    execute: async () => assert.fail('不能重新执行页面002、003'), collectItems: s => collectStageItems(config, suite, s),
    persist: async () => {}, executeRetry: async (_, args) => {
      calls.push(args.item.target); assert.equal(args.item.retry_count, 1);
      return { ok: true, item: { ...args.item, status: 'passed' } };
    },
  });
  assert.deepEqual(calls, ['导航']); assert.equal(stage.status, 'passed');
});

test('两个失败类型仅两项补测；独立页面配置不包含任何通过类型', async () => {
  const config = await loadConfig(), suite = createRegressionState(config, 'two-failures');
  suite.stages.forEach(stage => { stage.status = 'passed'; }); suite.stages[1].status = 'failed';
  const items = ['图册分类', '产品筛选', '导航'].map(type => ({ ...descriptor(type), status: type === '图册分类' ? 'passed' : 'failed', failure_step: 'settings' }));
  const calls = [];
  await executeRegressionStages(suite, config.ai.regressionSuite, { execute: async () => assert.fail(),
    collectItems: async () => items, persist: async () => {}, executeRetry: async (_, args) => {
      const scoped = scopedRetryConfig(config, args.item, args.runId, 'retry.json');
      calls.push(scoped.ai.types); assert.equal(scoped.ai.blocksPerPage, 1);
      assert.equal(scoped.ai.followupPages.length, 0);
      return { ok: true, item: { ...args.item, status: 'passed' } };
    } });
  assert.deepEqual(calls, [['产品筛选'], ['导航']]);
});

test('保存、预览、公开页失败只恢复检查点，不允许生成', async () => {
  for (const step of ['save', 'preview', 'public']) {
    const { root, config } = await fixture();
    const source = path.join(root, 'original.json'), state = blockState(config, ['静态图文']);
    const record = state.types[0];
    if (step === 'save') state.page.saved = false;
    if (step === 'preview') record.preview_verified = false;
    if (step === 'public') record.published_verified = false;
    await writeRegressionJson(source, state);
    const item = retryItemFromState(descriptor('静态图文', source), state);
    assert.equal(item.failure_step, step); assert.equal(retryIsCheckpointOnly(item), true);
    const original = await readFile(source, 'utf8');
    const task = { item, run_id: itemRetryRunId('original', item.key) };
    const result = await runRetryTarget({}, config, task, path.join(root, 'task.json'), {
      repair: async (_, __, ___, copy) => { copy.page.saved = true; copy.types[0].preview_verified = true; copy.types[0].published_verified = true; return copy; },
      regenerate: async () => assert.fail('页面检查点不允许重新生成'),
    });
    assert.equal(result.ok, true); assert.equal(await readFile(source, 'utf8'), original);
  }
});

test('导航原页修复成功但随后发布超时，不可因此重新生成导航', async () => {
  const { root, config } = await fixture();
  const state = blockState(config, ['导航']), source = path.join(root, 'source.json');
  state.types[0].navigation_settings.save_status = 'failed'; await writeRegressionJson(source, state);
  const item = retryItemFromState(descriptor('导航', source), state);
  await assert.rejects(runRetryTarget({}, config, { item, run_id: 'retry' }, path.join(root, 'task.json'), {
    repair: async (_, __, ___, copy, file) => {
      copy.types[0].navigation_settings.save_status = 'succeeded'; copy.types[0].published_verified = false;
      await writeRegressionJson(file, copy); throw new Error('公开页等待超时');
    }, regenerate: async () => assert.fail('禁止把发布异常当成生成异常'),
  }), /公开页等待超时/);
});

test('无法修复的已插入区块另页补跑，原始状态及通过区块不改动', async () => {
  const { root, config } = await fixture(), state = blockState(config, ['静态图文', '导航']);
  const source = path.join(root, 'source.json'); state.types[1].navigation_settings.save_status = 'failed';
  await writeRegressionJson(source, state); const original = await readFile(source, 'utf8');
  const item = retryItemFromState(descriptor('导航', source), state), events = [];
  const task = { item, run_id: 'navigation-retry' }, file = path.join(root, 'task.json');
  const result = await runRetryTarget({ goto: async () => events.push('isolate') }, config, task, file, {
    repair: async () => { events.push('repair'); throw new Error('导航设置未生效'); },
    regenerate: async (_, scoped) => { events.push(...scoped.ai.types); return blockState(config, scoped.ai.types); },
  });
  assert.deepEqual(events, ['repair', 'isolate', '导航']); assert.equal(result.ok, true);
  assert.equal(result.result.application, 'isolated-retry-page'); assert.equal(await readFile(source, 'utf8'), original);
  const replayed = await runRetryTarget({}, config, await readRegressionJson(file), file, {
    repair: async () => assert.fail(), regenerate: async () => assert.fail('已完成重试不能重复扣点'),
  });
  assert.deepEqual(replayed, JSON.parse(JSON.stringify(result)));
});

test('共享发布检查点恢复后其余失败项直接通过，不重复操作页面', async () => {
  const config = await loadConfig(), suite = createRegressionState(config, 'checkpoint');
  suite.stages.forEach(stage => { stage.status = 'passed'; }); suite.stages[0].status = 'failed';
  const items = ['静态图文', '产品列表'].map(type => ({ ...descriptor(type), status: 'failed', failure_step: 'public' }));
  let calls = 0;
  await executeRegressionStages(suite, config.ai.regressionSuite, { execute: async () => assert.fail(),
    collectItems: async () => items, persist: async () => {}, executeRetry: async (_, { item }) => {
      calls++; return { ok: true, item: { ...item, status: 'passed' }, recoveredItems: items.map(item => ({ ...item, status: 'passed' })) };
    } });
  assert.equal(calls, 1); assert.equal(suite.stages[0].status, 'passed');
});

test('三模式与输入方式精准范围仅包含失败项', async () => {
  const config = await loadConfig();
  const modes = scopedRetryConfig(config, { kind: 'mode', target: 'advanced' }, 'retry', 'state.json');
  assert.deepEqual(modes.ai.modePointRegression.modes.map(item => item.key), ['advanced']);
  const inputs = scopedRetryConfig(config, { kind: 'input', target: 'image' }, 'retry', 'state.json');
  assert.deepEqual(inputs.ai.inputModeRegression.inputModes.map(item => item.key), ['image']);
  assert.equal(config.ai.modePointRegression.modes.length, 3);
});

test('生成记录复用精准执行不会调用另一条通过分支', async () => {
  const config = await loadConfig(), runner = new AiHistoryReuseAutomation({}, config, 'test');
  runner.initialize = async () => {}; runner.runFullPage = async () => assert.fail('不可重跑整页复用');
  let calls = 0; runner.runBlock = async () => { calls++; };
  await runner.run({ sections: ['block'] }); assert.equal(calls, 1);
  await assert.rejects(runner.run({ sections: ['invalid'] }), /目标无效/);
});

test('旧区块重新检查使用稳定ID而非插入时总数', async () => {
  const config = await loadConfig(), runner = new AiPagedAutomation({}, config);
  runner.state = { types: [{ type: '文章分类', block_count_before: 1, committed_block_id: 'article' }] };
  runner.canvasSnapshot = async () => ({ count: 5, ids: ['a', 'article', 'b', 'c', 'd'] });
  assert.equal(await runner.verifyEditorType('文章分类'), true);
  runner.canvasSnapshot = async () => ({ count: 5, ids: ['a', 'other', 'b', 'c', 'd'] });
  assert.equal(await runner.verifyEditorType('文章分类'), false);
});

test('缺失或重复记录不猜测目标、不整阶段重试', async () => {
  const config = await loadConfig(), suite = createRegressionState(config, 'unconfirmed');
  suite.stages.forEach(stage => { stage.status = 'passed'; }); suite.stages[1].status = 'failed';
  const unknown = retryItemFromState(descriptor(), null);
  assert.equal(unknown.failure_step, 'unconfirmed');
  await executeRegressionStages(suite, config.ai.regressionSuite, { execute: async () => assert.fail(),
    collectItems: async () => [unknown], persist: async () => {}, executeRetry: async () => assert.fail('不能猜测重试项') });
  assert.equal(suite.stages[1].status, 'blocked');
  assert.equal(retryItemFromState(descriptor(), { page: {}, types: [{ type: '导航' }, { type: '导航' }] }).failure_step, 'unconfirmed');
});

test('报告合并通过项与失败补测：一次计数、绿色重试通过、原页未修复说明', async () => {
  const { root, config } = await fixture(), suite = createRegressionState(config, 'report');
  suite.stages = [suite.stages[1]]; const stage = suite.stages[0]; stage.status = 'passed';
  const evidence = { generation: 'succeeded', application: 'applied', editor: true, saved: true, preview: true, published: true };
  stage.retry_items = ['下载列表', '导航'].map((target, index) => ({ ...descriptor(target), status: 'passed', retry_count: index,
    evidence, initial_result: { status: index ? 'failed' : 'passed', evidence: { ...evidence, failure: index ? '导航保存失败' : '' } },
    ...(index ? { final_result: { evidence }, retry_result: { application: 'isolated-retry-page' } } : {}) }));
  const report = await normalizeRegressionReport(config, suite, root);
  assert.equal(report.stages[0].checks.length, 2); assert.equal(report.passed, 2);
  const html = buildRegressionHtml(report);
  assert.match(html, /重试通过/); assert.match(html, /原页保留/); assert.match(html, /首次执行/);
  assert.match(html, /精准重试 1 项/);
  assert.doesNotMatch(html, /状态来源|fixture\.json|source_file/);
});

test('三模式仅进阶失败时，快速和深度不进入重试队列，扣点证据单独保留', async () => {
  const { config, root } = await fixture(), state = createModePointsState(config, 'original');
  Object.assign(state.page, { saved: true, editor_verified: true, preview_verified: true, published_verified: true });
  for (const record of state.records) Object.assign(record, { generation_status: 'succeeded', application_status: 'applied',
    editor_verified: true, preview_verified: true, published_verified: true, points_status: 'passed', actual_cost: record.expected_cost });
  state.records[1].points_status = 'failed'; state.records[1].actual_cost = 11;
  const source = path.join(root, 'modes.json'); await writeRegressionJson(source, state);
  const suite = createRegressionState(config, 'original'); suite.stages.forEach(stage => { stage.status = 'passed'; });
  const stage = suite.stages[3]; stage.status = 'failed'; stage.result = { stateFile: source };
  const calls = [];
  await executeRegressionStages(suite, config.ai.regressionSuite, { execute: async () => assert.fail(),
    collectItems: stage => collectStageItems(config, suite, stage), persist: async () => {},
    executeRetry: async (_, { item }) => {
      calls.push(item.target); assert.equal(item.initial_result.evidence.actualCost, 11);
      return { ok: true, item: { ...item, status: 'passed', evidence: { ...item.evidence, pointsStatus: 'passed', actualCost: 10 } } };
    } });
  assert.deepEqual(calls, ['advanced']);
  assert.equal(stage.retry_items[1].initial_result.evidence.actualCost, 11);
  assert.equal(stage.retry_items[1].final_result.evidence.actualCost, 10);
});

test('整页内部已恢复成功，即使阶段仍是旧失败标记也不再末尾重试', async () => {
  const config = await loadConfig(), suite = createRegressionState(config, 'recovered-full');
  suite.stages.forEach(stage => { stage.status = 'passed'; }); suite.stages[5].status = 'failed';
  await executeRegressionStages(suite, config.ai.regressionSuite, { execute: async () => assert.fail(),
    collectItems: async () => [{ key: 'full-page', status: 'passed', failure_step: '' }],
    executeRetry: async () => assert.fail('不可再次生成已成功整页'), persist: async () => {} });
  assert.equal(suite.stages[5].status, 'passed'); assert.equal(suite.stages[5].end_retry_count, undefined);
});

test('跨进程恢复旧预算不重置；重试结果身份不匹配不能通过', async () => {
  const config = await loadConfig(), suite = createRegressionState(config, 'old-budget');
  suite.stages.forEach(stage => { stage.status = 'passed'; });
  Object.assign(suite.stages[0], { status: 'failed', end_retry_count: 1 });
  await executeRegressionStages(suite, config.ai.regressionSuite, { execute: async () => assert.fail(),
    collectItems: async () => assert.fail('旧预算已经耗尽，不重新分配'), executeRetry: async () => assert.fail(), persist: async () => {} });
  assert.equal(suite.stages[0].status, 'failed');
  suite.stages[0].end_retry_count = 0;
  await executeRegressionStages(suite, config.ai.regressionSuite, { execute: async () => assert.fail(),
    collectItems: async () => [{ key: 'target', label: '目标', status: 'failed', failure_step: 'generation' }],
    executeRetry: async () => ({ ok: true, item: { key: 'wrong', status: 'passed' } }), persist: async () => {} });
  assert.equal(suite.stages[0].status, 'blocked');
  assert.match(suite.stages[0].failure_reason, /不匹配/);
});

test('恢复中的区块已经提交生成，不允许再次调用生成扣点', async () => {
  const config = await loadConfig(), runner = new AiBlockAutomation({}, config);
  runner.initialize = async () => { runner.state = { page: {}, types: [{ type: '静态图文', generation_status: 'running', apply_status: 'pending' }] }; };
  runner.persist = async () => {};
  runner.generateAndApply = async () => assert.fail('不允许再次点击开始生成');
  await assert.rejects(runner.run({ resume: true }), /已发起生成/);
});

test('稳定ID计数拒绝正文中的重复节点，忽略临时生成画布', async () => {
  const make = count => ({ url: () => 'https://example.test', locator: () => ({ evaluateAll: async () => count }) });
  const temporary = { url: () => 'https://example.test/blockEditorUI/index.html', locator: () => assert.fail('不读取临时画布') };
  assert.equal(await committedIdentityCount({ frames: () => [temporary, make(2)] }, 'id'), 2);
  assert.equal(await committedIdentityCount({ frames: () => [make(0), make(1)] }, 'id'), 1);
});

test('导航记录重复页面或点数数据缺失时，旧状态不能直接通过', async () => {
  const config = await loadConfig(), state = blockState(config, ['导航']);
  state.types[0].navigation_settings.selected_pages = [{ name: 'A' }, { name: 'A' }];
  assert.equal(retryItemFromState(descriptor(), state).failure_step, 'settings');
  const mode = createModePointsState(config, 'mode'); Object.assign(mode.page, { saved: true });
  Object.assign(mode.records[0], { generation_status: 'succeeded', application_status: 'applied', points_status: 'passed', editor_verified: true,
    preview_verified: true, published_verified: true });
  assert.equal(retryItemFromState({ kind: 'mode', target: 'quick' }, mode).failure_step, 'points');
});

test('上传输入数据失败不阻止文字和网址，已应用项仍完成页面验证', async () => {
  const config = await loadConfig(), events = [];
  const runner = new AiInputModesAutomation({ savePage: async () => events.push('save'), publishSite: async () => events.push('publish') }, config, 'isolation');
  runner.initialize = async () => { runner.state = createInputModeState(config, 'isolation'); };
  runner.persist = async () => {};
  runner.base.closeAiResult = async () => events.push('close');
  runner.runRecord = async record => {
    events.push(record.input_mode);
    if (record.input_mode === 'image') { record.input_status = 'failed'; throw new Error('测试图片上传失败'); }
    record.application_status = 'applied'; record.editor_verified = true;
  };
  runner.verifyPreview = async records => events.push(`preview:${records.map(record => record.input_mode).join(',')}`);
  runner.verifyPublished = async records => events.push(`public:${records.map(record => record.input_mode).join(',')}`);
  await assert.rejects(runner.run(), /部分失败/);
  assert.deepEqual(events, ['text', 'image', 'close', 'url', 'save', 'preview:text,url', 'publish', 'public:text,url']);
});

test('只补测文字不依赖图片文件，非法专项目标提前拒绝', async () => {
  const config = await loadConfig(); config.ai.inputModeRegression.imagePath = '/missing-test-fixture.png';
  const runner = new AiInputModesAutomation({}, config, 'fixture');
  await runner.validateFixtures('text');
  await assert.rejects(runner.validateFixtures('image'), /测试文件不可用/);
  assert.throws(() => scopedRetryConfig(config, { kind: 'mode', target: 'unknown' }, 'retry', 'state.json'), /目标不在/);
});

test('稳定ID存在但内容尚未加载不能标记展示通过', async () => {
  const make = data => ({ url: () => 'https://example.test', locator: () => ({ evaluateAll: async () => data }) });
  const result = await committedIdentityEvidence({ frames: () => [make({ count: 1, ready: false })] }, 'id');
  assert.deepEqual(result, { count: 1, ready: false });
  assert.deepEqual(await committedIdentityEvidence({ frames: () => [make({ count: 2, ready: false })] }, 'id'), { count: 2, ready: false });
});

test('详情已生成从历史应用，已应用只验证，状态不明禁止重复插入', () => {
  assert.equal(detailRetryAction({ generation_status: 'succeeded', apply_status: 'pending' }), 'recover-history');
  assert.equal(detailRetryAction({ generation_status: 'succeeded', apply_status: 'applied' }), 'verify');
  assert.equal(detailRetryAction({ generation_status: 'failed', apply_status: 'failed' }), 'generate');
  assert.throws(() => detailRetryAction({ generation_status: 'succeeded', apply_status: 'failed', application_attempted: true }), /不确定/);
  assert.throws(() => detailRetryAction({ generation_status: 'running', apply_status: 'pending' }), /不确定/);
});

test('历史区块增量不等于一时，页面通过标记不能替代必要断言', () => {
  const section = { page: { saved: true, editor_verified: true, preview_verified: true, published_verified: true },
    generation: { generation_status: 'succeeded', application_status: 'applied' },
    history: { reopened: true, match_status: 'succeeded', application_source: 'history' }, block_count_before: 0, block_count_after: 2 };
  assert.equal(retryItemFromState({ kind: 'history', target: 'block' }, { block: section }).failure_step, 'block-increment');
});

test('模型修改标题后按稳定ID核查输入区块，不依赖提示词标题', async () => {
  const config = await loadConfig(), runner = new AiInputModesAutomation({}, config, 'identity');
  runner.editorMarkerCount = async () => assert.fail('不应依赖标题');
  const page = { frames: () => [{ url: () => 'https://example.test', locator: () => ({ evaluateAll: async () => ({ count: 1, ready: true }) }) }] };
  assert.equal(await runner.recordIdentityCount({ committed_block_id: 'stable-id', heading: 'Original heading' }, page), 1);
});

test('分页预览公开标记不能掩盖正文区块缺失', async () => {
  const config = await loadConfig(); config.ai = { ...config.ai, types: ['静态图文'], blocksPerPage: 1 };
  const runner = new AiPagedAutomation({ savePage: async () => {} }, config);
  runner.initialize = async () => { runner.state = blockState(config, ['静态图文'], 1); runner.state.types[0].editor_verified = false; return runner.state; };
  runner.persist = async () => {}; runner.verifyPreview = async () => {}; runner.verifyPublished = async () => {};
  runner.editorAiBlockCount = async () => 0;
  await assert.rejects(runner.run(), /编辑器检测到 0\/1/);
  assert.equal(runner.state.types[0].editor_verified, false);
});

test('报告分别内嵌首次和重试截图，不泄露截图路径', async () => {
  const { root, config } = await fixture(); config.paths.aiRegressionReportsDir = path.join(root, 'reports');
  const screenshot = path.join(root, 'initial.png');
  await writeFile(screenshot, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGN8AAAAASUVORK5CYII=', 'base64'));
  const suite = createRegressionState(config, 'screenshots'); suite.stages = [suite.stages[0]];
  suite.stages[0].status = 'passed';
  const evidence = { generation: 'succeeded', application: 'applied', editor: true, saved: true, preview: true, published: true, screenshot };
  suite.stages[0].retry_items = [{ ...descriptor('静态图文'), status: 'passed', retry_count: 1,
    initial_result: { status: 'failed', evidence: { ...evidence, editor: false } }, final_result: { evidence } }];
  const result = await writeRegressionReport(config, suite, { root });
  const html = await readFile(result.file, 'utf8');
  assert.equal((html.match(/<img src="data:image\/png;base64,/g) || []).length, 3);
  assert.match(html, /放大首次执行截图/); assert.match(html, /放大精准重试截图/);
  assert.doesNotMatch(html, /initial\.png/);
});
