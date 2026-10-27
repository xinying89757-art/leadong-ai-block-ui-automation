import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceDir = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(sourceDir, "..");

const settingAliases = {
  LEADONG_ADMIN_ACCOUNT: ["AIBLOCK_ADMIN_ACCOUNT", "BUG1004949_ADMIN_ACCOUNT"],
  LEADONG_ADMIN_PASSWORD: ["AIBLOCK_ADMIN_PASSWORD", "BUG1004949_ADMIN_PASSWORD"],
  LEADONG_ADMIN_CONFIG: ["AIBLOCK_ADMIN_CONFIG", "BUG1004949_ADMIN_CONFIG"],
  LEADONG_TEST_IMAGE: ["AIBLOCK_TEST_IMAGE"],
  LEADONG_BROWSER_CHANNEL: ["AIBLOCK_BROWSER_CHANNEL"],
  LEADONG_HEADLESS: ["AIBLOCK_HEADLESS"],
  LEADONG_SLOW_MO: ["AIBLOCK_SLOW_MO", "AIBLOCK_SLOWMO"],
  LEADONG_TEST_BROWSER_CHANNEL: ["AIBLOCK_TEST_BROWSER_CHANNEL"],
};

export function resolveSetting(name, fallback, env = process.env, { allowEmpty = false } = {}) {
  const names = [name, ...(settingAliases[name] ?? [])];
  for (const alias of names) {
    const value = env[alias];
    if (value !== undefined && (allowEmpty || value !== "")) return value;
  }
  return fallback;
}

export const leadongEnv = resolveSetting;

