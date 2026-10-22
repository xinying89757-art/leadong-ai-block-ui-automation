import path from 'node:path';
import { AiPagedAutomation } from './ai-paged-runner.mjs';
import { AiStateStore } from './ai-state.mjs';
import { AiModePointsAutomation } from './ai-mode-points-runner.mjs';
import { AiInputModesAutomation } from './ai-input-modes-runner.mjs';
import { AiFullPageAutomation } from './ai-full-page-runner.mjs';
import { AiHistoryReuseAutomation } from './ai-history-reuse-runner.mjs';
import { AiDetailAutomation } from './ai-detail-runner.mjs';
import { createFullPageState } from './ai-full-page-state.mjs';
import { createHistoryReuseState } from './ai-history-reuse-state.mjs';
import { committedAiSnapshot, committedIdentityEvidence } from './ai-canvas-commit.mjs';
import { filterDisplayEvidence } from './ai-product-filter-runner.mjs';
import { writeRegressionJson, isGlobalSafetyFailure } from './ai-regression-state.mjs';
import { retryItemFromState, readRetrySource, retryCanRegenerate, retryIsCheckpointOnly, assertRetrySource } from './ai-retry-targets.mjs';

export function scopedRetryConfig(config, item, runId, stateFile) {
  const targets = {
    block: [...config.ai.types, ...(config.ai.followupPages || []).flatMap(page => page.types)],
    mode: config.ai.modePointRegression.modes.map(mode => mode.key),
    input: config.ai.inputModeRegression.inputModes.map(mode => mode.key),
    detail: (config.ai.detailPages || []).map(page => page.type),
    'full-page': ['full-page'], history: ['full_page', 'block'],
  };
  if (!targets[item.kind]?.includes(item.target)) throw new Error('结果未确认：重试目标不在专项配置中');
  const scoped = structuredClone(config);
  scoped.ai.runId = runId;
  scoped.ai.isolatedPages = true;
  scoped.ai.fullPageRegression.autoRetryFailed = false;
  scoped.paths.aiStateFile = stateFile;
  if (item.kind === 'block') {
    scoped.ai.types = [item.target]; scoped.ai.blocksPerPage = 1; scoped.ai.followupPages = [];
  } else if (item.kind === 'mode') {
    scoped.ai.modePointRegression.modes = scoped.ai.modePointRegression.modes.filter(mode => mode.key === item.target);
    scoped.ai.modePointRegression.blocksPerPage = 1;
  } else if (item.kind === 'input') {
    scoped.ai.inputModeRegression.inputModes = scoped.ai.inputModeRegression.inputModes.filter(mode => mode.key === item.target);
    scoped.ai.inputModeRegression.blocksPerPage = 1;
  }
  return scoped;
}

async function waitIdentity(page, record, timeout, interval = 500) {
  const deadline = Date.now() + timeout;
  do {
    const evidence = await committedIdentityEvidence(page, record.committed_block_id);
    if (evidence.count === 1 && evidence.ready) return;
    await page.waitForTimeout(interval);
  } while (Date.now() < deadline);
  throw new Error('应用后未在编辑器或预览、公开页检测到唯一目标区块');
}

