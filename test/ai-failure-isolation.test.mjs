import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';
import { createRegressionState, isGlobalSafetyFailure } from '../src/ai-regression-state.mjs';
import { executeRegressionStages, retryRunId } from '../src/ai-regression-execution.mjs';
import { committedAiSnapshot, waitForAiCommit } from '../src/ai-canvas-commit.mjs';
import { AiHistoryReuseAutomation } from '../src/ai-history-reuse-runner.mjs';
import { waitForCompleteContent } from '../src/ai-content-ready.mjs';
import { enteredEditorPage } from '../src/editor.mjs';
import { assertPageCapacityAvailable } from '../src/ai-platform-errors.mjs';
import { itemRetryRunId } from '../src/ai-retry-targets.mjs';

const failedItem = (key = '静态图文') => ({ key, label: key, status: 'failed', failure_step: 'generation', failure_reason: '生成失败' });

test('五个未生成类型共享一个页面恢复，恢复后只执行未完成类型，不分配五张补测页', async () => {
  const config = await loadConfig();
  for (const success of [true, false]) {
    const state = createRegressionState(config, `shared-page-${success}`);
    const stage = state.stages[1];
    state.stages.forEach(current => { current.status = current === stage ? 'failed' : 'passed'; });
    stage.failure_reason = '页面切换失败';
    const items = ['下载列表', 'FAQ 列表', '产品分类', '文章分类', '视频分类'].map(type => ({
      ...failedItem(type), source_file: '/same-owned-page.json', failure_step: 'page-switch',
    }));
    let recoveries = 0;
    await executeRegressionStages(state, config.ai.regressionSuite, {
      persist: async () => {}, execute: async () => assert.fail('不重新执行已通过阶段'),
      collectItems: async () => items,
      executeRetry: async (_, { item }) => {
        recoveries++;
        return { ok: success, reason: success ? '' : '页面切换仍未确认',
          item: { ...item, status: success ? 'passed' : 'failed' },
          recoveredItems: success ? items.map(other => ({ ...other, status: 'passed' })) : [] };
      },
    });
    assert.equal(recoveries, 1);
    assert.equal(stage.status, success ? 'passed' : 'blocked');
  }
});

test('明确页面容量限制提前给出业务错误，不等待模板定位超时或自动清理', async () => {
  const page = { getByText: () => ({ first: () => ({ isVisible: async () => true }) }) };
  await assert.rejects(assertPageCapacityAvailable(page), { code: 'PAGE_CAPACITY_LIMIT' });
  page.getByText = () => ({ first: () => ({ isVisible: async () => false }) });
  await assert.doesNotReject(assertPageCapacityAvailable(page));
});

test('进入站点只绑定本次新开或已导航的编辑器，不误选遗留编辑器标签页', () => {
  const make = url => ({ url: () => url, isClosed: () => false });
  const old = make('https://test/phoenix/pagebuilder/old');
  const admin = make('https://test/website.html');
  const fresh = make('https://test/phoenix/pagebuilder/new');
  const knownPages = new Set([old, admin]);
  assert.equal(enteredEditorPage([old, admin, fresh], { knownPages, currentPage: admin }), fresh);
  assert.equal(enteredEditorPage([old, admin], { knownPages, currentPage: admin }), null);
  assert.equal(enteredEditorPage([old, admin], { knownPages, currentPage: admin, navigatedPages: new Set([old]) }), old);
});

test('整页内容完整但目标页不匹配时明确记录身份问题，不当成普通加载超时', async () => {
  const snapshot = { count: 5, readyCount: 5, loading: false, fingerprint: 'stable', targetMatched: false };
  await assert.rejects(waitForCompleteContent(async () => snapshot,
    { expectedCount: 5, timeoutMs: 5, stableMs: 1, pollMs: 1 }), error => {
    assert.match(error.message, /当前页面与测试目标不一致/);
    assert.deepEqual(error.snapshot, snapshot);
    return true;
  });
});

