import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';
import { assertFlowState, createFlowState, validateRunId, flowPaths, flowConfig, assertCreditDelta, assertHistoryIncrement, parseHistoryBadge, assertModification, assertPromptPreserved, resumeStepAction, renderFlowReport, deriveFlowOutcome } from '../src/ai-new-flow-state.mjs';
const config = await loadConfig('config/run.json');
test('new flows isolate pages by flow and run and reject altered ownership', () => {
  for (const flow of ['modify', 'result-actions']) {
    const state = createFlowState(config, flow, 'offline-one');
    assertFlowState(state, config, flow, 'offline-one');
    assert.notEqual(state.page.path, createFlowState(config, flow, 'offline-two').page.path);
    state.page.name = 'existing page';
    assert.throws(() => assertFlowState(state, config, flow, 'offline-one'), /ownership/);
  }
});
test('state validation rejects a changed mode list and step tokens', () => {
  const state = createFlowState(config, 'modify', 'unit');
  const changed = structuredClone(config); changed.ai.modifyRegression.modes = ['quick'];
  assert.throws(() => assertFlowState(state, changed, 'modify', 'unit'), /configuration/);
  state.steps[0].token = 'another run';
  assert.throws(() => assertFlowState(state, config, 'modify', 'unit'), /configuration/);
});
test('run paths reject traversal and malformed identifiers', () => {
  for (const id of ['', '../a', '/tmp/a', 'a b', 'a'.repeat(81), null, true]) assert.throws(() => flowPaths(config, 'modify', id), /run-id/);
  assert.equal(validateRunId('a_B-9'), 'a_B-9');
});
test('quick/advanced default and optional deep mode resolve only configured costs', () => {
  assert.deepEqual(flowConfig(config, 'modify').modes, ['quick', 'advanced']);
  const changed = structuredClone(config); changed.ai.modifyRegression.modes.push('deep');
  assert.equal(flowConfig(changed, 'modify').modes.length, 3);
  changed.ai.modifyRegression.modes.push('unknown');
  assert.throws(() => flowConfig(changed, 'modify'), /modes/);
});
test('credit assertions reject no charge, refund, wrong charge and missing values', () => {
  for (const cost of [6,15,30]) assert.equal(assertCreditDelta(100,100-cost,cost).actual_cost,cost);
  for (const args of [[100,100,6],[100,106,6],[100,85,6],[null,94,6],[NaN,94,6],[100,-1,101],[100,100,0]]) assert.throws(() => assertCreditDelta(...args), /delta/);
});
test('history badges and increments use loaded total rather than visible cards', () => {
  assert.equal(parseHistoryBadge('生成记录\n1'), 1);
  assert.equal(parseHistoryBadge('生成记录 127'), 127);
  assert.throws(() => parseHistoryBadge('生成记录'), /badge/);
  assertHistoryIncrement(127,128);
  for (const after of [127,129,126]) assert.throws(() => assertHistoryIncrement(127,after), /count/);
});
test('return modification requires exact prompt preservation', () => {
  assertPromptPreserved(' a\nb ', ' a\nb ');
  assert.throws(() => assertPromptPreserved(' a\nb ', 'a b'), /preserve/);
});
test('modification rejects an unchanged block, missing new token or retained old token', () => {
  assertModification('Old heading','New heading','New','Old');
  assert.throws(() => assertModification('New heading','New heading','New'), /heading/);
  assert.throws(() => assertModification('Old heading','Unrelated heading','New','Old'), /heading/);
  assert.throws(() => assertModification('Old heading','New heading Old','New','Old'), /heading/);
});
test('resumption skips passed steps, verifies uncertain applications and recovers submitted generations', () => {
  assert.equal(resumeStepAction({status:'passed'}),'skip');
  assert.equal(resumeStepAction({application_status:'applying'}),'verify-commit');
  assert.equal(resumeStepAction({generation_status:'pending'}),'generate');
  for (const generation_status of ['running','succeeded','uncertain']) assert.equal(resumeStepAction({generation_status}),'recover');
});
test('reports show outcome, point evidence and screenshot paths', () => {
  const state=createFlowState(config,'modify','report'); state.steps[0].charges=[{before:100,after:94,actual_cost:6}];state.steps[0].evidence=['seed.png'];
  const report=renderFlowReport(state);assert.match(report,/100 → 94 \(6\)/);assert.match(report,/seed.png/);assert.match(report,/AI修改回归-report/);
});

