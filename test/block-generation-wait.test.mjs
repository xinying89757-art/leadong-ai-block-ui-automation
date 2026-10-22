import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';
import { AiBlockAutomation } from '../src/ai-runner.mjs';

test('普通区块超过 60 秒继续等，30 秒关闭重开只查询同一记录，不再次扣点', async () => {
  const config = await loadConfig();
  let elapsed = 0, refreshes = 0, historyClicks = 0;
  const invisible = { first() { return this; }, isVisible: async () => false, isEnabled: async () => false };
  const insert = { isVisible: async () => elapsed >= 90000, isEnabled: async () => elapsed >= 90000 };
  const card = { innerText: async () => `unique prompt ${elapsed >= 90000 ? '生成成功' : '生成中'}`,
    getAttribute: async key => key === 'data-id' ? 'this-record' : '', isVisible: async () => true,
    getByText: () => insert, locator: () => ({ filter: () => insert }) };
  const history = { first() { return this; }, isVisible: async () => true, click: async () => historyClicks++ };
  const frame = {
    getByText: value => typeof value === 'string' ? invisible : { first() { return this; }, isVisible: async () => true },
    locator: selector => selector === config.selectors.aiHistoryCardSelector ? { count: async () => 1, nth: () => card }
      : selector === config.selectors.aiHistoryTriggerSelector ? history : { filter: () => invisible },
  };
  const runner = new AiBlockAutomation({ page: { waitForTimeout: async milliseconds => { elapsed += milliseconds; } } }, config);
  runner.state = {}; runner.persist = async () => {};
  runner.closeAiResult = async () => refreshes++;
  runner.openAiDialog = async () => frame;
  const originalNow = Date.now;
  Date.now = () => 1000000 + elapsed;
  try {
    const record = { generation_status: 'running', generation_record_id: 'this-record' };
    const result = await runner.waitForGeneration(frame, 'unique prompt', 0, undefined, record);
    assert.equal(result.mode, 'history'); assert.equal(result.recordId, 'this-record');
    assert.equal(elapsed, 90000); assert.equal(refreshes, 2); assert.equal(historyClicks, 2);
    assert.equal(record.generation_wait.last_status, 'succeeded');
    assert.equal(record.generation_wait.refresh_count, 2);
  } finally { Date.now = originalNow; }
});

test('复合区块失败记录换行格式变化时立即识别明确失败，不等待生成超时',async()=>{
  const config=await loadConfig();
  const hidden={first(){return this;},isVisible:async()=>false};
  const card={innerText:async()=> '[runId=this-round] First paragraph\n\nSecond paragraph\n生成失败 组合操作失败，已保留可恢复进度，请重试。',getAttribute:async()=>''};
  const frame={getByText:()=>hidden,locator:selector=>selector===config.selectors.aiHistoryCardSelector?{count:async()=>1,nth:()=>card}:{filter:()=>hidden}};
  const runner=new AiBlockAutomation({page:{waitForTimeout:async()=>assert.fail('明确失败不能继续等待')}},config);
  await assert.rejects(()=>runner.waitForGeneration(frame,'[runId=this-round] First paragraph\r\n\r\nSecond paragraph',0,600000,{type:'复合区块'}),e=>e.code==='GENERATION_FAILED'&&e.explicitPlatformFailure===true);
});

test('等待到期后刷新一次同一生成记录，捕获刚完成的结果而不重新提交',async()=>{
  const config=await loadConfig();let elapsed=0,closed=0;
  const hidden={first(){return this;},isVisible:async()=>false,isEnabled:async()=>false};
  const insert={isVisible:async()=>elapsed>1000,isEnabled:async()=>elapsed>1000};
  const card={innerText:async()=>`unique prompt ${elapsed>1000?'生成成功':'生成中'}`,
    getAttribute:async key=>key==='data-id'?'same-record':'',isVisible:async()=>true,
    getByText:()=>insert,locator:()=>({filter:()=>insert})};
  const history={first(){return this;},isVisible:async()=>true,click:async()=>{}};
  const frame={getByText:()=>hidden,locator:selector=>selector===config.selectors.aiHistoryCardSelector?{count:async()=>1,nth:()=>card}
    :selector===config.selectors.aiHistoryTriggerSelector?history:{filter:()=>hidden}};
  const runner=new AiBlockAutomation({page:{waitForTimeout:async ms=>{elapsed+=ms;}}},config);
  runner.state={};runner.persist=async()=>{};runner.closeAiResult=async()=>{closed++;if(closed===1)elapsed+=2;};runner.openAiDialog=async()=>frame;
  const originalNow=Date.now;Date.now=()=>2000000+elapsed;
  try{
    const record={type:'复合区块',generation_status:'running',generation_record_id:'same-record'};
    const result=await runner.waitForGeneration(frame,'unique prompt',0,1000,record);
    assert.equal(result.mode,'history');assert.equal(result.recordId,'same-record');
    assert.equal(closed,1);assert.equal(record.generation_wait.last_status,'succeeded');
  }finally{Date.now=originalNow;}
});
