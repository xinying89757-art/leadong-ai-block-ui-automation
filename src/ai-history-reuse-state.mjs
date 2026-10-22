import path from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

export function historyReusePaths(config, runId) {
  const root = path.join(config.paths.aiLifecycleDir, "runs", runId, "ai-history-reuse");
  return {
    root,
    state: path.join(root, "state.json"),
    active: path.join(config.paths.aiLifecycleDir, "history-reuse-active.json"),
  };
}

export function newHistoryReuseRunId(now = new Date()) {
  return `history-reuse-${now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
}

function safeSuffix(runId) {
  return String(runId).replace(/[^a-zA-Z0-9_-]/g, "-");
}

export function historyReuseDescriptors(config, runId) {
  const mode = config.ai.historyReuseRegression;
  const suffix = safeSuffix(runId);
  const fullPath = `/${mode.fullPagePathPrefix}${suffix}`;
  const blockPath = `/${mode.blockPagePathPrefix}${suffix}`;
  return {
    fullPage: {
      name: `${mode.fullPageNamePrefix}${suffix}`,
      path: fullPath,
      publicUrl: new URL(fullPath, config.publicBaseUrl).toString(),
      marker: `AI History Full Page ${suffix}`,
    },
    block: {
      name: `${mode.blockPageNamePrefix}${suffix}`,
      path: blockPath,
      publicUrl: new URL(blockPath, config.publicBaseUrl).toString(),
      marker: `AI History Static Block ${suffix}`,
    },
  };
}

function pageState(descriptor) {
  return {
    ...descriptor,
    create_status: "pending",
    saved: false,
    editor_verified: false,
    preview_verified: false,
    published_verified: false,
    publish_status: "pending",
    cleanup_status: "pending",
    failure_reason: "",
  };
}

function historyState() {
  return {
    baseline_count: null,
    record_id: "",
    match_status: "pending",
    reopened: false,
    reopen_count: 0,
    application_source: "",
    matched_at: "",
    failure_reason: "",
  };
}

export function createHistoryReuseState(config, runId) {
  const mode = config.ai.historyReuseRegression;
  const descriptors = historyReuseDescriptors(config, runId);
  const now = new Date().toISOString();
  const fullPrompt = `Create an English solar company landing page with products, benefits, customer stories and contact content. Regression marker: ${descriptors.fullPage.marker}.`;
  const blockPrompt = `Create an English static image-and-text block for a solar energy company. Use the exact heading "${descriptors.block.marker}". Include an image area, a short description and a Learn More call-to-action.`;
  return {
    version: 1,
    mode: "ai-history-reuse",
    run_id: runId,
    site_name: config.siteName,
    site_language: config.siteLanguage,
    created_at: now,
    updated_at: now,
    full_page: {
      page: pageState(descriptors.fullPage),
      generation: {
        input_mode: mode.inputMode,
        generation_mode: mode.generationMode,
        original_prompt: fullPrompt,
        active_prompt: fullPrompt,
        generation_status: "pending",
        application_status: "pending",
        history_marker: descriptors.fullPage.marker,
        history_id: "",
        record_retry_count: 0,
        status_refresh_interval_ms: mode.generationStatusRefreshIntervalMs,
        max_status_refreshes: mode.maxGenerationRefreshes,
        status_refresh_count: 0,
        last_observed_status: "",
        last_status_refresh_at: "",
        started_at: "",
        generated_at: "",
        applied_at: "",
        failure_reason: "",
      },
      history: historyState(),
    },
    block: {
      type: mode.blockType,
      page: pageState(descriptors.block),
      generation: {
        input_mode: mode.inputMode,
        generation_mode: mode.generationMode,
        prompt: blockPrompt,
        marker: descriptors.block.marker,
        generation_status: "pending",
        application_status: "pending",
        started_at: "",
        generated_at: "",
        applied_at: "",
        failure_reason: "",
      },
      history: historyState(),
      block_count_before: null,
      block_count_after: null,
      editor_evidence: null,
      preview_evidence: null,
      public_evidence: null,
    },
  };
}

export function assertHistoryReuseState(state, config, runId) {
  if (state?.mode !== "ai-history-reuse" || state.run_id !== runId) {
    throw new Error("生成记录复用状态与运行 ID 不匹配");
  }
  if (state.site_name !== config.siteName || state.site_language !== config.siteLanguage) {
    throw new Error("生成记录复用状态与站点或语言不匹配");
  }
  const expected = historyReuseDescriptors(config, runId);
  for (const [section, descriptor] of [[state.full_page, expected.fullPage], [state.block, expected.block]]) {
    for (const key of ["name", "path", "publicUrl", "marker"]) {
      if (section?.page?.[key] !== descriptor[key]) {
        throw new Error(`生成记录复用状态中的 ${key} 与配置不匹配`);
      }
    }
  }
  if (state.block.type !== config.ai.historyReuseRegression.blockType) {
    throw new Error("生成记录复用状态中的区块类型与配置不匹配");
  }
  if (!state.full_page.generation.original_prompt.includes(expected.fullPage.marker) ||
      !state.block.generation.prompt.includes(expected.block.marker)) {
    throw new Error("生成记录复用状态缺少本轮唯一标记");
  }
}

export function historyReuseResumeAction(section, pageExists, { pageCreatedBeforeGeneration = false } = {}) {
  if (section.page.cleanup_status === "completed") return "done";
  const generation = section.generation;
  if (generation.application_status === "applied") {
    if (!pageExists) throw new Error("状态显示已从生成记录添加，但测试页面不存在；拒绝重复添加");
    assertHistoryApplicationSource(section);
    return "verify";
  }
  if (generation.application_status !== "pending") {
    throw new Error(`从生成记录添加的状态为 ${generation.application_status}，结果可能已到达页面；请人工检查`);
  }
  if (pageExists && !pageCreatedBeforeGeneration) {
    throw new Error("目标页面已存在，但状态未确认从生成记录添加；拒绝覆盖");
  }
  if (generation.generation_status === "pending") return "generate";
  if (["running", "uncertain", "succeeded"].includes(generation.generation_status)) return "recover-history";
  throw new Error(`生成记录状态为 ${generation.generation_status}，拒绝自动重新生成`);
}

export function markHistoryMatched(section, recordId = "") {
  section.history.record_id = String(recordId ?? "");
  section.history.match_status = "succeeded";
  section.history.reopened = true;
  section.history.reopen_count = (section.history.reopen_count ?? 0) + 1;
  section.history.matched_at = new Date().toISOString();
  section.history.failure_reason = "";
}

export function markHistoryApplied(section) {
  if (!section.history.reopened || section.history.match_status !== "succeeded") {
    throw new Error("生成记录尚未重新打开并唯一匹配，拒绝标记应用成功");
  }
  section.history.application_source = "history";
  section.generation.application_status = "applied";
  section.generation.applied_at = new Date().toISOString();
}

export function assertHistoryApplicationSource(section) {
  if (section.generation.application_status === "applied" &&
      (section.history.application_source !== "history" || !section.history.reopened)) {
    throw new Error("应用结果不是来自重新打开的生成记录");
  }
  return true;
}

export function assertBlockCountDelta(before, after) {
  if (!Number.isInteger(before) || !Number.isInteger(after) || after !== before + 1) {
    throw new Error(`从生成记录添加区块后的数量变化无效：${before} → ${after}，预期增加 1`);
  }
  return true;
}

export async function readHistoryReuseJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export async function writeHistoryReuseJson(file, value) {
  value.updated_at = new Date().toISOString();
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}