test('two-part outcome derives assertion and preview status independently', () => {
  const state=createFlowState(config,'modify','outcome');
  state.steps.forEach(step=>step.status='passed');
  assert.deepEqual(deriveFlowOutcome(state),{assertions_status:'PASS',preview_status:'not-applicable',overall:'PASS'});
  state.steps[0].preview_status='blocked-environment';state.steps[0].status='failed';state.steps[0].assertions_passed=true;
  assert.deepEqual(deriveFlowOutcome(state),{assertions_status:'PASS',preview_status:'blocked-environment',overall:'PASS (preview env-blocked)'});
  state.steps[0].preview_status='failed';
  assert.deepEqual(deriveFlowOutcome(state),{assertions_status:'PASS',preview_status:'failed',overall:'FAIL'});
  state.steps[0].assertion_failure=true;
  state.steps[0].assertions_passed=false;
  assert.deepEqual(deriveFlowOutcome(state),{assertions_status:'FAIL',preview_status:'failed',overall:'FAIL'});
});

test('preview uses only the owned editor host and preview route', async () => {
  const {previewTarget}=await import('../src/ai-new-flow-state.mjs');
  const editor='https://website.leadong.com/phoenix/pagebuilder/layout';
  assert.equal(previewTarget('http://website.leadong.com/phoenix/pagebuilder/preview',editor),'https://website.leadong.com/phoenix/pagebuilder/preview');
  for(const href of [null,'https://elsewhere.invalid/phoenix/pagebuilder/preview','/phoenix/pagebuilder/layout','/phoenix/pagebuilder/preview-other']) assert.throws(()=>previewTarget(href,editor),/preview/);
});
test('discard assertions reject inserted, deleted or replaced blocks', async () => {
  const {assertDiscardedSnapshot}=await import('../src/ai-new-flow-state.mjs');
  const before={count:1,ids:['owned']};assertDiscardedSnapshot(before,structuredClone(before));
  for(const after of [{count:0,ids:[]},{count:2,ids:['owned','other']},{count:1,ids:['other']}]) assert.throws(()=>assertDiscardedSnapshot(before,after),/Discard/);
});
test('exclusive run creation refuses concurrent duplicate IDs and preserves the winner', async () => {
  const {createExclusiveFlowState}=await import('../src/ai-new-flow-state.mjs');
  const {mkdtemp,readFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const path=await import('node:path');
  const root=await mkdtemp(path.join(tmpdir(),'ai-flow-state-'));
  try {
    const file=path.join(root,'state.json'),state=createFlowState(config,'modify','duplicate');
    const results=await Promise.allSettled([createExclusiveFlowState(file,state),createExclusiveFlowState(file,state)]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    assert.match(results.find(r=>r.status==='rejected').reason.message,/already exists/);
    assert.deepEqual(JSON.parse(await readFile(file,'utf8')),state);
  } finally {await rm(root,{recursive:true});}
});

test('result cases have independent owned pages, validated before cleanup', () => {
  const state=createFlowState(config,'result-actions','isolated');
  const pages=[state.page,...state.steps.slice(1).map(step=>step.page)];
  assert.equal(new Set(pages.map(page=>page.path)).size,4);
  assertFlowState(state,config,'result-actions','isolated');
  state.steps[2].page.path='/existing-page';
  assert.throws(()=>assertFlowState(state,config,'result-actions','isolated'),/ownership/);
});

test('an interrupted discard is verified without inserting its history again', () => {
  assert.equal(resumeStepAction({status:'failed',generation_status:'succeeded',application_status:'discarding'}),'verify-discard');
});

test('history recovery selects only a unique newest owned record and never falls back past a failure', async () => {
  const {selectOwnedHistoryRecord}=await import('../src/ai-new-flow-state.mjs');
  const older='owned prompt 已完成 2026-10-22 15:10:00',newer='owned prompt 已完成 2026-10-22 15:20:00';
  assert.deepEqual(selectOwnedHistoryRecord([older,newer],2),{index:1,timestamp:'2026-10-22 15:20:00'});
  assert.throws(()=>selectOwnedHistoryRecord([older,older],2),/ambiguous/);
  assert.throws(()=>selectOwnedHistoryRecord([older],2),/ambiguous/);
  assert.throws(()=>selectOwnedHistoryRecord(['missing date'],1),/timestamp/);
  assert.throws(()=>selectOwnedHistoryRecord([older,newer.replace('已完成','生成失败')],2),/failed/);
});
