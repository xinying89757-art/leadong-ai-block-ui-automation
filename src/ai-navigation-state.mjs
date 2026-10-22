import path from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

export function navigationPaths(config, runId) {
  const root = path.join(config.paths.aiLifecycleDir, "runs", runId, "ai-navigation");
  return {
    root,
    state: path.join(root, "state.json"),
    active: path.join(config.paths.aiLifecycleDir, "navigation-active.json"),
  };
}

export function newNavigationRunId(now = new Date()) {
  return `navigation-${now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
}

export function navigationDescriptor(config) {
  const mode = config.ai.navigationRegression;
  return {
    number: 5,
    name: mode.pageName,
    path: mode.pagePath,
    publicUrl: new URL(mode.pagePath, config.publicBaseUrl).toString(),
  };
}

function emptyNavigationSettings() {
  return {
    selection_status: "pending",
    toolbar_status: "pending",
    panel_status: "pending",
    edit_navigation_status: "pending",
    selected_pages: [],
    selected_count: 0,
    add_status: "pending",
    save_status: "pending",
    applied_at: "",
    failure_reason: "",
  };
}

export function createNavigationState(config, runId) {
  const mode = config.ai.navigationRegression;
  const now = new Date().toISOString();
  return {
    version: 1,
    mode: "ai-navigation",
    run_id: runId,
    site_name: config.siteName,
    site_language: config.siteLanguage,
    created_at: now,
    updated_at: now,
    page: {
      ...navigationDescriptor(config),
      types: [],
      saved: false,
      editor_verified: false,
      preview_verified: false,
      published_verified: false,
      publish_status: "pending",
      public_navigation_verified: false,
      public_link_results: [],
      cleanup_status: "pending",
      failure_reason: "",
    },
    types: [{
      index: 0,
      type: mode.type,
      prompt: mode.prompt,
      original_prompt: mode.prompt,
      polished_prompt: "",
      polish_status: "pending",
      polished_at: "",
      polish_failure_reason: "",
      generation_status: "pending",
      apply_status: "pending",
      editor_verified: false,
      preview_verified: false,
      published_verified: false,
      failure_reason: "",
      recovery_required: false,
      started_at: "",
      generated_at: "",
      applied_at: "",
      navigation_settings: emptyNavigationSettings(),
    }],
  };
}

export function assertNavigationState(state, config, runId) {
  const expected = navigationDescriptor(config);
  if (state?.mode !== "ai-navigation" || state.run_id !== runId) {
    throw new Error("导航状态与运行 ID 不匹配");
  }
  if (state.site_name !== config.siteName || state.site_language !== config.siteLanguage) {
    throw new Error("导航状态与站点或语言不匹配");
  }
  for (const key of ["name", "path", "publicUrl"]) {
    if (state.page?.[key] !== expected[key]) throw new Error(`导航状态中的 ${key} 与配置不匹配`);
  }
  if (!Array.isArray(state.types) || state.types.length !== 1 || state.types[0].type !== config.ai.navigationRegression.type) {
    throw new Error("导航状态必须只包含一个导航类型");
  }
  state.types[0].navigation_settings ??= emptyNavigationSettings();
  return state;
}

export function navigationResumeAction(state, pageExists) {
  const record = state.types[0];
  if (state.page.cleanup_status === "completed") return "done";
  const knownPreApplyFailure = record.recovery_required
    && record.generation_status === "succeeded"
    && record.apply_status === "pending"
    && /导航.*(?:等待超时|not visible|未找到)/i.test(record.navigation_settings?.failure_reason ?? "");
  const appliedNeedsNavigation = record.apply_status === "applied"
    && record.navigation_settings?.save_status !== "succeeded";
  const appliedNeedsPageSave = record.apply_status === "applied"
    && record.navigation_settings?.save_status === "succeeded"
    && !state.page.saved;
  const appliedCanVerifyPublic = record.apply_status === "applied"
    && record.navigation_settings?.save_status === "succeeded"
    && record.editor_verified && state.page.saved;
  if ((record.recovery_required && !knownPreApplyFailure && !appliedNeedsNavigation && !appliedNeedsPageSave && !appliedCanVerifyPublic) || ["running", "applying"].includes(record.apply_status)) {
    throw new Error("导航生成或设置应用状态不确定，请人工检查后再恢复");
  }
  if (pageExists) {
    if (record.apply_status === "pending" && record.generation_status === "pending") {
      throw new Error("导航测试页已存在但状态为空，拒绝覆盖或重复生成");
    }
    if (record.apply_status === "applied") {
      return record.navigation_settings?.save_status === "succeeded"
        ? "verify-page"
        : "configure-applied-block";
    }
    if (record.generation_status === "succeeded") return "recover-generated-result";
    return "recover-generation";
  }
  if (record.apply_status === "applied" || state.page.saved || state.page.published_verified) {
    throw new Error("状态显示导航已应用但测试页不存在，拒绝重新生成");
  }
  return record.generation_status === "pending" ? "generate" : "recover-generation";
}

export async function readNavigationJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export async function writeNavigationJson(file, value) {
  value.updated_at = new Date().toISOString();
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}
