import path from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

export function fullPagePaths(config, runId) {
  const root = path.join(config.paths.aiLifecycleDir, "runs", runId, "ai-full-page");
  return {
    root,
    state: path.join(root, "state.json"),
    active: path.join(config.paths.aiLifecycleDir, "full-page-active.json"),
  };
}

export function newFullPageRunId(now = new Date()) {
  return `full-page-${now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
}

export function fullPageDescriptor(config, runId) {
  const mode = config.ai.fullPageRegression;
  const suffix = runId.replace(/[^a-zA-Z0-9_-]/g, "-");
  const pagePath = `/${mode.pagePathPrefix}${suffix}`;
  return {
    name: `${mode.pageNamePrefix}${suffix}`,
    path: pagePath,
    publicUrl: new URL(pagePath, config.publicBaseUrl).toString(),
    heading: `AI Full Page Regression ${suffix}`,
  };
}

export function fullPagePrompt(descriptor, sections) {
  return `Create an English solar company homepage with products, benefits, stories and contact. Title: ${descriptor.heading}.`;
}

export function createFullPageState(config, runId, retry = null) {
  const descriptor = fullPageDescriptor(config, runId);
  const now = new Date().toISOString();
  return {
    version: 1,
    mode: "ai-full-page",
    run_id: runId,
    site_name: config.siteName,
    site_language: config.siteLanguage,
    created_at: now,
    updated_at: now,
    page: {
      ...descriptor,
      target_identity: null,
      create_status: "pending",
      saved: false,
      editor_verified: false,
      preview_verified: false,
      published_verified: false,
      prompt_fidelity_passed: null,
      content_warning: "",
      publish_status: "pending",
      cleanup_status: "pending",
      failure_reason: "",
    },
    generation: {
      input_mode: "文字描述",
      generation_mode: "快速模式",
      original_prompt: fullPagePrompt(descriptor, config.ai.fullPageRegression.sections),
      generation_status: "pending",
      application_status: "pending",
      history_marker: descriptor.heading,
      active_prompt: fullPagePrompt(descriptor, config.ai.fullPageRegression.sections),
      record_retry_count: 0,
      history_id: "",
      status_refresh_interval_ms: config.ai.fullPageRegression.generationStatusRefreshIntervalMs ?? 30000,
      max_status_refreshes: config.ai.fullPageRegression.maxGenerationRefreshes ?? 40,
      status_refresh_count: 0,
      last_observed_status: "",
      last_status_refresh_at: "",
      started_at: "",
      generated_at: "",
      applied_at: "",
      failure_reason: "",
    },
    retry: retry ? {
      attempt: retry.attempt,
      previous_run_id: retry.previousRunId,
      reason: retry.reason,
      created_at: now,
    } : null,
  };
}

export function shouldAutoRetryFailed(state, config, attempt = 0) {
  const mode = config.ai.fullPageRegression;
  const max = Number.isInteger(mode.maxGenerationRetries) ? mode.maxGenerationRetries : 0;
  return mode.autoRetryFailed === true &&
    attempt < max &&
    state?.generation?.generation_status === "failed" &&
    state?.generation?.application_status === "pending" &&
    state?.page?.create_status === "pending" &&
    state?.page?.published_verified !== true;
}

export function assertFullPageState(state, config, runId) {
  if (state?.mode !== "ai-full-page" || state.run_id !== runId) throw new Error("整页状态与运行 ID 不匹配");
  if (state.site_name !== config.siteName || state.site_language !== config.siteLanguage) throw new Error("整页状态与站点或语言不匹配");
  const expected = fullPageDescriptor(config, runId);
  for (const key of ["name", "path", "publicUrl", "heading"]) {
    if (state.page[key] !== expected[key]) throw new Error(`整页状态中的 ${key} 与配置不匹配`);
  }
  if (typeof state.generation.original_prompt !== "string" ||
      !state.generation.original_prompt.includes(expected.heading)) {
    throw new Error("整页状态中的提示词缺少本轮唯一标题");
  }
}

export function fullPageResumeAction(state, pageExists) {
  if (state.page.cleanup_status === "completed") return "done";
  if (pageExists) {
    if (state.generation.application_status === "pending" && state.generation.generation_status === "pending") {
      throw new Error("同名测试页已存在，但本轮没有生成记录；拒绝覆盖或重复生成");
    }
    return "verify-page";
  }
  if (state.generation.application_status === "applied" || state.page.create_status === "created") {
    throw new Error("状态显示整页已应用，但测试页不存在；拒绝重新生成");
  }
  return state.generation.generation_status === "pending" ? "generate" : "recover-history";
}

export async function readFullPageJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export async function writeFullPageJson(file, value) {
  value.updated_at = new Date().toISOString();
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}
