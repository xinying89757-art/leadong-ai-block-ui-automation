import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {inflateSync} from 'node:zlib';
import {loadConfig} from '../src/config.mjs';
import {createFlowState,assertFlowState,flowConfig} from '../src/ai-new-flow-state.mjs';
import {assertNoChargeEvidence,parseUsageRecord,selectMatchingUsageRecord} from '../src/ai-validation-state.mjs';
import {writeOversizePng,crc32} from '../src/validation-fixtures.mjs';
const config=await loadConfig();
test('no-charge validation rejects credit changes, history changes and missing evidence',()=>{
 assertNoChargeEvidence({points:100,history:20},{points:100,history:20});
 for(const after of [{points:94,history:20},{points:100,history:21},{points:106,history:20},{points:100,history:null}])assert.throws(()=>assertNoChargeEvidence({points:100,history:20},after));
});
test('usage parsing uses labelled/header consumption, not remaining balance or row index',()=>{
 const record=parseUsageRecord(['1','2026-10-22 18:00:00','静态图文 快速模式','-6','94'],['序号','时间','使用类型','消耗点数','余额']);
 assert.equal(record.points,6);assert.equal(record.delta,-6);assert.equal(record.kind,'block-generation');assert.equal(record.epoch_ms,Date.parse('2026-10-22T10:00:00Z'));
 const withEmpty=parseUsageRecord(['2026-10-22 18:00:00','','AI区块生成','6','94'],['时间','备注','类型','使用积分','余额']);assert.equal(withEmpty.points,6);
 assert.equal(parseUsageRecord('2026-10-22 18:00:00\nAI区块生成\n消耗：6 点').points,6);
});
test('usage parser rejects missing timestamp, ambiguous points and missing type',()=>{
 for(const row of ['AI区块生成\n6 点',['2026-10-22 18:00:00','AI区块生成','6','94'],['2026-10-22 18:00:00','6']])assert.throws(()=>parseUsageRecord(row));
});
test('usage matching requires the operation time window, block type and exact mode cost',()=>{
 const record=parseUsageRecord('2026-10-22 18:00:00\nAI区块生成 快速模式\n-6 点');
 const criteria={startedAt:'2026-10-22T09:59:59Z',endedAt:'2026-10-22T10:00:05Z',expectedCost:6};
 assert.equal(selectMatchingUsageRecord([record],criteria),record);
 for(const records of [[],[{...record,points:15}],[{...record,kind:'page-generation'}],[{...record,epoch_ms:record.epoch_ms-60000}],[record,{...record,timestamp:'2026-10-22 18:00:01',epoch_ms:record.epoch_ms+1000}]])assert.throws(()=>selectMatchingUsageRecord(records,criteria),/match count/);
});
test('unsupported fixtures contain genuine GIF and BMP bytes',async()=>{
 const gif=await readFile(new URL('../fixtures/validation/tiny.gif',import.meta.url)),bmp=await readFile(new URL('../fixtures/validation/tiny.bmp',import.meta.url));
 assert.equal(gif.subarray(0,6).toString(),'GIF89a');assert.equal(gif.at(-1),0x3b);assert.equal(bmp.subarray(0,2).toString(),'BM');assert.equal(bmp.readUInt32LE(2),bmp.length);assert.equal(bmp.readUInt16LE(28),24);
});
test('runtime oversize fixture is a valid complete PNG above 5 MiB, with decodable image data',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'validation-png-'));
 try {
  const fixture=await writeOversizePng(path.join(dir,'large.png')),data=await readFile(fixture.file);assert.ok(data.length>5*1024*1024);assert.equal(data.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  let cursor=8;const compressed=[];let ended=false;
  while(cursor<data.length){const length=data.readUInt32BE(cursor),type=data.subarray(cursor+4,cursor+8).toString(),body=data.subarray(cursor+8,cursor+8+length);assert.equal(crc32(data.subarray(cursor+4,cursor+8+length)),data.readUInt32BE(cursor+8+length));if(type==='IDAT')compressed.push(body);if(type==='IEND')ended=true;cursor+=12+length;}
  assert.equal(ended,true);assert.equal(inflateSync(Buffer.concat(compressed)).length,(fixture.width*3+1)*fixture.height);
 }finally{await rm(dir,{recursive:true});}
});
test('validation state is isolated, resumable and restricted to quick-mode credit checks',()=>{
 const state=createFlowState(config,'validation','unit-validation');assertFlowState(state,config,'validation','unit-validation');assert.equal(state.steps.length,9);assert.equal(config.ai.generationModes.find(mode=>mode.key==='quick').expectedCost,6);
 const changed=structuredClone(config);changed.ai.validationRegression.mode='advanced';assert.throws(()=>flowConfig(changed,'validation'),/quick/);
 state.page.name='existing';assert.throws(()=>assertFlowState(state,config,'validation','unit-validation'),/ownership/);
});
