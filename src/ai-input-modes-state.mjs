import path from "node:path";
import { readFile, mkdir, writeFile, rename } from "node:fs/promises";

export function inputModePaths(config, runId) {
  const root = path.join(config.paths.aiLifecycleDir, "runs", runId, "ai-input-modes");
  return { root, state: path.join(root, "state.json"), active: path.join(config.paths.aiLifecycleDir, "input-modes-active.json") };
}

export function newInputModeRunId(now = new Date()) {
  return `input-modes-${now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
}

export function inputModePage(config, runId) {
  const mode = config.ai.inputModeRegression;
  const suffix = runId.replace(/[^a-zA-Z0-9_-]/g, "-");
  const pagePath = `/${mode.pagePathPrefix}${suffix}`;
  return { name: `${mode.pageNamePrefix}${suffix}`, path: pagePath, publicUrl: new URL(pagePath, config.publicBaseUrl).toString() };
}

export function inputModePrompt(item) {
  return `Create an English static image-and-text block for a solar energy company. Use the exact heading "${item.heading}". Include a clear English description, one image area, and a "Learn More" call-to-action. Keep the heading visible in the rendered block.`;
}

export function createInputModeState(config, runId) {
  const mode = config.ai.inputModeRegression;
  const now = new Date().toISOString();
  return {
    version: 1,
    mode: "ai-input-modes",
    run_id: runId,
    site_name: config.siteName,
    site_language: config.siteLanguage,
    created_at: now,
    updated_at: now,
    initial_points: null,
    page: { ...inputModePage(config, runId), saved: false, editor_verified: false, preview_verified: false, published_verified: false, publish_status: "pending", cleanup_status: "pending", failure_reason: "" },
    records: mode.inputModes.map((item) => ({
      input_mode: item.key,
      input_mode_label: item.label,
      type: mode.type,
      generation_mode: mode.generationMode,
      heading: item.heading,
      original_prompt: `[runId=${runId},input=${item.key}] ${inputModePrompt(item)}`,
      image_path: item.key === "image" ? mode.imagePath : "",
      reference_url: item.key === "url" ? mode.referenceUrl : "",
      input_status: "pending",
      input_failure_reason: "",
      points_source: "",
      expected_cost: mode.expectedCost,
      points_before: null,
      points_after: null,
      actual_cost: null,
      points_status: "pending",
      points_checked_at: "",
      points_failure_reason: "",
      generation_status: "pending",
      committed_block_id: '',
      application_commit_confirmed: false,
      application_baseline_ids: [],
      application_baseline_count: null,
      checkpoint_saved: false,
      reopen_verified: false,
      application_status: "pending",
      editor_verified: false,
      preview_verified: false,
      published_verified: false,
      started_at: "",
      generated_at: "",
      applied_at: "",
      failure_reason: "",
    })),
  };
}

export function assertInputModeState(state, config, runId) {
  const mode = config.ai.inputModeRegression;
  if (state.mode !== "ai-input-modes" || state.run_id !== runId) throw new Error("输入方式专项状态与运行 ID 不匹配");
  if (state.site_name !== config.siteName || state.site_language !== config.siteLanguage) throw new Error("输入方式专项状态与站点或语言不匹配");
  const page = inputModePage(config, runId);
  if (state.page.name !== page.name || state.page.path !== page.path || state.page.publicUrl !== page.publicUrl) throw new Error("输入方式专项测试页面与配置不匹配");
  if (state.records.length !== mode.inputModes.length || state.records.some((record, index) => record.input_mode !== mode.inputModes[index].key || record.heading !== mode.inputModes[index].heading || record.expected_cost !== mode.expectedCost)) {
    throw new Error("输入方式专项配置已变化，拒绝恢复");
  }
}

export function measuredInputCost(before, after) {
  if (!Number.isFinite(before) || !Number.isFinite(after)) throw new Error("点数余额不是有效数字");
  return Math.round((before - after) * 100) / 100;
}

export function finishInputPointsCheck(record, after) {
  record.points_after = after;
  record.actual_cost = measuredInputCost(record.points_before, after);
  record.points_status = record.actual_cost === record.expected_cost ? "passed" : "failed";
  record.points_checked_at = new Date().toISOString();
  record.points_failure_reason = record.points_status === "passed" ? "" : `预期扣除 ${record.expected_cost} 点，实际扣除 ${record.actual_cost} 点`;
  return record.points_status;
}

export function inputModeResumeSafety(state) {
  for (const record of state.records) {
    if (record.application_status === "applied") continue;
    if (record.generation_status !== "pending" || record.points_status !== "pending" || record.application_status !== "pending" || record.input_status !== "pending") {
      throw new Error(`${record.input_mode_label} 的输入、生成、扣点或应用状态不确定；请人工检查后再恢复`);
    }
  }
}

export async function readInputModeJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export async function writeInputModeJson(file, value) {
  value.updated_at = new Date().toISOString();
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}
