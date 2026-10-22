export { createFlowState, assertFlowState, flowPaths } from './ai-new-flow-state.mjs';
export function parseRecordTimestamp(value) {
  const match = String(value).match(/\b(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\b/);
  if (!match) throw new Error('Record timestamp missing');
  const timestamp = `${match[1]} ${match[2]}`;
  const epoch_ms = Date.parse(timestamp.replace(' ', 'T') + '+08:00');
  if (!Number.isFinite(epoch_ms) || new Date(epoch_ms + 8*3600000).toISOString().slice(0,19).replace('T',' ') !== timestamp) throw new Error('Invalid record timestamp');
  return { timestamp, epoch_ms };
}
export function parseGenerationHistoryRecord(text, id = '') {
  const lines = String(text).split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
  const statusIndex = lines.findIndex(line=>/^(已完成|生成失败|生成中|正在生成)$/.test(line));
  if (statusIndex < 0) throw new Error('History status badge missing');
  const metadata = lines.slice(statusIndex + 1);
  const input_method = metadata.find(line=>/^(文字描述|上传图片|提供网址)$/.test(line));
  const modeLabel = metadata.find(line=>/^(快速|进阶|高级|深度)(模式)?$/.test(line));
  const mode = /快速/.test(modeLabel) ? 'quick' : /进阶|高级/.test(modeLabel) ? 'advanced' : /深度/.test(modeLabel) ? 'deep' : null;
  const pointsLine = metadata.find(line=>/^\d+\s*点$/.test(line));
  const points = pointsLine ? Number(pointsLine.match(/\d+/)[0]) : null;
  const block_type = metadata[metadata.indexOf(modeLabel) + 1];
  if (!input_method || !mode || !block_type || block_type===pointsLine || points===null) throw new Error('History metadata badge missing');
  const status_label = lines[statusIndex];
  return { id, prompt: lines.slice(0,statusIndex).join('\n'), status: status_label==='已完成'?'completed':status_label==='生成失败'?'failed':'running', status_label,
    input_method, mode, mode_label: modeLabel, block_type, points, ...parseRecordTimestamp(text),
    recoverable: String(text).includes('组合操作失败，已保留可恢复进度，请重试。'), text: String(text) };
}
export function assertHistoryRecords(records, modes) {
  if (!records.length) throw new Error('No history records loaded');
  const costs = Object.fromEntries(modes.map(mode=>[mode.key,mode.expectedCost]));
  records.forEach((record,index)=>{
    if (index && records[index-1].epoch_ms < record.epoch_ms) throw new Error(`History rows are not newest first at ${index}`);
    if (record.status==='failed' && record.points!==0) throw new Error('Failed history row must show 0 points');
    if (record.status==='completed' && record.points!==costs[record.mode]) throw new Error('Completed history row has wrong mode cost');
  });
  return true;
}
export function selectRecoverableFailure(records) {
  return records.find(record=>record.status==='failed' && record.recoverable) ?? null;
}
export function continuationOutcome(records, original, startedAt) {
  const normalized=value=>String(value).replace(/\s+/g,' ').trim();
  const matching=records.filter(record=>normalized(record.prompt)===normalized(original.prompt));
  const newRecords=matching.filter(record=>record.timestamp!==original.timestamp && record.epoch_ms>=Date.parse(startedAt)-2000);
  if (newRecords.length>1) throw new Error('Continuation result ambiguous');
  if (newRecords.length===1) return { record:newRecords[0], resumed:true, source:'new-continuation-record' };
  const same=matching.filter(record=>original.id?record.id===original.id:record.timestamp===original.timestamp);
  if (same.length>1) throw new Error('Continuation source ambiguous');
  if (!same.length) return null;
  return {record:same[0],resumed:same[0].status!=='failed',source:'original-record'};
}
