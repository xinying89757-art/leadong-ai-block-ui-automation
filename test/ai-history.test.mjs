import test from 'node:test';
import assert from 'node:assert/strict';
import {loadConfig} from '../src/config.mjs';
import {createFlowState,assertFlowState,flowPaths} from '../src/ai-new-flow-state.mjs';
import {parseGenerationHistoryRecord,parseRecordTimestamp,assertHistoryRecords,selectRecoverableFailure} from '../src/ai-history-state.mjs';
const config=await loadConfig();
const row=(overrides={})=>[overrides.prompt??'An English heading with 99 点 in its prompt',overrides.status??'已完成',overrides.input??'文字描述',overrides.mode??'快速模式',overrides.type??'静态图文',`${overrides.points??6} 点`,overrides.timestamp??'2026-10-22 18:00:00',overrides.error??'', '＋插入'].join('\n');
test('history parser extracts separate badges, mode cost and China-local timestamp',()=>{
 const result=parseGenerationHistoryRecord(row(),'record-one');
 assert.equal(result.id,'record-one');assert.equal(result.mode,'quick');assert.equal(result.input_method,'文字描述');assert.equal(result.block_type,'静态图文');assert.equal(result.points,6);assert.equal(result.status,'completed');assert.equal(result.epoch_ms,Date.parse('2026-10-22T10:00:00Z'));assert.match(result.prompt,/99 点/);
 for(const [mode,key,points] of [['快速模式','quick',6],['高级模式','advanced',15],['进阶模式','advanced',15],['深度模式','deep',30]])assert.equal(parseGenerationHistoryRecord(row({mode,points})).mode,key);
 for(const input of ['上传图片','提供网址'])assert.equal(parseGenerationHistoryRecord(row({input})).input_method,input);
});
test('history parser needs line-separated status and metadata badges',()=>{
 assert.equal(parseGenerationHistoryRecord(row()).status,'completed');
 assert.throws(()=>parseGenerationHistoryRecord(row().replace(/\s+/g,' ')),/History status badge missing/);
});
test('history rejects missing badges and invalid calendar timestamps',()=>{
 for(const text of ['missing',row().replace('文字描述\n',''),row().replace('快速模式','unknown'),row({timestamp:'2026-02-30 18:00:00'}),row({points:6}).replace('6 点\n','')])assert.throws(()=>parseGenerationHistoryRecord(text));
 assert.throws(()=>parseRecordTimestamp('2026-10-22 25:00:00'));
});
test('history assertions reject old-first order, nonzero failed points and wrong completed cost',()=>{
 const newest=parseGenerationHistoryRecord(row()),older=parseGenerationHistoryRecord(row({timestamp:'2026-10-22 17:00:00'}));
 assertHistoryRecords([newest,older],config.ai.generationModes);
 assert.throws(()=>assertHistoryRecords([older,newest],config.ai.generationModes),/newest/);
 assert.throws(()=>assertHistoryRecords([parseGenerationHistoryRecord(row({status:'生成失败',points:6}))],config.ai.generationModes),/0 points/);
 assert.throws(()=>assertHistoryRecords([parseGenerationHistoryRecord(row({points:15}))],config.ai.generationModes),/cost/);
});
test('continuation eligibility requires a genuine failed row with the recoverable combo error',()=>{
 const failed=parseGenerationHistoryRecord(row({status:'生成失败',points:0,error:'组合操作失败，已保留可恢复进度，请重试。'}));
 assert.equal(selectRecoverableFailure([parseGenerationHistoryRecord(row()),failed]),failed);
 assert.equal(selectRecoverableFailure([parseGenerationHistoryRecord(row({status:'生成失败',points:0,error:'other failure'}))]),null);
 assert.equal(selectRecoverableFailure([]),null);
});
test('history state has deterministic owned pages, guarded paths and independent checkpoints',()=>{
 const state=createFlowState(config,'history','unit-history');assertFlowState(state,config,'history','unit-history');assert.equal(state.steps.length,4);
 assert.throws(()=>flowPaths(config,'history','../bad'),/run-id/);
 state.steps[2].content_token=state.steps[0].token;assertFlowState(state,config,'history','unit-history');
 state.page.path='/existing';assert.throws(()=>assertFlowState(state,config,'history','unit-history'),/ownership/);
});
test('continuation outcome supports in-place resumption and a newly timestamped record without accepting an old duplicate',async()=>{
 const {continuationOutcome}=await import('../src/ai-history-state.mjs');
 const original=parseGenerationHistoryRecord(row({status:'生成失败',points:0,timestamp:'2026-10-21 18:00:00'}));
 const completed=parseGenerationHistoryRecord(row({timestamp:'2026-10-22 18:00:00'}));
 assert.equal(continuationOutcome([original],original,'2026-10-22T09:59:00Z').resumed,false);
 assert.equal(continuationOutcome([original,completed],original,'2026-10-22T09:59:00Z').source,'new-continuation-record');
 const resumed={...original,status:'running'};assert.equal(continuationOutcome([resumed],original,'2026-10-22T09:59:00Z').resumed,true);
 assert.throws(()=>continuationOutcome([original,completed,{...completed,timestamp:'2026-10-22 18:00:01'}],original,'2026-10-22T09:59:00Z'),/ambiguous/);
});