test('临时 AI iframe 及其嵌套正文不计入已提交页面', async () => {
  const root = { url: () => 'https://test/blockEditorUI/index.html' };
  const child = { url: () => 'about:blank', parentFrame: () => root, locator: () => assert.fail('不可读取临时正文') };
  assert.equal((await committedAiSnapshot([root, child])).count, 0);
});

test('应用确认等待真实唯一新增 ID 和稳定窗口，旧区块或多新增不能通过', async () => {
  let i = 0;
  const result = await waitForAiCommit(async () => {
    i++;
    return i < 3 ? { count: 1, ids: ['old'], ready: true } : { count: 2, ids: ['old', 'new'], ready: true };
  }, { count: 1, ids: ['old'] }, { timeoutMs: 100, stableMs: 5, pollMs: 1 });
  assert.equal(result.addedId, 'new');
  for (const snapshot of [
    { count: 2, ids: ['a', 'b'], ready: true },
    { count: 3, ids: ['old', 'a', 'b'], ready: true },
    { count: 2, ids: ['old', ''], ready: true },
    { count: 2, ids: ['old', 'new'], ready: false },
  ]) await assert.rejects(waitForAiCommit(async () => snapshot, { count: 1, ids: ['old'] },
    { timeoutMs: 5, stableMs: 1, pollMs: 1 }), { code: 'AI_COMMIT_UNCONFIRMED' });
});

test('预览失败单独说明预览加载原因，不误报应用失败或禁止保存', async () => {
  const snapshot = { count: 6, readyCount: 6, loading: true };
  await assert.rejects(waitForCompleteContent(async () => snapshot,
    { expectedCount: 6, timeoutMs: 5, pollMs: 1, scope: 'preview', label: '整页预览内容' }), error => {
    assert.equal(error.code, 'CONTENT_RENDER_TIMEOUT');
    assert.match(error.message, /整页预览内容等待超时/);
    assert.doesNotMatch(error.message, /应用状态不确定|禁止刷新/);
    assert.deepEqual(error.snapshot, snapshot);
    return true;
  });
});

test('局部应用不确定不阻断其他阶段；末尾仅重试失败项一次并累加耗时', async () => {
  const config = await loadConfig();
  const state = createRegressionState(config, 'isolation');
  const events = [];
  let ticks = 0;
  await executeRegressionStages(state, config.ai.regressionSuite, {
    now: () => ticks += 10, persist: async () => {},
    collectItems: async () => [failedItem()],
    executeRetry: async (def, args) => {
      events.push([def.key, true, args.runId, false]);
      return { ok: true, item: { ...args.item, status: 'passed' } };
    },
    execute: async (def, attempt) => {
      events.push([def.key, attempt.finalRetry, attempt.runId, attempt.fresh]);
      return { ok: def.key !== 'blocks-page-001' || attempt.finalRetry, reason: '应用状态不确定', result: { childRunId: attempt.runId } };
    },
  });
  assert.equal(events.length, 8);
  assert.deepEqual(events.slice(0, 7).map(x => x[1]), Array(7).fill(false));
  assert.deepEqual(events.at(-1), ['blocks-page-001', true, itemRetryRunId('isolation', 'blocks-page-001:静态图文'), false]);
  assert.equal(state.fatal_failure, false);
  assert.equal(state.stages[0].end_retry_count, 1);
  assert.equal(state.stages[0].attempt_history.length, 2);
  assert.equal(state.stages[0].duration_ms, 20);
});

test('最终重试失败后跨进程恢复不会再生成第二次重试', async () => {
  const config = await loadConfig();
  const state = createRegressionState(config, 'budget');
  const dependencies = { persist: async () => {}, execute: async () => ({ ok: false, reason: '生成失败' }),
    collectItems: async () => [failedItem()], executeRetry: async (_, args) => ({ ok: false, reason: '生成失败', item: { ...args.item, status: 'failed' } }) };
  await executeRegressionStages(state, config.ai.regressionSuite, dependencies);
  const resumed = JSON.parse(JSON.stringify(state));
  await executeRegressionStages(resumed, config.ai.regressionSuite,
    { persist: async () => {}, execute: async () => assert.fail('预算耗尽不可再次执行') });
  assert.ok(resumed.stages.every(s => s.attempts === 2 && s.end_retry_count === 1));
});

