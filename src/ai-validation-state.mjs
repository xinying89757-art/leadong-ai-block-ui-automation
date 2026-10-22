import {parseRecordTimestamp} from './ai-history-state.mjs';
export {createFlowState,assertFlowState,flowPaths} from './ai-new-flow-state.mjs';
export function assertNoChargeEvidence(before,after) {
  for(const value of [before?.points,after?.points,before?.history,after?.history]) if(!Number.isInteger(value)||value<0) throw new Error('No-charge evidence missing');
  if(before.points!==after.points||before.history!==after.history) throw new Error(`Unexpected generation/charge: points ${before.points} → ${after.points}; history ${before.history} → ${after.history}`);
  return {passed:true,points_charged:0,history_delta:0};
}
export function parseUsageRecord(row, headers=[]) {
  const values=(Array.isArray(row)?row:String(row).split(/[\t\n]+/)).map(value=>String(value).replace(/\s+/g,' ').trim());
  const cells=Array.isArray(row)?values:values.filter(Boolean);
  const text=cells.join(' | ');
  const time=parseRecordTimestamp(text.replace(/(\d{4}-\d{2}-\d{2})T/,'$1 '));
  const pointsIndex=headers.findIndex(header=>/消耗|扣除|使用点数|使用积分|消费.*点|点数变动|积分变动|变动.*点|消费点数/.test(header));
  let raw;
  if(pointsIndex>=0) raw=cells[pointsIndex]?.match(/[+\-−]?\s*\d+(?:\.\d+)?/)?.[0];
  else {
    const labelled=text.match(/(?:消耗|扣除|使用点数|使用积分|消费点数)\s*[:：]?\s*([+\-−]?\s*\d+(?:\.\d+)?)/);
    const withUnit=[...text.matchAll(/([+\-−]?\s*\d+(?:\.\d+)?)\s*点(?:\s|\||$)/g)];
    const bare=cells.filter(cell=>/^[+\-−]?\s*\d+(?:\.\d+)?$/.test(cell));
    raw=labelled?.[1]??(withUnit.length===1?withUnit[0][1]:bare.length===1?bare[0]:undefined);
  }
  if(raw===undefined) throw new Error('Usage points missing or ambiguous');
  const signed=Number(raw.replace(/\s/g,'').replace('−','-'));
  if(!Number.isFinite(signed)) throw new Error('Invalid usage points');
  const typeIndex=headers.findIndex(header=>/使用类型|消费类型|业务类型|操作类型|类型|功能/.test(header));
  const type=typeIndex>=0?cells[typeIndex]:cells.filter(cell=>!/^[-+−]?\s*\d+(?:\.\d+)?(?:\s*点)?$/.test(cell)&&!cell.includes(time.timestamp)).join(' ');
  if(!type) throw new Error('Usage type missing');
  return {...time,type,kind:/区块|静态图文/i.test(type)?'block-generation':/整页|页面/.test(type)?'page-generation':'other',points:Math.abs(signed),delta:-Math.abs(signed),text};
}
export function selectMatchingUsageRecord(records,{startedAt,endedAt,expectedCost,kind='block-generation'}) {
  const start=Date.parse(startedAt),end=Date.parse(endedAt);
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<start) throw new Error('Invalid usage time window');
  const candidates=records.filter(record=>record.kind===kind&&record.points===expectedCost&&record.epoch_ms>=start-2000&&record.epoch_ms<=end+2000);
  const unique=[...new Map(candidates.map(record=>[`${record.timestamp}:${record.type}:${record.points}`,record])).values()];
  if(unique.length!==1) throw new Error(`Usage record match count ${unique.length}; expected one by time/type/points`);
  return unique[0];
}
/** Narrow opt-in workaround for the known bare-domain usage-viewer 403. */
export function usageRecordsFallbackUrl(value,host,editorUrl) {
  if(!host)return null;
  const target=new URL(value),editor=new URL(editorUrl);
  if(host!==editor.host)throw new Error('Usage viewer fallback must use the authenticated editor host');
  if(target.protocol!=='https:'||target.hostname!=='leadong.com'||target.pathname!=='/phoenix2/composite/aigc-resource/index.html')return null;
  target.host=host;return target.href;
}