async function verifySelectedPage(editor, config, state, records, persist, { navigation } = {}) {
  if (!records.length) throw new Error('结果未确认：没有可验证的目标区块');
  if (!state.page.saved) {
    await editor.savePage(); state.page.saved = true;
    await persist();
    await editor.openCustomPage(state.page.name);
    for (const record of records) await waitIdentity(editor.page, record, config.timeouts.blockRenderMs);
  }
  const previewRecords = records.filter(record => !record.preview_verified);
  if (previewRecords.length) {
    const popup = editor.page.context().waitForEvent('page', { timeout: config.timeouts.actionMs });
    await editor.page.locator('.clickToPreview').first().click();
    const preview = await popup;
    try {
      for (const record of previewRecords) {
        await waitIdentity(preview, record, config.timeouts.blockRenderMs);
        if (record.type === '产品筛选' && !(await filterDisplayEvidence(preview.frames())).passed) throw new Error('产品筛选预览仍显示占位提示');
        record.preview_verified = true;
      }
    } finally { await preview.close().catch(() => {}); }
    await persist();
  }
  if (records.some(record => !record.published_verified)) {
    // A previously uncertain publish can be resolved read-only; do not send
    // another request until we know the old one was not accepted.
    if (!['accepted', 'running'].includes(state.page.publish_status)) {
      state.page.publish_status = 'running'; await persist();
      await editor.publishSite(); state.page.publish_status = 'accepted'; await persist();
    }
    const publicPage = await editor.page.context().newPage();
    try {
      await publicPage.waitForTimeout(config.ai.publishInitialWaitMs);
      const deadline = Date.now() + config.ai.publishTimeoutMs;
      let ready = false;
      do {
        await publicPage.goto(state.page.publicUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
        ready = true;
        for (const record of records) {
          const identity = await committedIdentityEvidence(publicPage, record.committed_block_id);
          if (identity.count !== 1 || !identity.ready) ready = false;
          if (record.type === '产品筛选') {
            const valid = (await filterDisplayEvidence(publicPage.frames())).passed;
            record.filter_settings.public_display_verified = valid;
            if (!valid) ready = false;
          }
        }
        if (ready) break;
        await publicPage.waitForTimeout(config.ai.publishPollIntervalMs);
      } while (Date.now() < deadline);
      if (!ready) throw new Error('公开页未在规定时间内显示目标区块');
      for (const record of records) record.published_verified = true;
      state.page.publish_status = 'accepted';
    } finally { await publicPage.close().catch(() => {}); }
    await persist();
  }
  if (navigation && records.some(record => record.type === '导航') && !state.page.public_navigation_verified) {
    await navigation.verifyPublicNavigation();
  }
  // Only actual full-page verification can set full-page completion flags.
  state.page.editor_verified = state.types.every(record => record.editor_verified);
  state.page.preview_verified = state.types.every(record => record.preview_verified);
  state.page.published_verified = state.types.every(record => record.published_verified);
  await persist();
}

async function repairBlock(editor, config, item, state, file) {
  const scoped = { ...config, ai: { ...config.ai, runId: state.run_id, types: state.types.map(record => record.type),
    blocksPerPage: state.types.length, followupPages: [] } };
  const runner = new AiPagedAutomation(editor, scoped, new AiStateStore(file), item.page_number || 1);
  runner.state = state; runner.page = state.page; runner.bindHandlers();
  if (state.page.quarantined || state.types.some(record => record.application_attempted && !record.application_commit_confirmed && record.apply_status !== 'applied')) {
    throw new Error('应用状态不确定：原页已隔离，不能继续保存或发布');
  }
  // Creation/switch errors are one shared page problem, not five failed
  // generations. Continue only its unexecuted types on the same owned page.
  if (['page-create', 'page-switch'].includes(item.failure_step)) {
    // A missing response is ambiguous and cannot authorize another create.
    if (/创建结果待确认/.test(state.page.failure_reason || '') && !state.page.creation_receipt) throw new Error('页面创建结果待确认：保留现场，禁止再次创建');
    await runner.persist();
    return runner.run({ resume: true, maxTypes: state.types.length, publish: true });
  }
  if (!await editor.customPageExists(state.page.name)) throw new Error('原测试页不存在，不能在原页恢复');
  await editor.openCustomPage(state.page.name);
  const record = state.types.find(record => record.type === item.target);
  if (record.apply_status !== 'applied') {
    if (record.application_attempted) throw new Error('应用状态不确定：禁止在原页重复插入');
    if (record.generation_status !== 'succeeded') {
      // Query the original submission before reserving a second paid request.
      if (record.generation_submitted_at || record.generation_record_id || record.generation_wait) {
        const frame = await runner.openAiDialog();
        const history = frame.locator(config.selectors.aiHistoryTriggerSelector).first();
        if (await history.isVisible().catch(() => false)) await history.click();
        const result = await runner.waitForGeneration(frame, record.generation_prompt || record.prompt, 0,
          config.ai.generationStatusRefreshIntervalMs ?? 30000, record);
        record.generation_status = 'succeeded'; record.generation_record_id = result.recordId || record.generation_record_id;
        await runner.persist();
        await runner.closeAiResult();
      } else throw new Error('生成未成功，需要独立补测页');
    }
    await runner.recoverStandardGeneratedResult(record);
  }
  const snapshot = await committedAiSnapshot(editor.page.frames(), { ownedBlankPage: true });
  if (!record.committed_block_id || !snapshot.ids.includes(record.committed_block_id)) throw new Error('应用状态不确定：无法唯一识别原页目标区块');
  if (!['产品筛选', '导航'].includes(record.type)) await waitIdentity(editor.page, record, config.timeouts.blockRenderMs);
  let changed = false;
  if (record.type === '导航' && record.navigation_settings.save_status !== 'succeeded') {
    await runner.navigationHandler.configureNavigationAfterApply(record); changed = true;
  }
  if (record.type === '产品筛选') {
    const evidence = await filterDisplayEvidence(editor.canvasContexts());
    if (!evidence.passed || !record.filter_settings.fields_verified || !record.filter_settings.select_all_checked) {
      // Restrict selection to the stored wrapper; never pick the first/last AI
      // block when a specialized selector fails.
      let match;
      for (const frame of editor.canvasContexts()) {
        const wrapper = frame.locator(`[id=${JSON.stringify(record.committed_block_id)}]`);
        if (await wrapper.count().catch(() => 0) === 1) { match = { frame, wrapper }; break; }
      }
      if (!match) throw new Error('产品筛选目标区块不唯一');
      runner.filterHandler.generatedBlock = async () => match;
      await runner.filterHandler.configureFilterBeforeApply(match.frame, record); changed = true;
    }
    record.filter_settings.editor_display_verified = (await filterDisplayEvidence(editor.canvasContexts())).passed;
    if (!record.filter_settings.editor_display_verified) throw new Error('产品筛选全选后仍有占位提示');
  }
  record.editor_verified = true;
  if (changed) {
    state.page.saved = false; state.page.publish_status = 'pending';
    record.preview_verified = false; record.published_verified = false;
    state.page.public_navigation_verified = false;
  }
  // Read-only verification may cover other items at the same failed page
  // checkpoint, but never regenerates them.
  const records = retryIsCheckpointOnly(item) ? state.types.filter(current => current.apply_status === 'applied' &&
    current.editor_verified && current.committed_block_id &&
    (current.type !== '导航' || current.navigation_settings?.save_status === 'succeeded') &&
    (current.type !== '产品筛选' || current.filter_settings?.fields_verified)) : [record];
  await verifySelectedPage(editor, config, state, records, () => runner.persist(), { navigation: runner.navigationHandler });
  record.failure_reason = ''; record.recovery_required = false;
  await runner.persist();
  return state;
}

async function repairPoints(editor, config, item, state, file) {
  const Runner = item.kind === 'mode' ? AiModePointsAutomation : AiInputModesAutomation;
  const runner = new Runner(editor, config, state.run_id);
  runner.state = state; runner.paths.state = file;
  runner.paths.root = path.dirname(file);
  if (state.records.some(record => record.application_status === 'applying' && !record.application_commit_confirmed)) {
    throw new Error('应用状态不确定：原点数测试页已隔离，不能继续保存或发布');
  }
  if (!await editor.customPageExists(state.page.name)) throw new Error('原测试页不存在，不能在原页恢复');
  await editor.openCustomPage(state.page.name);
  const record = state.records.find(record => (record.mode || record.input_mode) === item.target);
  if (item.kind === 'mode' && ['running', 'uncertain'].includes(record.generation_status) && Number.isFinite(record.points_before)) {
    await runner.runMode(record, { recover: true, reusePoints: record.points_status === 'passed' });
  }
  if (record.application_status === 'pending' && record.generation_status === 'succeeded' && record.points_status === 'passed') {
    if (item.kind === 'mode') await runner.runMode(record, { recover: true, reusePoints: true });
    else await runner.recoverGeneratedRecord(record);
  }
  if (record.application_status !== 'applied' || record.points_status !== 'passed' || !record.committed_block_id) {
    throw new Error('生成、点数或应用证据未通过，需要独立补测页');
  }
  await waitIdentity(editor.page, record, config.timeouts.blockRenderMs);
  record.editor_verified = true;
  if (!state.page.saved) { await editor.savePage(); state.page.saved = true; await runner.persist(); }
  const records = retryIsCheckpointOnly(item) ? state.records.filter(record => record.application_status === 'applied' &&
    record.points_status === 'passed' && record.committed_block_id) : [record];
  if (records.some(record => !record.preview_verified)) await runner.verifyPreview(records);
  if (records.some(record => !record.published_verified)) {
    if (!['accepted', 'running'].includes(state.page.publish_status)) {
      state.page.publish_status = 'running'; await runner.persist();
      await editor.publishSite(); state.page.publish_status = 'accepted'; await runner.persist();
    }
    await runner.verifyPublished(records);
  }
  record.failure_reason = ''; await runner.persist();
  return state;
}

export function detailRetryAction(record) {
  if (record.apply_status === 'applied') return 'verify';
  if (record.application_attempted || ['running', 'uncertain'].includes(record.generation_status)) {
    throw new Error('详情应用或生成状态不确定，禁止重复插入或扣点');
  }
  return record.generation_status === 'succeeded' ? 'recover-history' : 'generate';
}

async function repairDetail(editor, config, item, state, checkpoint) {
  const detail = config.ai.detailPages.find(detail => detail.type === item.target);
  const scoped = { ...config, ai: { ...config.ai, runId: state.run_id } };
  const runner = new AiDetailAutomation(editor, scoped, detail, null, new AiStateStore(checkpoint));
  await runner.initialize(); // Includes system-page identity and ownership protection.
  const record = runner.state.types[0];
  const action = detailRetryAction(record);
  if (action === 'recover-history') {
    const recovery = new AiPagedAutomation(editor, runner.config, runner.store, 0);
    recovery.state = runner.state; recovery.page = runner.state.page;
    // The shared recovery must not navigate to a custom page on a system page.
    recovery.checkpointAppliedType = async () => {
      await editor.savePage(); runner.state.page.saved = true; await runner.persist();
    };
    await recovery.recoverStandardGeneratedResult(record);
    await runner.registerAppliedOwnership();
  }
  if (action === 'generate') {
    record.recovery_required = false; await runner.persist();
  }
  // Keep any successful generation/application; only the failed type runs.
  return runner.run();
}

export async function runRetryTarget(editor, config, task, taskFile, { repair, regenerate } = {}) {
  const root = path.dirname(taskFile), item = task.item;
  const persistTask = () => writeRegressionJson(taskFile, task);
  const checkpoint = path.join(root, 'checkpoint-state.json');
  if (task.status === 'completed') return task.outcome;
  if (!task.phase) { task.phase = 'repair'; await persistTask(); }
  if (task.phase === 'repair') {
    const source = await readRetrySource(item.source_file);
    assertRetrySource(config, item, source);
    if (!await readRetrySource(checkpoint)) await writeRegressionJson(checkpoint, structuredClone(source));
    const state = await readRetrySource(checkpoint);
    task.current_state_file = checkpoint; await persistTask();
    try {
      let repaired;
      if (repair) repaired = await repair(editor, config, item, state, checkpoint);
      else if (item.kind === 'block') repaired = await repairBlock(editor, config, item, state, checkpoint);
      else if (['mode', 'input'].includes(item.kind)) repaired = await repairPoints(editor, config, item, state, checkpoint);
      else if (item.kind === 'detail') repaired = await repairDetail(editor, config, item, state, checkpoint);
      else if (item.kind === 'full-page') {
        const runner = new AiFullPageAutomation(editor, config, state.run_id);
        runner.paths.state = checkpoint; runner.paths.root = root;
        repaired = await runner.run();
      } else {
        const runner = new AiHistoryReuseAutomation(editor, config, state.run_id);
        runner.paths.state = checkpoint; runner.paths.root = root;
        repaired = await runner.run({ sections: [item.target] });
      }
      const final = retryItemFromState({ ...item, source_file: checkpoint }, repaired);
      const sharedPage = ['page-create', 'page-switch'].includes(item.failure_step);
      if (final.status !== 'passed' && !sharedPage) throw new Error(final.failure_reason || '目标测试项必要链路未通过');
      task.outcome = { ok: final.status === 'passed', reason: final.failure_reason, item: final, result: { stateFile: checkpoint, application: 'checkpoint' },
        recoveredItems: (task.related_items || []).map(related => retryItemFromState({ ...related, source_file: checkpoint }, repaired)) };
      task.status = 'completed'; await persistTask(); return task.outcome;
    } catch (error) {
      task.repair_failure_reason = error.message;
      task.repair_finished_at = new Date().toISOString();
      const latest = retryItemFromState(item, await readRetrySource(checkpoint));
      // Page save/preview/publish failures must NEVER trigger regeneration.
      if (isGlobalSafetyFailure(error.message) || !retryCanRegenerate(item) || retryIsCheckpointOnly(item) || retryIsCheckpointOnly(latest)) {
        throw error;
      }
      task.phase = 'regenerate'; await persistTask();
      await editor.goto(); // Only after the original page has been isolated.
    }
  }
  const runId = task.run_id;
  const file = path.join(root, 'regenerated-state.json');
  const scoped = scopedRetryConfig(config, item, runId, file);
  task.current_state_file = file; await persistTask();
  if (regenerate) {
    const state = await regenerate(editor, scoped, item, file, Boolean(await readRetrySource(file)));
    const final = retryItemFromState({ ...item, source_file: file }, state);
    task.outcome = { ok: final.status === 'passed', item: final, reason: final.failure_reason,
      result: { stateFile: file, runId, application: 'isolated-retry-page' } };
    task.status = 'completed'; await persistTask(); return task.outcome;
  }
  let runner;
  if (item.kind === 'block') runner = new AiPagedAutomation(editor, scoped, new AiStateStore(file), item.page_number || 1);
  if (item.kind === 'mode') runner = new AiModePointsAutomation(editor, scoped, runId);
  if (item.kind === 'input') runner = new AiInputModesAutomation(editor, scoped, runId);
  if (item.kind === 'full-page') {
    if (!await readRetrySource(file)) await writeRegressionJson(file, createFullPageState(scoped, runId));
    runner = new AiFullPageAutomation(editor, scoped, runId);
  }
  if (item.kind === 'history') {
    if (!await readRetrySource(file)) await writeRegressionJson(file, createHistoryReuseState(scoped, runId));
    runner = new AiHistoryReuseAutomation(editor, scoped, runId);
  }
  if (!runner) throw new Error('结果未确认：不支持的重试目标');
  if (runner.paths) { runner.paths.state = file; runner.paths.root = root; }
  const resume = Boolean(await readRetrySource(file));
  const state = await runner.run({ resume, maxTypes: 1, publish: true,
    ...(item.kind === 'history' ? { sections: [item.target] } : {}) });
  const final = retryItemFromState({ ...item, source_file: file }, state);
  task.outcome = { ok: final.status === 'passed', item: final, reason: final.failure_reason,
    result: { stateFile: file, runId, application: 'isolated-retry-page' } };
  task.status = 'completed'; await persistTask();
  return task.outcome;
}