test('重试中断复用同一子运行状态，不分配新扣点运行', async () => {
  const config = await loadConfig();
  const state = createRegressionState(config, 'interrupted');
  state.stages.forEach(s => s.status = 'passed');
  Object.assign(state.stages[0], { status: 'running', attempt_phase: 'final-retry', end_retry_count: 1, child_run_id: 'reserved' });
  state.stages[0].retry_items = [{ ...failedItem(), status: 'running', retry_count: 1, retry_run_id: 'reserved' }];
  const calls = [];
  await executeRegressionStages(state, config.ai.regressionSuite, { persist: async () => {},
    execute: async () => assert.fail('不可整阶段执行'),
    executeRetry: async (_, args) => { calls.push(args); return { ok: true, item: { ...args.item, status: 'passed' } }; } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].runId, 'reserved');
  assert.equal(calls[0].continuing, true);
  assert.equal(state.stages[0].end_retry_count, 1);
});

test('登录、站点和余额安全失败仍立即停止且不重试', async () => {
  const config = await loadConfig();
  for (const reason of ['登录失败', '站点语言不匹配', '余额不足', '站点页面数量已达到最大限制']) {
    const state = createRegressionState(config, 'fatal');
    let calls = 0;
    await executeRegressionStages(state, config.ai.regressionSuite, { persist: async () => {},
      execute: async () => { calls++; return { ok: false, reason }; } });
    assert.equal(calls, 1);
    assert.equal(state.fatal_failure, true);
    assert.equal(state.stages[0].end_retry_count, undefined);
  }
  assert.equal(isGlobalSafetyFailure('应用状态不确定'), false);
  assert.equal(isGlobalSafetyFailure('点数读取失败，请检查登录态或点数面板'), false);
});

test('整页记录复用失败后不刷新旧页，在新标签页继续区块记录复用', async () => {
  const config = await loadConfig();
  const events = [];
  const nextPage = { setDefaultTimeout() {}, setDefaultNavigationTimeout() {} };
  const oldPage = { screenshot: async () => events.push('screenshot'), context: () => ({ newPage: async () => nextPage }) };
  const editor = { page: oldPage, goto: async () => { assert.equal(editor.page, nextPage); events.push('new-editor'); } };
  const runner = new AiHistoryReuseAutomation(editor, config, 'fixture');
  runner.state = { full_page: { page: {} }, block: { page: {} } };
  runner.initialize = async () => {};
  runner.persist = async () => {};
  runner.runFullPage = async () => { events.push('full'); throw new Error('应用状态不确定：整页未添加完成'); };
  runner.runBlock = async () => { events.push('block'); runner.state.block.page.published_verified = true; };
  await assert.rejects(runner.run(), /整页记录复用/);
  assert.deepEqual(events, ['full', 'screenshot', 'new-editor', 'block']);
  assert.equal(runner.state.block.page.published_verified, true);
});

test('详情末尾重试保持原运行并走所有权保护，不新建副本', async () => {
  const config = await loadConfig();
  const state = createRegressionState(config, 'details-safe');
  state.stages.forEach(s => s.status = 'passed');
  state.stages[2].status = 'failed';
  let call;
  await executeRegressionStages(state, config.ai.regressionSuite, { persist: async () => {},
    execute: async () => assert.fail('不可重跑三类详情'),
    collectItems: async () => [{ ...failedItem('detail:文章详情'), kind: 'detail', target: '文章详情', source_run_id: state.run_id }],
    executeRetry: async (_, args) => { call = args; return { ok: true, item: { ...args.item, status: 'passed' } }; } });
  assert.equal(call.item.source_run_id, state.run_id);
  assert.equal(call.item.target, '文章详情');
});
