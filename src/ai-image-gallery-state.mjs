import path from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { assertAiStateCompatible } from "./ai-state.mjs";
import { aiPageDescriptor } from "./config.mjs";

export function imageGalleryPaths(config, runId) {
  const root = path.join(config.paths.aiLifecycleDir, "runs", runId, "ai-image-gallery");
  return { root, state: path.join(root, "state.json"), active: path.join(config.paths.aiLifecycleDir, "image-gallery-active.json") };
}

export function newImageGalleryRunId(now = new Date()) {
  return `image-gallery-${now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
}

export function imageGalleryScopedConfig(config, runId, stateFile) {
  const mode = config.ai.imageGalleryRegression;
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
      exactCategoryMenuTypes: [mode.type],
      followupPages: [],
      prompts: { ...config.ai.prompts, [mode.type]: mode.prompt },
    },
    paths: { ...config.paths, aiStateFile: stateFile },
  };
}

export function assertImageGalleryState(state, config, runId) {
  const scoped = imageGalleryScopedConfig(config, runId, "");
  if (state?.mode !== "ai" || state.run_id !== runId) throw new Error("图片集专项状态与运行 ID 不匹配");
  if (state.site_name !== config.siteName || state.site_language !== config.siteLanguage) throw new Error("图片集专项状态与站点或语言不匹配");
  const expected = aiPageDescriptor(scoped, 1);
  if (state.page?.name !== expected.name || state.page?.path !== expected.path || state.page?.publicUrl !== expected.publicUrl) {
    throw new Error("图片集专项状态中的测试页面与当前配置不匹配");
  }
  if (!Array.isArray(state.types) || state.types.length !== 1 || state.types[0].type !== "图片集") {
    throw new Error("图片集专项状态必须且只能包含 AI 类型“图片集”");
  }
  assertAiStateCompatible(state, scoped);
  return state;
}

export async function readImageGalleryJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export async function writeImageGalleryJson(file, value) {
  value.updated_at = new Date().toISOString();
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

export function summarizeImageGalleryState(state, paths) {
  const record = state.types?.[0];
  return {
    runId: state.run_id,
    stateFile: paths.state,
    page: state.page,
    record: record ? {
      type: record.type,
      typeMenuEvidence: record.type_menu_evidence ?? null,
      generation: record.generation_status,
      generationRecordId: record.generation_record_id || "",
      application: record.apply_status,
      applicationSource: record.application_source || "",
      blockId: record.committed_block_id || "",
      editorDisplayEvidence: record.image_gallery_editor_evidence ?? null,
      previewVerified: record.preview_verified,
      publishedVerified: record.published_verified,
      polish: record.polish_status,
      failureReason: record.failure_reason,
      failureScreenshot: record.failure_screenshot || "",
    } : null,
  };
}

export function imageGalleryPassed(state) {
  const record = state?.types?.[0];
  return state?.page?.saved === true && state.page.editor_verified === true &&
    state.page.preview_verified === true && state.page.published_verified === true &&
    state.page.types?.length === 1 && state.page.types[0] === "图片集" &&
    record?.type_menu_evidence?.match_count === 1 && record.generation_status === "succeeded" &&
    record.apply_status === "applied" && Boolean(record.committed_block_id) &&
    record.image_gallery_editor_evidence?.passed === true && !state.page.type_failures?.length;
}

export function imageGalleryResumeAction(state) {
  if (imageGalleryPassed(state)) return "complete";
  const record = state?.types?.[0];
  if (!record) throw new Error("图片集专项状态缺少唯一类型记录，拒绝恢复");
  if (record.application_attempted && record.apply_status !== "applied") {
    throw new Error("图片集区块应用状态不确定，需人工检查后再恢复");
  }
  if (["running", "uncertain", "succeeded"].includes(record.generation_status) && record.apply_status !== "applied") {
    throw new Error("图片集生成已提交但应用状态未确认，需从生成记录核查，不能自动重复生成");
  }
  if (record.apply_status === "applied" && state.page?.types?.includes("图片集")) return "finish-page-checkpoints";
  if (record.generation_status === "pending" && record.apply_status === "pending" && !record.application_attempted) return "generate";
  const submitted = record.generation_submit_confirmed === true || Boolean(record.generation_submitted_at || record.generation_record_id);
  if (!submitted && !record.application_attempted && !record.application_commit_confirmed &&
      ["failed", "pending"].includes(record.generation_status)) return "retry-before-submit";
  throw new Error("图片集专项处于失败或不完整状态，需人工检查后再恢复，防止重复生成");
}
