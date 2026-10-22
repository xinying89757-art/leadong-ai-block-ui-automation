import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceDir = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(sourceDir, "..");

async function loadLocalEnvironment() {
  let contents;
  try {
    contents = await readFile(path.join(projectRoot, ".env.local"), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function deepMerge(base, override) {
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(override ?? {})) {
    result[key] = isPlainObject(value) && isPlainObject(result[key])
      ? deepMerge(result[key], value)
      : structuredClone(value);
  }
  return result;
}

async function readJson(jsonPath) {
  return JSON.parse(await readFile(jsonPath, "utf8"));
}

function resolveProjectPath(value) {
  return path.isAbsolute(value) ? value : path.resolve(projectRoot, value);
}

export async function loadConfig(overridePath = "config/run.json") {
  await loadLocalEnvironment();
  const defaults = await readJson(path.resolve(projectRoot, "config/default.json"));
  const override = overridePath ? await readJson(resolveProjectPath(overridePath)) : {};
  const config = deepMerge(defaults, override);
  config.rankingWorkbook = resolveProjectPath(config.rankingWorkbook);
  config.inputCsv = config.rankingWorkbook;
  for (const key of ["userDataDir", "stateFile", "aiStateFile", "aiRemainingStateDir", "aiDetailStateDir", "aiLifecycleDir", "aiRegressionReportsDir", "artifactsDir", "reportsDir"]) {
    config.paths[key] = resolveProjectPath(config.paths[key]);
  }
  if (config.ai?.inputModeRegression?.imagePath) {
    config.ai.inputModeRegression.imagePath = resolveProjectPath(config.ai.inputModeRegression.imagePath);
  }
  if (config.auth?.configPath) {
    config.auth.configPath = resolveProjectPath(config.auth.configPath);
  }
  if (config.auth?.storageStatePath) {
    config.auth.storageStatePath = resolveProjectPath(config.auth.storageStatePath);
  }
  if (!Number.isInteger(config.blocksPerPage) || config.blocksPerPage < 1) {
    throw new Error("blocksPerPage 必须是大于0的整数");
  }
  validateAiConfig(config.ai);
  validateModePointConfig(config.ai.modePointRegression);
  validateInputModeRegression(config.ai.inputModeRegression);
  validateFullPageRegression(config.ai.fullPageRegression);
  validateHistoryReuseRegression(config.ai.historyReuseRegression);
  validateProductFilterRegression(config.ai.productFilterRegression);
  validateProductListSettingsRegression(config.ai.productListSettingsRegression);
  validateArticleListSettingsRegression(config.ai.articleListSettingsRegression);
  validateNavigationRegression(config.ai.navigationRegression);
  validateImageGalleryRegression(config.ai.imageGalleryRegression);
  validateCompositeRegression(config.ai.compositeRegression);
  validateRegressionSuite(config.ai);
  for (const key of ["rankingWorkbook", "rankingSheetName", "editorUrl", "siteName", "siteLanguage", "publicBaseUrl"]) {
    if (!config[key]) throw new Error(`配置缺少 ${key}`);
  }
  new URL(config.publicBaseUrl);
  return config;
}

export function validateAiConfig(ai) {
  if (!ai?.enabled) return ai;
  for (const key of ['generationTimeoutMs', 'generationStatusRefreshIntervalMs', 'pageSwitchStableMs']) {
    if (ai[key] !== undefined && (!Number.isInteger(ai[key]) || ai[key] <= 0)) throw new Error(`ai.${key} 必须为正整数`);
  }
  if (!Number.isInteger(ai.blocksPerPage) || ai.blocksPerPage < 1) {
    throw new Error("ai.blocksPerPage 必须是大于0的整数");
  }
  if (!Array.isArray(ai.types) || ai.types.length !== ai.blocksPerPage) {
    throw new Error("AI 区块类型数量必须与 ai.blocksPerPage 一致");
  }
  if (new Set(ai.types).size !== ai.types.length) {
    throw new Error("AI 区块类型不能重复");
  }
  const excluded = new Set(ai.excludedTypes ?? []);
  const overlap = ai.types.filter((type) => excluded.has(type));
  if (overlap.length > 0) {
    throw new Error(`AI 区块类型同时出现在 types 和 excludedTypes：${overlap.join(", ")}`);
  }
  for (const type of ai.types) {
    if (typeof ai.prompts?.[type] !== "string" || !ai.prompts[type].trim()) {
      throw new Error(`AI 类型 ${type} 缺少英文提示词`);
    }
  }
  const followupPages = ai.followupPages ?? [];
  const allTypes = [...ai.types];
  const pageNumbers = new Set();
  for (const page of followupPages) {
    if (!Number.isInteger(page.number) || page.number < 2) {
      throw new Error("AI 后续页面 number 必须是大于等于2的整数");
    }
    if (pageNumbers.has(page.number)) {
      throw new Error(`AI 后续页面编号重复：${page.number}`);
    }
    pageNumbers.add(page.number);
    if (!Array.isArray(page.types) || page.types.length < 1 || page.types.length > ai.blocksPerPage) {
      throw new Error(`AI 后续页面 ${page.number} 的类型数量必须在 1 到 ai.blocksPerPage 之间`);
    }
    for (const type of page.types) {
      if (excluded.has(type)) {
        throw new Error(`AI 类型 ${type} 同时出现在后续页面和 excludedTypes 中`);
      }
      if (allTypes.includes(type)) {
        throw new Error(`AI 类型重复出现在多个页面：${type}`);
      }
      if (typeof ai.prompts?.[type] !== "string" || !ai.prompts[type].trim()) {
        throw new Error(`AI 类型 ${type} 缺少英文提示词`);
      }
      allTypes.push(type);
    }
  }
  if (new Set(allTypes).size !== allTypes.length) {
    throw new Error("AI 区块类型不能跨页面重复");
  }
  const detailPages = ai.detailPages ?? [];
  const detailTypes = new Set();
  const systemPages = new Set();
  for (const detail of detailPages) {
    if (!["type", "systemPage", "module", "moduleId", "listPage", "marker"].every((key) => typeof detail[key] === "string" && detail[key].trim())) {
      throw new Error("AI 详情页配置缺少类型、系统页或内容模块");
    }
    if (!Number.isInteger(detail.titleCell) || detail.titleCell < 0) {
      throw new Error(`AI 详情类型 ${detail.type} 的 titleCell 无效`);
    }
    if (detailTypes.has(detail.type) || systemPages.has(detail.systemPage) || allTypes.includes(detail.type)) {
      throw new Error(`AI 详情类型或系统页重复：${detail.type}`);
    }
    if (typeof ai.prompts?.[detail.type] !== "string" || !ai.prompts[detail.type].trim()) {
      throw new Error(`AI 详情类型 ${detail.type} 缺少英文提示词`);
    }
    detailTypes.add(detail.type);
    systemPages.add(detail.systemPage);
  }
  if (typeof ai.promptPolishEnabled !== "boolean") {
    throw new Error("ai.promptPolishEnabled 必须是布尔值");
  }
  if (typeof ai.aiPolishSelector !== "string" || !ai.aiPolishSelector.trim()) {
    throw new Error("ai.aiPolishSelector 不能为空");
  }
  for (const key of ["aiPolishTimeoutMs", "applyIntervalMs", "publishInitialWaitMs", "publishPollIntervalMs", "publishTimeoutMs"]) {
    if (!Number.isInteger(ai[key]) || ai[key] < 0) {
      throw new Error(`ai.${key} 必须是非负整数`);
    }
  }
  if (!ai.inputMode || !ai.generationMode) {
    throw new Error("AI inputMode 和 generationMode 不能为空");
  }
  return ai;
}

export function validateRegressionSuite(ai) {
  const suite = ai?.regressionSuite;
  if (!suite?.enabled) return suite;
  for (const key of ["continueAfterBusinessFailure", "stopOnSafetyFailure"]) {
    if (typeof suite[key] !== "boolean") throw new Error(`regressionSuite.${key} 必须是布尔值`);
  }
  if (suite.retryFailedAtEnd !== undefined && typeof suite.retryFailedAtEnd !== 'boolean') throw new Error('regressionSuite.retryFailedAtEnd 必须是布尔值');
  if (suite.maxEndRetries !== undefined && suite.maxEndRetries !== 1) throw new Error('regressionSuite.maxEndRetries 必须为 1');
  const pages = [{ number: 1, types: ai.types }, ...(ai.followupPages ?? [])];
  if (pages.length !== 3 || pages.some((page) => page.types.length !== 5)) {
    throw new Error("全量回归必须配置三页且每页五种非详情区块");
  }
  const types = pages.flatMap((page) => page.types);
  if (types.length !== 15 || new Set(types).size !== 15) {
    throw new Error("全量回归必须包含 15 种不重复的非详情区块");
  }
  for (const required of ["产品筛选", "导航"]) {
    if (!pages[2].types.includes(required)) throw new Error(`全量回归第三页缺少 ${required}`);
  }
  return suite;
}

export function validateModePointConfig(mode) {
  if (!mode?.enabled) return mode;
  for (const key of ["type", "inputMode", "pageNamePrefix", "pagePathPrefix"]) {
    if (typeof mode[key] !== "string" || !mode[key].trim()) throw new Error(`modePointRegression.${key} 不能为空`);
  }
  if (mode.promptPolishEnabled !== false) throw new Error("点数专项必须关闭提示词润色");
  if (!Number.isInteger(mode.blocksPerPage) || mode.blocksPerPage !== 3) throw new Error("点数专项必须配置三个区块");
  if (!Array.isArray(mode.modes) || mode.modes.length !== mode.blocksPerPage) throw new Error("点数专项模式数量无效");
  const expected = [["quick", "快速模式", 6], ["advanced", "进阶模式", 10], ["deep", "深度模式", 20]];
  const headings = new Set();
  mode.modes.forEach((item, index) => {
    const [key, label, cost] = expected[index];
    if (item.key !== key || item.label !== label || item.expectedCost !== cost) throw new Error(`点数专项第 ${index + 1} 个模式配置无效`);
    if (typeof item.heading !== "string" || !item.heading.includes("Static Text") || headings.has(item.heading)) throw new Error("点数专项标题缺失或重复");
    headings.add(item.heading);
  });
  for (const key of ["pointsPollIntervalMs", "pointsTimeoutMs", "generationTimeoutMs", "generationStatusRefreshIntervalMs"]) {
    if (!Number.isInteger(mode[key]) || mode[key] < 1) throw new Error(`modePointRegression.${key} 必须为正整数`);
  }
  return mode;
}

export function validateInputModeRegression(mode) {
  if (!mode?.enabled) return mode;
  for (const key of ["type", "generationMode", "pageNamePrefix", "pagePathPrefix", "imagePath", "referenceUrl"]) {
    if (typeof mode[key] !== "string" || !mode[key].trim()) throw new Error(`inputModeRegression.${key} 不能为空`);
  }
  if (mode.promptPolishEnabled !== false) throw new Error("输入方式专项必须关闭提示词润色");
  if (!Number.isInteger(mode.blocksPerPage) || mode.blocksPerPage !== 3) throw new Error("输入方式专项必须配置三个区块");
  if (!Number.isInteger(mode.expectedCost) || mode.expectedCost !== 6) throw new Error("输入方式专项快速模式预期扣点必须为 6");
  try {
    const url = new URL(mode.referenceUrl);
    if (url.protocol !== "https:") throw new Error("参考网址必须使用 HTTPS");
  } catch (error) {
    if (error.message === "参考网址必须使用 HTTPS") throw error;
    throw new Error("inputModeRegression.referenceUrl 必须是有效 HTTPS URL");
  }
  if (!Array.isArray(mode.inputModes) || mode.inputModes.length !== mode.blocksPerPage) throw new Error("输入方式专项模式数量无效");
  const keys = new Set();
  const labels = new Set();
  const headings = new Set();
  for (const item of mode.inputModes) {
    if (!["text", "image", "url"].includes(item.key) || !item.label || !item.heading) throw new Error("输入方式专项包含无效模式");
    if (keys.has(item.key) || labels.has(item.label) || headings.has(item.heading)) throw new Error("输入方式专项模式不能重复");
    keys.add(item.key); labels.add(item.label); headings.add(item.heading);
  }
  for (const key of ["pointsPollIntervalMs", "pointsTimeoutMs"]) {
    if (!Number.isInteger(mode[key]) || mode[key] < 1) throw new Error(`inputModeRegression.${key} 必须为正整数`);
  }
  return mode;
}

export function validateFullPageRegression(mode) {
  if (!mode?.enabled) return mode;
  for (const key of ["inputMode", "generationMode", "pageNamePrefix", "pagePathPrefix"]) {
    if (typeof mode[key] !== "string" || !mode[key].trim()) throw new Error(`fullPageRegression.${key} 不能为空`);
  }
  if (mode.inputMode !== "文字描述" || mode.generationMode !== "快速模式") {
    throw new Error("整页专项目前只支持文字描述和快速模式");
  }
  if (mode.promptPolishEnabled !== false) throw new Error("整页专项必须关闭提示词润色");
  if (mode.autoRetryFailed !== undefined && typeof mode.autoRetryFailed !== "boolean") {
    throw new Error("fullPageRegression.autoRetryFailed 必须为布尔值");
  }
  if (mode.maxGenerationRetries !== undefined &&
      (!Number.isInteger(mode.maxGenerationRetries) || mode.maxGenerationRetries < 0 || mode.maxGenerationRetries > 3)) {
    throw new Error("fullPageRegression.maxGenerationRetries 必须为 0 到 3 的整数");
  }
  if (!Number.isInteger(mode.generationTimeoutMs) || mode.generationTimeoutMs < 30000) {
    throw new Error("fullPageRegression.generationTimeoutMs 必须不少于 30000 毫秒");
  }
  if (mode.requireSectionLabels !== undefined && typeof mode.requireSectionLabels !== "boolean") {
    throw new Error("fullPageRegression.requireSectionLabels 必须为布尔值");
  }
  if (mode.editorStabilizeMs !== undefined &&
      (!Number.isInteger(mode.editorStabilizeMs) || mode.editorStabilizeMs < 0)) {
    throw new Error("fullPageRegression.editorStabilizeMs 必须为非负整数");
  }
  if (mode.generationStatusRefreshIntervalMs !== undefined &&
      (!Number.isInteger(mode.generationStatusRefreshIntervalMs) || mode.generationStatusRefreshIntervalMs < 1000)) {
    throw new Error("fullPageRegression.generationStatusRefreshIntervalMs 必须不少于 1000 毫秒");
  }
  if (mode.maxGenerationRefreshes !== undefined &&
      (!Number.isInteger(mode.maxGenerationRefreshes) || mode.maxGenerationRefreshes < 1)) {
    throw new Error("fullPageRegression.maxGenerationRefreshes 必须为正整数");
  }
  if (!Array.isArray(mode.sections) || mode.sections.length < 4 || new Set(mode.sections).size !== mode.sections.length) {
    throw new Error("整页专项必须配置不重复的内容版块");
  }
  validateApplicationWait(mode, "fullPageRegression");
  return mode;
}

function validateApplicationWait(mode, prefix) {
  for (const key of ["applicationTimeoutMs", "applicationStableMs", "applicationPollIntervalMs"]) {
    if (mode[key] !== undefined && (!Number.isInteger(mode[key]) || mode[key] < 1)) {
      throw new Error(`${prefix}.${key} 必须为正整数`);
    }
  }
  if (mode.applicationStableMs >= mode.applicationTimeoutMs) throw new Error(`${prefix} 稳定窗口必须小于添加等待超时`);
}

export function validateHistoryReuseRegression(mode) {
  if (!mode?.enabled) return mode;
  for (const key of [
    "inputMode",
    "generationMode",
    "blockType",
    "fullPageNamePrefix",
    "fullPagePathPrefix",
    "blockPageNamePrefix",
    "blockPagePathPrefix",
  ]) {
    if (typeof mode[key] !== "string" || !mode[key].trim()) {
      throw new Error(`historyReuseRegression.${key} 不能为空`);
    }
  }
  if (mode.inputMode !== "文字描述" || mode.generationMode !== "快速模式") {
    throw new Error("生成记录复用专项目前只支持文字描述和快速模式");
  }
  if (mode.blockType !== "静态图文") throw new Error("生成记录复用专项的区块类型必须为静态图文");
  if (mode.promptPolishEnabled !== false) throw new Error("生成记录复用专项必须关闭提示词润色");
  for (const key of ["fullPagePathPrefix", "blockPagePathPrefix"]) {
    if (mode[key].startsWith("/") || mode[key].includes("?")) {
      throw new Error(`historyReuseRegression.${key} 必须是不带前导斜杠和查询参数的路径前缀`);
    }
  }
  for (const key of [
    "editorStabilizeMs",
    "generationStatusRefreshIntervalMs",
    "maxGenerationRefreshes",
    "generationTimeoutMs",
    "applyIntervalMs",
    "publishInitialWaitMs",
    "publishPollIntervalMs",
    "publishTimeoutMs",
  ]) {
    if (!Number.isInteger(mode[key]) || mode[key] < 0) {
      throw new Error(`historyReuseRegression.${key} 必须是非负整数`);
    }
  }
  if (mode.generationStatusRefreshIntervalMs < 1000) {
    throw new Error("historyReuseRegression.generationStatusRefreshIntervalMs 必须不少于 1000 毫秒");
  }
  if (mode.maxGenerationRefreshes < 1) {
    throw new Error("historyReuseRegression.maxGenerationRefreshes 必须为正整数");
  }
  if (mode.generationTimeoutMs < 30000) {
    throw new Error("historyReuseRegression.generationTimeoutMs 必须不少于 30000 毫秒");
  }
  validateApplicationWait(mode, "historyReuseRegression");
  return mode;
}

export function validateProductFilterRegression(mode) {
  if (!mode?.enabled) return mode;
  for (const key of ["type", "inputMode", "generationMode", "pageName", "pagePath", "prompt"]) {
    if (typeof mode[key] !== "string" || !mode[key].trim()) {
      throw new Error(`productFilterRegression.${key} 不能为空`);
    }
  }
  if (mode.type !== "产品筛选") throw new Error("产品筛选专项类型必须为产品筛选");
  if (mode.inputMode !== "文字描述" || mode.generationMode !== "快速模式") {
    throw new Error("产品筛选专项目前只支持文字描述和快速模式");
  }
  if (!mode.pagePath.startsWith("/")) throw new Error("productFilterRegression.pagePath 必须以 / 开头");
  if (mode.pagePath.includes("?")) throw new Error("productFilterRegression.pagePath 不能包含查询参数");
  if (mode.promptPolishEnabled !== true) throw new Error("产品筛选专项必须启用提示词润色");
  if (!Number.isInteger(mode.blocksPerPage) || mode.blocksPerPage !== 1) {
    throw new Error("产品筛选专项必须配置一个区块");
  }
  if (!Number.isInteger(mode.fieldsLoadTimeoutMs) || mode.fieldsLoadTimeoutMs < 1000) {
    throw new Error("productFilterRegression.fieldsLoadTimeoutMs 必须不少于 1000 毫秒");
  }
  for (const key of ["applyIntervalMs", "publishInitialWaitMs", "publishPollIntervalMs", "publishTimeoutMs"]) {
    if (!Number.isInteger(mode[key]) || mode[key] < 0) {
      throw new Error(`productFilterRegression.${key} 必须是非负整数`);
    }
  }
  return mode;
}

export function validateProductListSettingsRegression(mode) {
  if (!mode?.enabled) return mode;
  for (const key of ["type", "inputMode", "generationMode", "pageNamePrefix", "pagePathPrefix", "prompt"]) {
    if (typeof mode[key] !== "string" || !mode[key].trim()) {
      throw new Error(`productListSettingsRegression.${key} 不能为空`);
    }
  }
  if (mode.type !== "产品列表") throw new Error("产品列表设置专项类型必须为产品列表");
  if (mode.inputMode !== "文字描述" || mode.generationMode !== "快速模式") {
    throw new Error("产品列表设置专项目前只支持文字描述和快速模式");
  }
  if (mode.promptPolishEnabled !== true) throw new Error("产品列表设置专项必须启用提示词润色");
  if (!Number.isInteger(mode.expectedPageSize) || mode.expectedPageSize < 1) {
    throw new Error("productListSettingsRegression.expectedPageSize 必须为正整数");
  }
  if (mode.expectedPageSize !== 5) throw new Error("产品列表结果级专项每页展示数量必须为 5");
  if (mode.skipProductScope !== undefined && typeof mode.skipProductScope !== "boolean") {
    throw new Error("productListSettingsRegression.skipProductScope 必须为布尔值");
  }
  for (const key of ["productSortLabel", "displayFieldLabel", "targetColorHex"]) {
    if (typeof mode[key] !== "string" || !mode[key].trim()) throw new Error(`productListSettingsRegression.${key} 不能为空`);
  }
  if (!/^#[0-9a-f]{6}$/i.test(mode.targetColorHex)) throw new Error("productListSettingsRegression.targetColorHex 必须是六位十六进制颜色");
  if (mode.pagePathPrefix.startsWith("/") || mode.pagePathPrefix.includes("?")) {
    throw new Error("productListSettingsRegression.pagePathPrefix 必须是不带前导斜杠和查询参数的路径前缀");
  }
  if (!Number.isInteger(mode.blocksPerPage) || mode.blocksPerPage !== 1) {
    throw new Error("产品列表设置专项必须配置一个区块");
  }
  for (const key of ["applyIntervalMs", "publishInitialWaitMs", "publishPollIntervalMs", "publishTimeoutMs"]) {
    if (!Number.isInteger(mode[key]) || mode[key] < 0) {
      throw new Error(`productListSettingsRegression.${key} 必须是非负整数`);
    }
  }
  const fallback = mode.midsceneFallback;
  if (fallback?.enabled) {
    if (fallback.scope !== "all-settings") {
      throw new Error("productListSettingsRegression.midsceneFallback.scope 必须为 all-settings");
    }
    for (const key of ["domFastPathTimeoutMs", "maxCallsPerSetting", "midsceneTimeoutMs"]) {
      if (!Number.isInteger(fallback[key]) || fallback[key] < 0) {
        throw new Error(`productListSettingsRegression.midsceneFallback.${key} 必须是非负整数`);
      }
    }
    if (fallback.maxCallsPerSetting !== 1) {
      throw new Error("产品列表设置专项每个设置项最多允许一次 Midscene 调用");
    }
  }
  return mode;
}

export function validateArticleListSettingsRegression(mode) {
  if (!mode?.enabled) return mode;
  for (const key of ["type", "inputMode", "generationMode", "pageNamePrefix", "pagePathPrefix", "prompt", "articleSortLabel"]) {
    if (typeof mode[key] !== "string" || !mode[key].trim()) throw new Error(`articleListSettingsRegression.${key} 不能为空`);
  }
  if (mode.type !== "文章列表") throw new Error("文章列表设置专项类型必须为文章列表");
  if (mode.inputMode !== "文字描述" || mode.generationMode !== "快速模式") throw new Error("文章列表设置专项目前只支持文字描述和快速模式");
  if (mode.promptPolishEnabled !== true) throw new Error("文章列表设置专项必须启用提示词润色");
  if (!Number.isInteger(mode.expectedPageSize) || mode.expectedPageSize !== 5) throw new Error("文章列表结果级专项每页数量必须设置为 5");
  if (!Number.isInteger(mode.blocksPerPage) || mode.blocksPerPage !== 1) throw new Error("文章列表设置专项必须配置一个区块");
  if (mode.pagePathPrefix.startsWith("/") || mode.pagePathPrefix.includes("?")) throw new Error("articleListSettingsRegression.pagePathPrefix 必须是不带前导斜杠和查询参数的路径前缀");
  if (!['全部文章', '指定分类', '指定文章'].includes(mode.articleScopeMode)) throw new Error("articleListSettingsRegression.articleScopeMode 必须是有效文章范围");
  if (mode.targetColorHex !== undefined && !/^#[0-9a-f]{6}$/i.test(mode.targetColorHex)) throw new Error("articleListSettingsRegression.targetColorHex 必须为 HEX 颜色");
  for (const key of ["applyIntervalMs", "publishInitialWaitMs", "publishPollIntervalMs", "publishTimeoutMs"]) {
    if (!Number.isInteger(mode[key]) || mode[key] < 0) throw new Error(`articleListSettingsRegression.${key} 必须为非负整数`);
  }
  return mode;
}

export function validateNavigationRegression(mode) {
  if (!mode?.enabled) return mode;
  for (const key of ["type", "inputMode", "generationMode", "pageName", "pagePath", "prompt"]) {
    if (typeof mode[key] !== "string" || !mode[key].trim()) {
      throw new Error(`navigationRegression.${key} 不能为空`);
    }
  }
  if (mode.type !== "导航") throw new Error("导航专项类型必须为导航");
  if (mode.pageName !== "AI区块类型回归-005") throw new Error("导航专项页面名称必须为 AI区块类型回归-005");
  if (mode.pagePath !== "/ai-block-type-regression-005") throw new Error("导航专项页面路径必须为 /ai-block-type-regression-005");
  if (mode.inputMode !== "文字描述" || mode.generationMode !== "快速模式") {
    throw new Error("导航专项目前只支持文字描述和快速模式");
  }
  if (!mode.pagePath.startsWith("/") || mode.pagePath.includes("?")) {
    throw new Error("navigationRegression.pagePath 必须是无查询参数的绝对路径");
  }
  if (mode.promptPolishEnabled !== true) throw new Error("导航专项必须启用提示词润色");
  if (!Number.isInteger(mode.blocksPerPage) || mode.blocksPerPage !== 1) {
    throw new Error("导航专项必须配置一个区块");
  }
  if (!Number.isInteger(mode.selectPageCount) || mode.selectPageCount !== 2) {
    throw new Error("导航专项必须选择两个页面");
  }
  for (const key of ["applyIntervalMs", "publishInitialWaitMs", "publishPollIntervalMs", "publishTimeoutMs"]) {
    if (!Number.isInteger(mode[key]) || mode[key] < 0) {
      throw new Error(`navigationRegression.${key} 必须是非负整数`);
    }
  }
  return mode;
}

export function validateImageGalleryRegression(mode) {
  if (!mode?.enabled) return mode;
  for (const key of ["type", "inputMode", "generationMode", "pageNamePrefix", "pagePathPrefix", "prompt"]) {
    if (typeof mode[key] !== "string" || !mode[key].trim()) {
      throw new Error(`imageGalleryRegression.${key} 不能为空`);
    }
  }
  if (mode.type !== "图片集") throw new Error("图片集专项类型必须为图片集，不能映射到图册列表");
  if (mode.inputMode !== "文字描述" || mode.generationMode !== "快速模式") {
    throw new Error("图片集专项目前只支持文字描述和快速模式");
  }
  if (typeof mode.promptPolishEnabled !== "boolean") throw new Error("imageGalleryRegression.promptPolishEnabled 必须是布尔值");
  if (mode.pagePathPrefix.startsWith("/") || mode.pagePathPrefix.includes("?")) {
    throw new Error("imageGalleryRegression.pagePathPrefix 必须是不带前导斜杠和查询参数的路径前缀");
  }
  if (!Number.isInteger(mode.generationTimeoutMs) || mode.generationTimeoutMs < 1 || mode.generationTimeoutMs > 180000) {
    throw new Error("imageGalleryRegression.generationTimeoutMs 必须为 1–180000 毫秒");
  }
  if (!Number.isInteger(mode.generationStatusRefreshIntervalMs) || mode.generationStatusRefreshIntervalMs < 1) {
    throw new Error("imageGalleryRegression.generationStatusRefreshIntervalMs 必须为正整数");
  }
  for (const key of ["applyIntervalMs", "publishInitialWaitMs", "publishPollIntervalMs", "publishTimeoutMs"]) {
    if (!Number.isInteger(mode[key]) || mode[key] < 0) {
      throw new Error(`imageGalleryRegression.${key} 必须为非负整数`);
    }
  }
  if (!/\bEnglish\b/i.test(mode.prompt)) throw new Error("图片集专项提示词必须明确要求英文内容");
  return mode;
}

export function validateCompositeRegression(mode) {
  if (!mode?.enabled) return mode;
  for (const key of ["type", "staticType", "inputMode", "generationMode", "pageNamePrefix", "pagePathPrefix", "prompt"]) {
    if (typeof mode[key] !== "string" || !mode[key].trim()) throw new Error(`compositeRegression.${key} 不能为空`);
  }
  if (mode.type !== "复合区块") throw new Error("复合区块专项类型必须为复合区块");
  if (mode.staticType !== "静态图文") throw new Error("复合区块专项静态布局必须为静态图文");
  if (mode.inputMode !== "文字描述" || !["快速模式", "进阶模式", "深度模式"].includes(mode.generationMode)) {
    throw new Error("复合区块专项目前只支持文字描述及快速、进阶或深度模式");
  }
  if (typeof mode.promptPolishEnabled !== "boolean") throw new Error("compositeRegression.promptPolishEnabled 必须是布尔值");
  if (!Number.isInteger(mode.maxGenerationAttempts) || mode.maxGenerationAttempts < 1 || mode.maxGenerationAttempts > 10) {
    throw new Error("compositeRegression.maxGenerationAttempts 必须为 1–10 的正整数");
  }
  if (!Array.isArray(mode.dynamicTypes) || mode.dynamicTypes.length < 1 || mode.dynamicTypes.length > 3) {
    throw new Error("复合区块专项必须选择 1–3 种动态区块类型");
  }
  const validDynamicTypes = new Set(["产品列表", "产品筛选", "文章列表", "视频列表", "图册列表", "下载列表", "FAQ 列表", "产品分类", "文章分类", "视频分类", "图册分类", "下载分类", "FAQ 分类", "图册详情", "文章详情", "视频详情", "导航"]);
  const unique = new Set(mode.dynamicTypes);
  if (unique.size !== mode.dynamicTypes.length || mode.dynamicTypes.some(type => !validDynamicTypes.has(type))) {
    throw new Error("compositeRegression.dynamicTypes 必须是互不重复的动态区块菜单项");
  }
  if (mode.pagePathPrefix.startsWith("/") || mode.pagePathPrefix.includes("?")) throw new Error("compositeRegression.pagePathPrefix 必须是不带前导斜杠和查询参数的路径前缀");
  if (!Number.isInteger(mode.generationTimeoutMs) || mode.generationTimeoutMs < 1 || mode.generationTimeoutMs > 600000) throw new Error("compositeRegression.generationTimeoutMs 必须为 1–600000 毫秒");
  if (!Number.isInteger(mode.generationStatusRefreshIntervalMs) || mode.generationStatusRefreshIntervalMs < 1) throw new Error("compositeRegression.generationStatusRefreshIntervalMs 必须为正整数");
  for (const key of ["applyIntervalMs", "publishInitialWaitMs", "publishPollIntervalMs", "publishTimeoutMs"]) {
    if (!Number.isInteger(mode[key]) || mode[key] < 0) throw new Error(`compositeRegression.${key} 必须为非负整数`);
  }
  if (!/\bEnglish\b/i.test(mode.prompt)) throw new Error("复合区块专项提示词必须明确要求英文内容");
  const linkage = mode.productCategoryRegression;
  if (linkage?.enabled) {
    if (linkage.systemPage !== 'Products' || linkage.publicPath !== '/products.html') throw new Error('复合区块分类联动必须使用 Products 系统页');
    if (typeof linkage.categoryName !== 'string' || !linkage.categoryName.trim()) throw new Error('复合区块分类联动缺少目标分类');
    for (const key of ['interactionTimeoutMs', 'stableMs']) if (!Number.isInteger(linkage[key]) || linkage[key] <= 0) throw new Error(`分类联动 ${key} 必须为正整数`);
  }
  return mode;
}

export function pageDescriptor(config, pageNumber) {
  const suffix = String(pageNumber).padStart(3, "0");
  return {
    number: pageNumber,
    name: `${config.pageNamePrefix}${suffix}`,
    path: `/${config.pagePathPrefix}${suffix}`,
    publicUrl: new URL(`/${config.pagePathPrefix}${suffix}`, config.publicBaseUrl).toString(),
  };
}

export function aiPageDescriptor(config, pageNumber = 1) {
  const ai = config.ai;
  const suffix = String(pageNumber).padStart(3, "0");
  const runSuffix = ai.isolatedPages && ai.runId
    ? `-${String(ai.runId).replace(/[^a-zA-Z0-9_-]+/g, "-")}`
    : "";
  return {
    number: pageNumber,
    name: `${ai.pageNamePrefix}${suffix}${runSuffix}`,
    path: `/${ai.pagePathPrefix}${suffix}${runSuffix}`,
    publicUrl: new URL(`/${ai.pagePathPrefix}${suffix}${runSuffix}`, config.publicBaseUrl).toString(),
  };
}
