// Opt-in live acceptance. Uses real AI points; never executed by npm test.
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { launchEditorBrowser, LeadongEditor } from '../src/editor.mjs';
import { AiPagedAutomation } from '../src/ai-paged-runner.mjs';
import { AiStateStore } from '../src/ai-state.mjs';
import { AiModePointsAutomation } from '../src/ai-mode-points-runner.mjs';
import { AiFullPageAutomation } from '../src/ai-full-page-runner.mjs';
import { createFullPageState } from '../src/ai-full-page-state.mjs';
import { AiHistoryReuseAutomation } from '../src/ai-history-reuse-runner.mjs';
import { createHistoryReuseState } from '../src/ai-history-reuse-state.mjs';
import { createRegressionState, regressionPaths, writeRegressionJson, readRegressionJson, isGlobalSafetyFailure } from '../src/ai-regression-state.mjs';
import { collectStageItems, itemRetryRunId, readRetrySource, retryItemFromState } from '../src/ai-retry-targets.mjs';
import { runRetryTarget } from '../src/ai-item-retry.mjs';
import { writeRegressionReport, formatDuration } from '../src/ai-regression-report.mjs';

if (!process.argv.includes('--apply')) throw new Error('实际验收会消耗 AI 点数，请显式提供 --apply');
const runId = process.argv.find(value => value.startsWith('--run-id='))?.split('=')[1] || `fixes-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
if (!/^[a-zA-Z0-9_-]{1,80}$/.test(runId)) throw new Error('运行 ID 无效');
const config = await loadConfig();
config.ai = { ...config.ai, runId, isolatedPages: true, types: ['下载列表', '视频分类'], blocksPerPage: 2, followupPages: [] };
config.ai.fullPageRegression.autoRetryFailed = false;
const paths = regressionPaths(config, runId);
config.paths.aiStateFile = path.join(path.dirname(paths.root), 'ai-state.json');
const existing = await readRegressionJson(paths.state);
if (existing && !process.argv.includes('--resume')) throw new Error('运行已存在，请使用 --resume，不新建重复测试');
const suite = existing || createRegressionState(config, runId);
suite.mode = 'ai-targeted-acceptance';
suite.status = 'running';
suite.stages = suite.stages.filter(stage => ['blocks-page-001', 'mode-points', 'full-page', 'history-reuse'].includes(stage.key));
suite.stages[0].label = '页面创建／切换：下载列表、视频分类';
const persist = async () => {
  await writeRegressionJson(paths.state, suite);
  const report = await writeRegressionReport(config, suite, paths);
  suite.report = { status: 'succeeded', file: report.file, latest_file: report.latest, generated_at: report.generatedAt };
  await writeRegressionJson(paths.state, suite);
};
const collect = async stage => (await collectStageItems(config, suite, stage))
  .filter(item => stage.key !== 'history-reuse' || item.target === 'full_page');
await persist();
const { context, page } = await launchEditorBrowser(config, { headless: false, isolatedProfile: false, slowMo: 0 });
let editor = new LeadongEditor(page, config);
async function bindFreshEditor() {
  if (editor.insertionPending || editor.unsavedChanges) editor = new LeadongEditor(await context.newPage(), config);
  await editor.goto();
}
try {
  for (const stage of suite.stages) {
    if (stage.status === 'passed' || stage.initial_finished) continue;
    const started = Date.now();
    stage.status = 'running'; stage.attempts = 1; stage.started_at = new Date().toISOString();
    await persist();
    console.log(`开始：${stage.label}（${runId}）`);
    let runner;
    try {
      await bindFreshEditor();
      if (stage.key === 'blocks-page-001') runner = new AiPagedAutomation(editor, config, new AiStateStore(config.paths.aiStateFile));
      if (stage.key === 'mode-points') runner = new AiModePointsAutomation(editor, config, runId);
      if (stage.key === 'full-page') {
        runner = new AiFullPageAutomation(editor, config, runId);
        if (!await readRegressionJson(runner.paths.state)) await writeRegressionJson(runner.paths.state, createFullPageState(config, runId));
      }
      if (stage.key === 'history-reuse') {
        runner = new AiHistoryReuseAutomation(editor, config, runId);
        if (!await readRegressionJson(runner.paths.state)) await writeRegressionJson(runner.paths.state, createHistoryReuseState(config, runId));
      }
      await runner.run({ resume: Boolean(existing), publish: true, ...(stage.key === 'history-reuse' ? { sections: ['full_page'] } : {}) });
      stage.result = { stateFile: runner.paths?.state || config.paths.aiStateFile, ...(stage.key === 'history-reuse' ? { sections: ['full_page'] } : {}) };
      const items = await collect(stage);
      stage.status = items.every(item => item.status === 'passed') ? 'passed' : 'failed';
      stage.failure_reason = items.filter(item => item.status !== 'passed').map(item => item.failure_reason).join('；');
    } catch (error) {
      stage.status = 'failed'; stage.failure_reason = error.message;
      stage.result = { stateFile: runner?.paths?.state || config.paths.aiStateFile, ...(stage.key === 'history-reuse' ? { sections: ['full_page'] } : {}) };
      if (runner?.state) {
        const statePage = stage.key === 'history-reuse' ? runner.state.full_page.page : runner.state.page;
        statePage.failure_reason = error.message;
        statePage.failure_screenshot = path.join(path.dirname(stage.result.stateFile), `acceptance-failure-${Date.now()}.png`);
        await editor.page.screenshot({ path: statePage.failure_screenshot }).catch(() => {});
        await runner.persist();
      }
      if (isGlobalSafetyFailure(error.message)) suite.fatal_failure = true;
    }
    stage.initial_finished = true; stage.duration_ms = (stage.duration_ms || 0) + Date.now() - started;
    stage.completed_at = new Date().toISOString();
    stage.attempt_history = [{ phase: 'initial', status: stage.status, duration_ms: stage.duration_ms, result: stage.result, failure_reason: stage.failure_reason }];
    await persist();
    console.log(`结束：${stage.label}，${stage.status}，${formatDuration(stage.duration_ms)}${stage.failure_reason ? `，${stage.failure_reason.slice(0, 200)}` : ''}`);
    if (suite.fatal_failure) break;
  }
  if (!suite.fatal_failure) for (const stage of suite.stages.filter(stage => stage.status !== 'passed')) {
    stage.retry_items ||= (await collect(stage)).map(item => ({ ...item, initial_result: structuredClone(item), retry_count: 0 }));
    for (const item of stage.retry_items) {
      if (item.status === 'passed' || item.retry_count >= 1 || item.failure_step === 'unconfirmed') continue;
      const shared = ['page-create', 'page-switch'].includes(item.failure_step) && stage.retry_items.find(other => other !== item &&
        other.source_file === item.source_file && other.retry_count >= 1 && other.status === 'failed' &&
        ['page-create', 'page-switch'].includes(other.initial_result?.failure_step));
      if (shared) { item.status = 'failed'; item.failure_reason = shared.failure_reason; item.retry_count = 1; continue; }
      const started = Date.now(); item.retry_count = 1;
      const retryId = itemRetryRunId(runId, `${stage.key}:${item.key}`);
      const taskFile = path.join(paths.root, 'item-retries', retryId, 'task.json');
      const task = await readRegressionJson(taskFile) || { mode: 'ai-item-retry', run_id: retryId, item: item.initial_result,
        status: 'reserved', related_items: stage.retry_items.filter(other => other.source_file === item.source_file) };
      await writeRegressionJson(taskFile, task); await persist();
      console.log(`末尾精准重试：${item.label}，检查点 ${item.failure_step}`);
      let outcome;
      try { await bindFreshEditor(); outcome = await runRetryTarget(editor, config, task, taskFile); }
      catch (error) {
        const file = task.current_state_file || item.source_file;
        const final = retryItemFromState({ ...item, source_file: file }, await readRetrySource(file));
        final.status = 'failed'; final.failure_reason = error.message;
        outcome = { ok: false, item: final, reason: error.message, result: { stateFile: file } };
        task.status = 'completed'; task.outcome = outcome; await writeRegressionJson(taskFile, task);
        if (isGlobalSafetyFailure(error.message)) suite.fatal_failure = true;
      }
      item.final_result = outcome.item; item.retry_result = outcome.result;
      item.status = outcome.ok ? 'passed' : 'failed'; item.failure_reason = outcome.ok ? '' : outcome.reason || outcome.item.failure_reason;
      for (const recovered of outcome.recoveredItems || []) {
        const sibling = stage.retry_items.find(other => other.key === recovered.key);
        if (sibling && recovered.status === 'passed') Object.assign(sibling, { status: 'passed', final_result: recovered, failure_reason: '' });
      }
      item.retry_duration_ms = Date.now() - started;
      stage.duration_ms += item.retry_duration_ms; stage.attempts += 1;
      stage.status = stage.retry_items.every(current => current.status === 'passed') ? 'passed' : 'failed';
      stage.failure_reason = stage.retry_items.filter(current => current.status !== 'passed').map(current => current.failure_reason).join('；');
      await persist();
      console.log(`重试结果：${item.label}，${item.status}，${formatDuration(item.retry_duration_ms)}`);
      if (suite.fatal_failure) break;
    }
    if (suite.fatal_failure) break;
  }
} finally {
  suite.completed_at = new Date().toISOString();
  suite.status = suite.stages.every(stage => stage.status === 'passed') ? 'passed' : 'failed';
  await persist(); await context.close();
}
console.log(JSON.stringify({ runId, status: suite.status, duration: formatDuration(suite.stages.reduce((sum, stage) => sum + stage.duration_ms, 0)),
  reportFile: suite.report.file, stages: suite.stages.map(stage => ({ name: stage.label, status: stage.status, duration: formatDuration(stage.duration_ms), failure: stage.failure_reason })) }, null, 2));
if (suite.status !== 'passed') process.exitCode = 1;