export function parseLocalEnvironment(contents, env = process.env) {
  for (const line of String(contents).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || env[key] !== undefined) continue;
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

export async function loadLocalEnvironment(root = projectRoot, env = process.env) {
  // Keep offline tests isolated from any real workstation-local configuration.
  if (root === projectRoot && env === process.env && (process.argv.includes("--test") || process.env.NODE_TEST_CONTEXT)) return;
  try {
    parseLocalEnvironment(await readFile(path.resolve(root, ".env.local"), "utf8"), env);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
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

export function resolveProjectPath(value) {
  return path.isAbsolute(value) ? value : path.resolve(projectRoot, value);
}

export async function loadConfig(overridePath = "config/run.json") {
  await loadLocalEnvironment();
  const defaults = await readJson(path.resolve(projectRoot, "config/default.json"));
  const override = overridePath ? await readJson(resolveProjectPath(overridePath)) : {};
  const config = deepMerge(defaults, override);
  for (const [key, value] of Object.entries(config.paths ?? {})) {
    if (typeof value === "string" && value) config.paths[key] = resolveProjectPath(value);
  }
  if (config.htmlUploadRegression?.filePath) config.htmlUploadRegression.filePath = resolveProjectPath(config.htmlUploadRegression.filePath);
  const testImagePath = resolveSetting("LEADONG_TEST_IMAGE", config.ai?.inputModeRegression?.imagePath);
  if (testImagePath) {
    config.ai.inputModeRegression.imagePath = resolveProjectPath(testImagePath);
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
  if (!generationModeConfig(config.ai, config.ai.generationMode)) throw new Error("ai.generationMode 必须匹配 ai.generationModes");
  validateGenerationModes(config.ai.generationModes);
  config.ai.modePointRegression.modes = config.ai.generationModes.map((item) => ({ ...item }));
  config.ai.inputModeRegression.expectedCost = generationModeConfig(config.ai, config.ai.inputModeRegression.generationMode)?.expectedCost ?? config.ai.inputModeRegression.expectedCost;
  validateModePointConfig(config.ai.modePointRegression);
  validateInputModeRegression(config.ai.inputModeRegression, config.ai.generationModes);
  validateFullPageRegression(config.ai.fullPageRegression, config.ai.generationModes);
  validateHistoryReuseRegression(config.ai.historyReuseRegression, config.ai.generationModes);
  validateProductFilterRegression(config.ai.productFilterRegression, config.ai.generationModes);
  validateProductListSettingsRegression(config.ai.productListSettingsRegression, config.ai.generationModes);
  validateArticleListSettingsRegression(config.ai.articleListSettingsRegression, config.ai.generationModes);
  validateNavigationRegression(config.ai.navigationRegression, config.ai.generationModes);
  validateImageGalleryRegression(config.ai.imageGalleryRegression, config.ai.generationModes);
  validateCompositeRegression(config.ai.compositeRegression, config.ai.generationModes);
  if (!generationModeConfig(config.ai, config.ai.compositeRegression?.generationMode)) throw new Error("复合区块专项 generationMode 必须匹配 ai.generationModes");
  validateRegressionSuite(config.ai);
  for (const key of ["editorUrl", "siteName", "siteLanguage", "publicBaseUrl"]) {
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

export function validateGenerationModes(modes) {
  if (!Array.isArray(modes) || modes.length < 1) throw new Error("ai.generationModes 必须至少包含一种模式");
  const keys = new Set();
  const labels = new Set();
  for (const item of modes) {
    if (!item || typeof item.key !== "string" || !item.key.trim() || keys.has(item.key)) throw new Error("ai.generationModes.key 必须非空且唯一");
    if (typeof item.label !== "string" || !item.label.trim() || labels.has(item.label)) throw new Error("ai.generationModes.label 必须非空且唯一");
    if (!Number.isInteger(item.expectedCost) || item.expectedCost <= 0) throw new Error(`ai.generationModes.${item.key}.expectedCost 必须为正整数`);
    if (item.aliases !== undefined && (!Array.isArray(item.aliases) || item.aliases.some(alias => typeof alias !== "string" || !alias.trim()))) throw new Error(`ai.generationModes.${item.key}.aliases 无效`);
    keys.add(item.key); labels.add(item.label);
  }
  return modes;
}

export function generationModeConfig(ai, labelOrAlias) {
  return ai?.generationModes?.find(item => item.label === labelOrAlias || item.aliases?.includes(labelOrAlias));
}

function matchesGenerationMode(modes, labelOrAlias, key = "quick") {
  const mode = modes.find(item => item.key === key);
  return Boolean(mode && (mode.label === labelOrAlias || mode.aliases?.includes(labelOrAlias)));
}

export function validateModePointConfig(mode) {
  if (!mode?.enabled) return mode;
  for (const key of ["type", "inputMode", "pageNamePrefix", "pagePathPrefix"]) {
    if (typeof mode[key] !== "string" || !mode[key].trim()) throw new Error(`modePointRegression.${key} 不能为空`);
  }
  if (mode.promptPolishEnabled !== false) throw new Error("点数专项必须关闭提示词润色");
  if (!Number.isInteger(mode.blocksPerPage) || mode.blocksPerPage !== 3) throw new Error("点数专项必须配置三个区块");
  if (!Array.isArray(mode.modes) || mode.modes.length !== mode.blocksPerPage) throw new Error("点数专项模式数量无效");
  const headings = new Set();
  const keys = new Set();
  mode.modes.forEach((item) => {
    if (typeof item.key !== "string" || !item.key.trim() || keys.has(item.key) || typeof item.label !== "string" || !item.label.trim() || !Number.isInteger(item.expectedCost) || item.expectedCost <= 0) throw new Error("点数专项模式配置无效");
    if (typeof item.heading !== "string" || !item.heading.includes("Static Text") || headings.has(item.heading)) throw new Error("点数专项标题缺失或重复");
    keys.add(item.key); headings.add(item.heading);
  });
  for (const key of ["pointsPollIntervalMs", "pointsTimeoutMs", "generationTimeoutMs", "generationStatusRefreshIntervalMs"]) {
    if (!Number.isInteger(mode[key]) || mode[key] < 1) throw new Error(`modePointRegression.${key} 必须为正整数`);
  }
  return mode;
}

export function validateInputModeRegression(mode, generationModes = DEFAULT_GENERATION_MODES) {
  if (!mode?.enabled) return mode;
  for (const key of ["type", "generationMode", "pageNamePrefix", "pagePathPrefix", "imagePath", "referenceUrl"]) {
    if (typeof mode[key] !== "string" || !mode[key].trim()) throw new Error(`inputModeRegression.${key} 不能为空`);
  }
  if (mode.promptPolishEnabled !== false) throw new Error("输入方式专项必须关闭提示词润色");
  if (!Number.isInteger(mode.blocksPerPage) || mode.blocksPerPage !== 3) throw new Error("输入方式专项必须配置三个区块");
  if (!matchesGenerationMode(generationModes, mode.generationMode)) throw new Error("输入方式专项目前只支持配置中的快速模式");
  if (!Number.isInteger(mode.expectedCost) || mode.expectedCost <= 0) throw new Error("输入方式专项 expectedCost 必须为正整数");
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

const DEFAULT_GENERATION_MODES = [{ key: "quick", label: "快速模式", aliases: [] }, { key: "advanced", label: "进阶模式", aliases: ["高级模式"] }, { key: "deep", label: "深度模式", aliases: [] }];

export function validateFullPageRegression(mode, generationModes = DEFAULT_GENERATION_MODES) {
  if (!mode?.enabled) return mode;
  for (const key of ["inputMode", "generationMode", "pageNamePrefix", "pagePathPrefix"]) {
    if (typeof mode[key] !== "string" || !mode[key].trim()) throw new Error(`fullPageRegression.${key} 不能为空`);
  }
  if (mode.inputMode !== "文字描述" || !matchesGenerationMode(generationModes, mode.generationMode)) {
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

export function validateHistoryReuseRegression(mode, generationModes = DEFAULT_GENERATION_MODES) {
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
  if (mode.inputMode !== "文字描述" || !matchesGenerationMode(generationModes, mode.generationMode)) {
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

export function validateProductFilterRegression(mode, generationModes = DEFAULT_GENERATION_MODES) {
  if (!mode?.enabled) return mode;
  for (const key of ["type", "inputMode", "generationMode", "pageName", "pagePath", "prompt"]) {
    if (typeof mode[key] !== "string" || !mode[key].trim()) {
      throw new Error(`productFilterRegression.${key} 不能为空`);
    }
  }
  if (mode.type !== "产品筛选") throw new Error("产品筛选专项类型必须为产品筛选");
  if (mode.inputMode !== "文字描述" || !matchesGenerationMode(generationModes, mode.generationMode)) {
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

export function validateProductListSettingsRegression(mode, generationModes = DEFAULT_GENERATION_MODES) {
  if (!mode?.enabled) return mode;
  for (const key of ["type", "inputMode", "generationMode", "pageNamePrefix", "pagePathPrefix", "prompt"]) {
    if (typeof mode[key] !== "string" || !mode[key].trim()) {
      throw new Error(`productListSettingsRegression.${key} 不能为空`);
    }
  }
  if (mode.type !== "产品列表") throw new Error("产品列表设置专项类型必须为产品列表");
  if (mode.inputMode !== "文字描述" || !matchesGenerationMode(generationModes, mode.generationMode)) {
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

export function validateArticleListSettingsRegression(mode, generationModes = DEFAULT_GENERATION_MODES) {
  if (!mode?.enabled) return mode;
  for (const key of ["type", "inputMode", "generationMode", "pageNamePrefix", "pagePathPrefix", "prompt", "articleSortLabel"]) {
    if (typeof mode[key] !== "string" || !mode[key].trim()) throw new Error(`articleListSettingsRegression.${key} 不能为空`);
  }
  if (mode.type !== "文章列表") throw new Error("文章列表设置专项类型必须为文章列表");
  if (mode.inputMode !== "文字描述" || !matchesGenerationMode(generationModes, mode.generationMode)) throw new Error("文章列表设置专项目前只支持文字描述和快速模式");
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

export function validateNavigationRegression(mode, generationModes = DEFAULT_GENERATION_MODES) {
  if (!mode?.enabled) return mode;
  for (const key of ["type", "inputMode", "generationMode", "pageName", "pagePath", "prompt"]) {
    if (typeof mode[key] !== "string" || !mode[key].trim()) {
      throw new Error(`navigationRegression.${key} 不能为空`);
    }
  }
  if (mode.type !== "导航") throw new Error("导航专项类型必须为导航");
  if (mode.pageName !== "AI区块类型回归-005") throw new Error("导航专项页面名称必须为 AI区块类型回归-005");
  if (mode.pagePath !== "/ai-block-type-regression-005") throw new Error("导航专项页面路径必须为 /ai-block-type-regression-005");
  if (mode.inputMode !== "文字描述" || !matchesGenerationMode(generationModes, mode.generationMode)) {
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

export function validateImageGalleryRegression(mode, generationModes = DEFAULT_GENERATION_MODES) {
  if (!mode?.enabled) return mode;
  for (const key of ["type", "inputMode", "generationMode", "pageNamePrefix", "pagePathPrefix", "prompt"]) {
    if (typeof mode[key] !== "string" || !mode[key].trim()) {
      throw new Error(`imageGalleryRegression.${key} 不能为空`);
    }
  }
  if (mode.type !== "图片集") throw new Error("图片集专项类型必须为图片集，不能映射到图册列表");
  if (mode.inputMode !== "文字描述" || !matchesGenerationMode(generationModes, mode.generationMode)) {
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

export function validateCompositeRegression(mode, generationModes = DEFAULT_GENERATION_MODES) {
  if (!mode?.enabled) return mode;
  for (const key of ["type", "staticType", "inputMode", "generationMode", "pageNamePrefix", "pagePathPrefix", "prompt"]) {
    if (typeof mode[key] !== "string" || !mode[key].trim()) throw new Error(`compositeRegression.${key} 不能为空`);
  }
  if (mode.type !== "复合区块") throw new Error("复合区块专项类型必须为复合区块");
  if (mode.staticType !== "静态图文") throw new Error("复合区块专项静态布局必须为静态图文");
  if (mode.inputMode !== "文字描述" || !generationModes.some(item => item.label === mode.generationMode || item.aliases?.includes(mode.generationMode))) {
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
