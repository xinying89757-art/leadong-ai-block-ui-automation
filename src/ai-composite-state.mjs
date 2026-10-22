import path from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { assertAiStateCompatible } from "./ai-state.mjs";
import { aiPageDescriptor } from "./config.mjs";

export function compositePaths(config, runId) {
  const root = path.join(config.paths.aiLifecycleDir, "runs", runId, "ai-composite");
  return { root, state: path.join(root, "state.json"), active: path.join(config.paths.aiLifecycleDir, "composite-active.json") };
}

export function newCompositeRunId(now = new Date()) {
  return `composite-${now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
}

export function compositeScopedConfig(config, runId, stateFile) {
  const mode = config.ai.compositeRegression;
  return {
    ...config,
    ai: {
      ...config.ai,
      runId,
      isolatedPages: true,
      types: [mode.type],
      blocksPerPage: 1,
      pageNamePrefix: mode.pageNamePrefix,
      pagePathPrefix: mode.pagePathPrefix,
      inputMode: mode.inputMode,
      generationMode: mode.generationMode,
      promptPolishEnabled: mode.promptPolishEnabled,
      generationTimeoutMs: mode.generationTimeoutMs,
      generationStatusRefreshIntervalMs: mode.generationStatusRefreshIntervalMs,
      applyIntervalMs: mode.applyIntervalMs,
      publishInitialWaitMs: mode.publishInitialWaitMs,
      publishPollIntervalMs: mode.publishPollIntervalMs,
      publishTimeoutMs: mode.publishTimeoutMs,
      followupPages: [],
      prompts: { ...config.ai.prompts, [mode.type]: mode.prompt },
    },
    paths: { ...config.paths, aiStateFile: stateFile },
  };
}

export function assertCompositeState(state, config, runId) {
  const scoped = compositeScopedConfig(config, runId, "");
  if (state?.mode !== "ai" || state.run_id !== runId) throw new Error("复合区块专项状态与运行 ID 不匹配");
  if (state.site_name !== config.siteName || state.site_language !== config.siteLanguage) throw new Error("复合区块专项状态与站点或语言不匹配");
  const expected = aiPageDescriptor(scoped, 1);
  if (state.page?.name !== expected.name || state.page?.path !== expected.path || state.page?.publicUrl !== expected.publicUrl) {
    throw new Error("复合区块专项状态中的测试页面与当前配置不匹配");
  }
  if (!Array.isArray(state.types) || state.types.length !== 1 || state.types[0].type !== config.ai.compositeRegression.type) {
    throw new Error("复合区块专项状态必须且只能包含一个复合区块记录");
  }
  assertAiStateCompatible(state, scoped);
  return state;
}

export async function readCompositeJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export async function writeCompositeJson(file, value) {
  value.updated_at = new Date().toISOString();
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

export function compositePassed(state, config) {
  const record = state?.types?.[0];
  const expected = config.ai.compositeRegression.dynamicTypes;
  const selected = record?.composite_selection?.selected_dynamic_types;
  const finalAttempt = record?.generation_attempts?.find(item => item.attempt === record.generation_attempt_number);
  return state?.page?.saved === true && state.page.editor_verified === true &&
    state.page.preview_verified === true && state.page.published_verified === true &&
    state.page.types?.length === 1 && state.page.types[0] === config.ai.compositeRegression.type &&
    record?.type_menu_evidence?.match_count === 1 && record.type_menu_evidence.status === "matched" &&
    record?.generation_status === "succeeded" && record.apply_status === "applied" &&
    finalAttempt?.status === "succeeded" && finalAttempt.generation_mode === config.ai.compositeRegression.generationMode &&
    Boolean(record.committed_block_id) && record.composite_selection?.static_layout === config.ai.compositeRegression.staticType &&
    record.composite_selection?.combination_enabled === true && record.composite_selection?.max_dynamic_types === 3 &&
    Array.isArray(selected) && selected.length === expected.length && expected.every((type, index) => selected[index] === type) &&
    record.composite_editor_evidence?.passed === true && !state.page.type_failures?.length;
}

export function compositeResumeAction(state, config) {
  if (compositePassed(state, config)) return "complete";
  const record = state?.types?.[0];
  if (!record) throw new Error("复合区块专项状态缺少唯一生成记录，拒绝恢复");
  if (record.application_attempted && record.apply_status !== "applied") throw new Error("复合区块应用状态不确定，需人工检查后再恢复");
  if (record.generation_status === "uncertain" && record.generation_submit_confirmed === true &&
      record.apply_status !== "applied" && !record.application_attempted && !record.application_commit_confirmed && !record.committed_block_id) {
    return "resume-existing-record";
  }
  const lastAttempt = record.generation_attempts?.at(-1);
  if (record.generation_status === "failed" && lastAttempt?.explicit_platform_failure === true &&
      Number(record.generation_attempt_number || 1) < config.ai.compositeRegression.maxGenerationAttempts &&
      record.apply_status !== "applied" && !record.application_attempted && !record.application_commit_confirmed && !record.committed_block_id) {
    return "retry-explicit-failure";
  }
  if (["running", "uncertain", "succeeded"].includes(record.generation_status) && record.apply_status !== "applied") {
    throw new Error("复合区块生成已提交但应用未确认，请先从生成记录核对，不能自动重复生成");
  }
  if (record.apply_status === "applied" && state.page?.types?.includes(config.ai.compositeRegression.type)) return "finish-page-checkpoints";
  const submitted = record.generation_submit_confirmed === true || Boolean(record.generation_submitted_at || record.generation_record_id);
  if (submitted && record.apply_status !== "applied") throw new Error("复合区块生成已提交但尚未完成应用，禁止自动重复生成");
  if (record.generation_status === "pending" && record.apply_status === "pending" && !record.application_attempted) return "generate";
  if (!submitted && !record.application_attempted && !record.application_commit_confirmed && record.generation_status === "failed") return "retry-before-submit";
  throw new Error("复合区块专项状态不确定，拒绝自动重复生成或扣点");
}

export function summarizeCompositeState(state, paths) {
  const record = state.types?.[0];
  return {
    runId: state.run_id,
    stateFile: paths.state,
    page: state.page,
    record: record ? {
      type: record.type,
      selectedComponents: record.composite_selection ?? null,
      generation: record.generation_status,
      generationRecordId: record.generation_record_id || "",
      generationAttempt: record.generation_attempt_number || 1,
      generationAttempts: record.generation_attempts || [],
      generationMode: record.generation_attempts?.find(item => item.attempt === (record.generation_attempt_number || 1))?.generation_mode || "",
      application: record.apply_status,
      applicationSource: record.application_source || "",
      blockId: record.committed_block_id || "",
      editorEvidence: record.composite_editor_evidence ?? null,
      previewVerified: record.preview_verified,
      publishedVerified: record.published_verified,
      polish: record.polish_status,
      failureReason: record.failure_reason,
      failureScreenshot: record.failure_screenshot || "",
    } : null,
  };
}
