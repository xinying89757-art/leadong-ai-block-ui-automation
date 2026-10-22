import test from 'node:test';
import assert from 'node:assert/strict';
import { pageCreationRequest, pageCreationResult, comparePageIdentity } from '../src/page-identity.mjs';
import { waitForCompleteContent } from '../src/ai-content-ready.mjs';
import { retryItemFromState, retryCanRegenerate } from '../src/ai-retry-targets.mjs';
import { markTypeFailed } from '../src/ai-state.mjs';
import { createFullPageState } from '../src/ai-full-page-state.mjs';
import { loadConfig } from '../src/config.mjs';
import { executeFullPageAttempts } from '../src/ai-full-page-result.mjs';
import { readableCheck } from '../src/ai-regression-report-view.mjs';

test('页面创建仅保留名称路径，HTTP 200 不能掩盖业务失败或无法识别的回执', () => {
  assert.deepEqual(pageCreationRequest('page.pageTitle=Test&page.pageUrl=%2Ftest&token=secret'), { name: 'Test', path: '/test' });
  assert.deepEqual(pageCreationResult({ success: true, data: { pageId: 'page-1' } }, true), { id: 'page-1', business_status: 'succeeded' });
  assert.deepEqual(pageCreationResult({ success: { pageTitle: 'Test', pageId: 'page-2' } }, true), { id: 'page-2', business_status: 'succeeded' });
  assert.throws(() => pageCreationResult({ error: { message: 'capacity' } }, true), /业务失败/);
  assert.throws(() => pageCreationResult({ success: { pageTitle: 'Wrong', pageId: 'page-2' } }, true, 'Target'), /页面名称不匹配/);
  assert.throws(() => pageCreationResult({ success: false }, true), /业务失败/);
  assert.throws(() => pageCreationResult({ code: 500 }, true), /业务失败/);
  assert.throws(() => pageCreationResult('<html>unknown</html>', true), /结果待确认/);
  assert.throws(() => pageCreationResult({ success: true }, false), /接口请求未成功/);
});

test('实际页面 ID 匹配容忍旧顶部文字；名称前缀和归属不明不能冒充目标页', () => {
  const expected = { name: 'Test', id: 'target', path: '/test' };
  assert.equal(comparePageIdentity(expected, { name: 'Old', id: 'target' }).matched, true);
  assert.equal(comparePageIdentity(expected, { name: 'Test', id: 'old' }).mismatch, true);
  assert.equal(comparePageIdentity({ name: 'Test' }, { name: 'Test-retry1', id: 'target' }).matched, false);
  assert.equal(comparePageIdentity({ name: 'Test' }, { name: 'Test', id: '' }).matched, false);
});

test('明确 ID 不匹配独立限时停止；名称短暂匹配后回退不能提前保存', async () => {
  const start = Date.now();
  await assert.rejects(waitForCompleteContent(async () => ({ count: 5, readyCount: 5, loading: false,
    identityMismatch: true, targetMatched: false }), { expectedCount: 5, timeoutMs: 500, identityMismatchTimeoutMs: 10, pollMs: 1 }), { code: 'PAGE_IDENTITY_MISMATCH' });
  assert.ok(Date.now() - start < 500);
  let count = 0;
  await assert.rejects(waitForCompleteContent(async () => ({ count: 5, readyCount: 5, loading: false,
    fingerprint: 'same', targetMatched: ++count === 1 }), { expectedCount: 5, timeoutMs: 20, stableMs: 10, pollMs: 1 }), { code: 'APPLICATION_INCOMPLETE' });
});

test('共享页面切换失败归入页面检查点，五个未生成类型不允许各自重新生成', () => {
  const state = { run_id: 'test', page: { name: 'Test', failure_step: 'page-switch' },
    types: ['下载列表', 'FAQ 列表', '产品分类', '文章分类', '视频分类'].map(type => ({ type, generation_status: 'pending', apply_status: 'pending' })) };
  for (const record of state.types) {
    const item = retryItemFromState({ kind: 'block', target: record.type }, state);
    assert.equal(item.failure_step, 'page-switch'); assert.equal(retryCanRegenerate(item), false);
  }
});

test('仍在生成的超时保留 uncertain，与平台明确失败分开；新整页状态无 Home 检查', async () => {
  const record = { generation_status: 'running', apply_status: 'pending' };
  markTypeFailed(record, Object.assign(new Error('仍在生成'), { code: 'GENERATION_UNCONFIRMED' }));
  assert.equal(record.generation_status, 'uncertain');
  const config = await loadConfig();
  assert.equal(config.ai.generationTimeoutMs, 180000);
  assert.equal(config.ai.generationStatusRefreshIntervalMs, 30000);
  assert.equal(Object.hasOwn(createFullPageState(config, 'test').page, 'home_verified'), false);
});

test('整页 CLI 必须链路通过即成功，旧 Home 字段不参与；未保存仍不能成功', async () => {
  const config = await loadConfig();
  const state = createFullPageState(config, 'complete');
  Object.assign(state.generation, { generation_status: 'succeeded', application_status: 'applied' });
  Object.assign(state.page, { saved: true, editor_verified: true, preview_verified: true, published_verified: true, home_verified: false });
  const execute = () => executeFullPageAttempts({ config, command: 'run', options: {}, runId: 'complete', execute: async () => state });
  assert.equal((await execute()).ok, true);
  state.page.saved = false; assert.equal((await execute()).ok, false);
});

test('报告区分页面创建／切换失败与生成待确认，未执行步骤保持灰色', () => {
  const failed = readableCheck({ label: 'Video', details: { pageFailureStep: 'page-switch', generation: 'pending', applied: 'pending',
    editor: false, saved: false, preview: false, published: false, failure: '页面切换失败' } });
  assert.equal(failed.steps[0].label, '页面切换'); assert.equal(failed.steps[0].status, 'failed');
  assert.ok(failed.steps.slice(1).every(step => step.status === 'pending'));
  const uncertain = readableCheck({ label: 'Video', details: { generation: 'uncertain', applied: 'pending',
    editor: false, saved: false, preview: false, published: false, failure: '生成结果待确认：仍在生成，等待超时' } });
  assert.equal(uncertain.steps[0].status, 'blocked');
  assert.ok(uncertain.steps.slice(1).every(step => step.status === 'pending'));
});
