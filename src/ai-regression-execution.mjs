import { REGRESSION_STAGES, isGlobalSafetyFailure, isSafetyFailure } from './ai-regression-state.mjs';
import { itemRetryRunId } from './ai-retry-targets.mjs';

// Kept for reading old run associations; new retries use a per-item key.
export function retryRunId(runId, index) { return `${runId.slice(0, 65)}-s${index}-retry1`; }

export async function executeRegressionStages(state, config, {
  execute, executeRetry, collectItems, persist, now = () => Date.now(),
}) {
  state.fatal_failure = false;
  const finishStage = stage => {
    const items = stage.retry_items;
    if (!items?.length) return;
    stage.status = items.every(item => item.status === 'passed') ? 'passed'
      : items.some(item => item.status === 'blocked') ? 'blocked' : 'failed';
    stage.failure_reason = items.filter(item => item.status !== 'passed')
      .map(item => `${item.label}：${item.failure_reason || '未通过'}`).join('；');
  };
  for (const definition of REGRESSION_STAGES) {
    const stage = state.stages.find(item => item.key === definition.key);
    if (stage.status === 'passed' || ['failed', 'blocked'].includes(stage.status) || stage.attempt_phase === 'final-retry') continue;
    stage.status = 'running'; stage.attempt_phase = 'initial';
    stage.attempts = (stage.attempts || 0) + 1;
    stage.started_at ||= new Date(now()).toISOString();
    await persist();
    const started = now();
    let outcome;
    try { outcome = await execute(definition, { stage, runId: stage.child_run_id || state.run_id, fresh: false, finalRetry: false }); }
    catch (error) { outcome = { ok: false, reason: error.message }; }
    const elapsed = Math.max(0, now() - started);
    stage.duration_ms = (stage.duration_ms || 0) + elapsed;
    stage.completed_at = new Date(now()).toISOString();
    stage.result = outcome.result || null;
    stage.status = outcome.ok ? 'passed' : isSafetyFailure(outcome.reason) ? 'blocked' : 'failed';
    stage.failure_reason = outcome.ok ? '' : String(outcome.reason || '阶段未通过').slice(-4000);
    stage.attempt_history ??= [];
    stage.attempt_history.push({ phase: 'initial', run_id: state.run_id, status: stage.status,
      started_at: stage.started_at, completed_at: stage.completed_at, duration_ms: elapsed,
      failure_reason: stage.failure_reason, result: stage.result });
    if (!outcome.ok && isGlobalSafetyFailure(outcome.reason)) state.fatal_failure = true;
    await persist();
    if (state.fatal_failure || (!outcome.ok && config.continueAfterBusinessFailure === false)) return state;
  }
  state.first_pass_completed = true;
  await persist();
  if (config.retryFailedAtEnd === false) return state;
  for (const definition of REGRESSION_STAGES) {
    const stage = state.stages.find(item => item.key === definition.key);
    if (stage.status === 'passed') continue;
    if (isGlobalSafetyFailure(stage.failure_reason)) { state.fatal_failure = true; break; }
    // Legacy stage-level retry budgets are never silently reset on migration.
    if (!stage.retry_items && (stage.end_retry_count || 0) >= 1) continue;
    if (!stage.retry_items) {
      const items = collectItems ? await collectItems(stage) : [];
      stage.retry_items = items.map(item => ({ ...item, initial_result: structuredClone(item), retry_count: 0 }));
      stage.retry_version = 1;
      if (!items.length) {
        stage.status = 'blocked'; stage.failure_reason = '结果未确认：不能定位失败测试项，禁止整阶段重跑';
        await persist(); continue;
      }
      await persist();
    }
    for (const item of stage.retry_items) {
      if (item.status === 'passed' || item.failure_step === 'unconfirmed') continue;
      const continuing = item.status === 'running' && item.retry_count === 1;
      if (!continuing && item.retry_count >= 1) continue;
      const shared = ['page-create', 'page-switch'].includes(item.failure_step) && stage.retry_items.find(other =>
        other !== item && other.source_file === item.source_file && other.retry_count >= 1 &&
        ['page-create', 'page-switch'].includes(other.initial_result?.failure_step) && ['failed', 'blocked'].includes(other.status));
      if (shared) {
        item.status = 'blocked'; item.failure_reason = shared.failure_reason;
        item.retry_count = 1; item.shared_page_recovery_key = shared.key;
        await persist(); continue;
      }
      // A shared page checkpoint may have recovered several items. Read its
      // exact source before reserving another operation or point charge.
      if (!continuing && collectItems) {
        const matches = (await collectItems(stage)).filter(current => current.key === item.key);
        if (matches.length === 1 && matches[0].status === 'passed') {
          Object.assign(item, matches[0], { recovered_without_generation: true });
          await persist(); continue;
        }
      }
      if (!continuing) {
        item.retry_count = 1;
        item.retry_run_id = itemRetryRunId(state.run_id, `${stage.key}:${item.key}`);
        item.retry_started_at = new Date(now()).toISOString();
      }
      item.status = 'running'; stage.status = 'running'; stage.attempt_phase = 'final-retry';
      stage.end_retry_count = 1;
      await persist(); // Durable reservation precedes any UI action.
      const started = now();
      let outcome;
      try {
        if (!executeRetry) throw new Error('结果未确认：缺少逐项重试执行器，禁止整阶段重跑');
        outcome = await executeRetry(definition, { stage, item, runId: item.retry_run_id, continuing });
      } catch (error) { outcome = { ok: false, reason: error.message }; }
      if (outcome.item && outcome.item.key !== item.key) {
        outcome = { ok: false, reason: '结果未确认：重试结果与目标测试项不匹配' };
      }
      const elapsed = Math.max(0, now() - started);
      stage.duration_ms = (stage.duration_ms || 0) + elapsed;
      item.retry_duration_ms = (item.retry_duration_ms || 0) + elapsed;
      item.retry_completed_at = new Date(now()).toISOString();
      stage.completed_at = item.retry_completed_at;
      stage.attempts = (stage.attempts || 0) + 1;
      item.final_result = outcome.item || null;
      item.retry_result = outcome.result || null;
      item.status = outcome.ok && outcome.item?.status === 'passed' ? 'passed'
        : isSafetyFailure(outcome.reason) || !outcome.item ? 'blocked' : 'failed';
      item.failure_reason = item.status === 'passed' ? '' : outcome.reason || outcome.item?.failure_reason || '结果未确认';
      for (const recovered of outcome.recoveredItems || []) {
        const sibling = stage.retry_items.find(other => other.key === recovered.key);
        if (sibling && sibling !== item && sibling.status !== 'passed' && recovered.status === 'passed') {
          sibling.final_result = recovered;
          sibling.status = 'passed'; sibling.failure_reason = '';
          sibling.recovered_without_generation = true;
        }
      }
      item.attempt_history ??= [];
      item.attempt_history.push({ run_id: item.retry_run_id, status: item.status, duration_ms: elapsed,
        completed_at: item.retry_completed_at, result: item.final_result, failure_reason: item.failure_reason });
      stage.attempt_history ??= [];
      stage.attempt_history.push({ phase: 'item-retry', item_key: item.key, run_id: item.retry_run_id,
        status: item.status, duration_ms: elapsed, completed_at: item.retry_completed_at,
        failure_reason: item.failure_reason, result: item.retry_result });
      if (isGlobalSafetyFailure(outcome.reason)) state.fatal_failure = true;
      await persist();
      if (state.fatal_failure) break;
    }
    finishStage(stage);
    await persist();
    if (state.fatal_failure) break;
  }
  return state;
}
