const definitions = {
  product_pair: { types: ["产品列表", "产品分类"], prompt: "产品列表+产品分类" },
  article_pair: { types: ["文章列表", "文章分类"], prompt: "文章列表+文章分类" },
  three_type: { types: ["产品列表", "产品分类", "文章列表"], prompt: "产品列表+产品分类+文章列表" },
  video_pair: { types: ["视频列表", "视频分类"], prompt: "视频列表+视频分类" },
  gallery_pair: { types: ["图册列表", "图册分类"], prompt: "图册列表+图册分类" },
  download_pair: { types: ["下载列表", "下载分类"], prompt: "下载列表+下载分类" },
  faq_pair: { types: ["FAQ 列表", "FAQ 分类"], prompt: "FAQ 列表+FAQ 分类" },
};

const CATEGORY_PATTERN = /categor(y|ies)|classif|sort|cate/i;
const subblockPatterns = {
  "产品列表": /product|goods/i,
  "产品分类": /product.?categor|categor(y|ies)|classif/i,
  "文章列表": /article|news/i,
  "文章分类": /article.?categor|news.?categor|categor(y|ies)|classif/i,
  "视频列表": /video/i,
  "图册列表": /gallery|album|photo|picture/i,
  "下载列表": /download|file/i,
  "FAQ 列表": /faq|question/i,
};
export function comboSubblockPattern(type) {
  return subblockPatterns[type] ?? (/分类$/.test(type) ? CATEGORY_PATTERN : /video|gallery|download|faq/i);
}
export function normalizeComboTypeName(value) { return String(value ?? "").replace(/\s+/g, "").trim(); }

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
  if (!Number.isInteger(baselineCount) || !Number.isInteger(currentCount) || currentCount <= baselineCount) return null;
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
