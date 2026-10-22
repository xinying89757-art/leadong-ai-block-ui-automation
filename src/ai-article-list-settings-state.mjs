import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInitialAiState } from "./ai-state.mjs";

export function articleListSettingsPaths(config, runId) {
  const root = path.join(config.paths.aiLifecycleDir, "runs", runId, "ai-article-list-settings");
  return { root, state: path.join(root, "state.json"), active: path.join(config.paths.aiLifecycleDir, "article-list-settings-active.json") };
}

export function newArticleListSettingsRunId(now = new Date()) {
  return `article-list-settings-${now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
}

export function articleListSettingsDescriptor(config, runId) {
  const mode = config.ai.articleListSettingsRegression;
  const suffix = String(runId).replace(/[^a-zA-Z0-9_-]+/g, "-");
  const pagePath = `/${mode.pagePathPrefix}${suffix}`;
  return {
    number: 0,
    name: `${mode.pageNamePrefix}${suffix}`,
    path: pagePath,
    publicUrl: new URL(pagePath, config.publicBaseUrl).toString(),
  };
}

export async function readArticleListSettingsJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export async function writeArticleListSettingsJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ ...value, updated_at: new Date().toISOString() }, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

export function createArticleListSettingsState(config, runId) {
  const mode = config.ai.articleListSettingsRegression;
  const scopedConfig = {
    ...config,
    ai: {
      ...config.ai,
      runId,
      types: [mode.type],
      prompts: { ...config.ai.prompts, [mode.type]: mode.prompt },
      pageNamePrefix: mode.pageNamePrefix,
      pagePathPrefix: mode.pagePathPrefix,
    },
  };
  const state = createInitialAiState(scopedConfig, articleListSettingsDescriptor(config, runId));
  state.mode = "ai-article-list-settings";
  state.version = 1;
  state.type = state.types[0];
  const marker = `AI Article List Settings ${runId}`;
  state.type.original_prompt = `${mode.prompt} Include regression marker "${marker}".`;
  state.type.prompt = state.type.original_prompt;
  state.type.history_marker = marker;
  state.type.generation_record_id = "";
  state.type.settings_status = "pending";
  state.type.settings_opened = false;
  state.type.settings_saved = false;
  state.type.settings_reopened = false;
  state.type.settings = [
    ["article_scope", "选择文章"], ["sort", "文章排序"], ["loading", "加载方式"],
    ["page_size", "每页展示数量"], ["display_content", "展示内容"], ["base_color", "基础配色"],
  ].map(([key, label]) => ({ key, label, status: "pending", before: null, selected: null, after: null, reopened: null, effect_status: "pending", effect_before: null, effect_after: null, effect_reopened: null, failure_reason: "" }));
  state.type.catalog = { source: "site-content-management", status: "pending", articles: [], categories: [], captured_at: "", failure_reason: "" };
  state.type.result_checks = Object.fromEntries([
    "article_scope", "sort", "loading_pagination", "page_size", "display_field", "base_color", "after_reopen", "preview", "published",
  ].map((key) => [key, { status: "pending", evidence: null }]));
  state.type.settings_failure_reason = "";
  state.page.saved = false;
  state.page.preview_verified = false;
  state.page.published_verified = false;
  return state;
}

export function assertArticleListSettingsState(state, config, runId) {
  const expected = articleListSettingsDescriptor(config, runId);
  if (state?.mode !== "ai-article-list-settings" || state.run_id !== runId) throw new Error("文章列表设置状态与运行 ID 不匹配");
  if (state.site_name !== config.siteName || state.site_language !== config.siteLanguage) throw new Error("文章列表设置状态与站点或语言不匹配");
  for (const key of ["name", "path", "publicUrl"]) if (state.page?.[key] !== expected[key]) throw new Error(`文章列表设置状态中的 ${key} 与当前运行不匹配`);
  if (state.types?.length !== 1 || state.type?.type !== config.ai.articleListSettingsRegression.type) throw new Error("文章列表设置状态类型不匹配");
  state.type.settings ??= createArticleListSettingsState(config, runId).type.settings;
  state.type.result_checks ??= {};
  for (const key of ["article_scope", "sort", "loading_pagination", "page_size", "display_field", "base_color", "after_reopen", "preview", "published"]) state.type.result_checks[key] ??= { status: "pending", evidence: null };
  state.type.catalog ??= { source: "site-content-management", status: "pending", articles: [], categories: [], captured_at: "", failure_reason: "" };
  state.page.types ??= [];
  return state;
}

export function articleListResumeAction(state, pageExists) {
  if (!pageExists) {
    if (state.type.generation_status !== "pending" || state.type.application_attempted) throw new Error("测试页不存在但已有生成或应用状态，拒绝重复生成");
    return "create-page";
  }
  if (state.type.application_attempted && state.type.apply_status !== "applied" && state.type.application_commit_confirmed !== true) throw new Error("文章列表应用状态不确定，请人工检查后恢复");
  if (state.type.settings_status === "running") {
    const touched = (state.type.settings ?? []).some((item) => item.status !== "pending" || item.selected !== null || item.after !== null);
    if (touched) throw new Error("文章列表设置状态不确定，请人工检查侧栏和预览后恢复");
    state.type.settings_status = "failed";
    state.type.settings_failure_reason = "上一进程在进入设置交互前中断；六项设置均无修改记录，可安全从现有区块重试";
  }
  if (state.type.apply_status === "applied") return "continue-settings";
  if (state.type.generation_status === "succeeded") return "recover-generated-result";
  return "continue";
}
