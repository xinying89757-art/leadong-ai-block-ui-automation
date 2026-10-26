const definitions = {
  product_pair: { types: ["产品列表", "产品分类"], prompt: "产品列表和产品分类" },
  article_pair: { types: ["文章列表", "文章分类"], prompt: "文章列表和文章分类" },
  three_type: { types: ["产品列表", "产品分类", "文章列表"], prompt: "产品列表、产品分类和文章列表" },
};

export const comboKeys = Object.freeze(Object.keys(definitions));
export function comboDefinition(key) { return definitions[key] ?? null; }
export function comboPromptFor(key) {
  const value = definitions[key];
  if (!value) throw new Error(`Unknown combo key: ${key}`);
  return value.prompt;
}

function normalize(value) { return String(value ?? "").replace(/\s+/g, " ").trim(); }

export function selectNewCompositeHistoryRecord(records, {
  baselineCount, currentCount, submittedAt, polishedPrompt, mode, expectedPoints,
}) {
  if (!Number.isInteger(baselineCount) || !Number.isInteger(currentCount) || currentCount !== baselineCount + 1) return null;
  const submittedMs = Date.parse(submittedAt);
  if (!Number.isFinite(submittedMs)) return null;
  const needle = normalize(polishedPrompt);
  if (!needle) return null;
  const eligible = (records ?? []).filter(record => {
    const epoch = Number(record.epoch_ms) || Date.parse(record.timestamp);
    if (!Number.isFinite(epoch) || epoch < submittedMs - 60_000) return false;
    if (!String(record.block_type ?? "").includes("组合区块")) return false;
    if (record.mode !== mode || !normalize(record.prompt).includes(needle)) return false;
    if (record.status === "failed") return record.points === 0;
    if (record.status === "completed") return record.points === expectedPoints;
    return record.status === "running" || record.status === "unknown";
  }).sort((a, b) => (Number(b.epoch_ms) || Date.parse(b.timestamp)) - (Number(a.epoch_ms) || Date.parse(a.timestamp)));
  if (!eligible.length) return null;
  const newest = Number(eligible[0].epoch_ms) || Date.parse(eligible[0].timestamp);
  if (eligible.length > 1 && (Number(eligible[1].epoch_ms) || Date.parse(eligible[1].timestamp)) === newest) {
    throw new Error("新增组合区块历史记录最新时间戳重复，拒绝歧义匹配");
  }
  return eligible[0];
}
