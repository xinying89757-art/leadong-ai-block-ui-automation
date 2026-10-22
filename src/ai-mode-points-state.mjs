import path from "node:path";
import { readFile, mkdir, writeFile, rename } from "node:fs/promises";

export function modePointsPaths(config, runId) {
  const root = path.join(config.paths.aiLifecycleDir, "runs", runId, "ai-mode-points");
  return { root, state: path.join(root, "state.json"), active: path.join(config.paths.aiLifecycleDir, "mode-points-active.json") };
}

export function newModePointsRunId(now = new Date()) {
  return `mode-points-${now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
}

export function modePointsPage(config, runId) {
  const mode = config.ai.modePointRegression;
  const suffix = runId.replace(/[^a-zA-Z0-9_-]/g, "-");
  const name = `${mode.pageNamePrefix}${suffix}`;
  const pagePath = `/${mode.pagePathPrefix}${suffix}`;
  return { name, path: pagePath, publicUrl: new URL(pagePath, config.publicBaseUrl).toString() };
}

export function modePrompt(mode) {
  return `Create an English static image-and-text block for a solar energy company. Use the exact heading "${mode.heading}". Include one solar product image area, a short English description, and a "Learn More" call-to-action. Keep this heading visible in the rendered block.`;
}

export function createModePointsState(config, runId) {
  const now = new Date().toISOString();
  return {
    version: 1,
    mode: "ai-mode-points",
    run_id: runId,
    site_name: config.siteName,
    site_language: config.siteLanguage,
    created_at: now,
    updated_at: now,
    initial_points: null,
    page: { ...modePointsPage(config, runId), saved: false, editor_verified: false, preview_verified: false, published_verified: false, publish_status: "pending", cleanup_status: "pending", failure_reason: "" },
    records: config.ai.modePointRegression.modes.map((item) => ({
      mode: item.key,
      mode_label: item.label,
      type: config.ai.modePointRegression.type,
      heading: item.heading,
      original_prompt: `[runId=${runId},mode=${item.key}] ${modePrompt(item)}`,
      expected_cost: item.expectedCost,
      points_source: "",
      points_before: null,
      points_after: null,
      actual_cost: null,
      points_status: "pending",
      points_checked_at: "",
      points_failure_reason: "",
      application_baseline_ids: [],
      application_baseline_count: null,
      committed_block_id: "",
      application_commit_confirmed: false,
      checkpoint_saved: false,
      reopen_verified: false,
      generation_status: "pending",
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

export function assertModePointsState(state, config, runId) {
  if (state.mode !== "ai-mode-points" || state.run_id !== runId) throw new Error("点数专项状态与运行 ID 不匹配");
  if (state.site_name !== config.siteName || state.site_language !== config.siteLanguage) throw new Error("点数专项状态与站点或语言不匹配");
  const page = modePointsPage(config, runId);
  if (state.page.name !== page.name || state.page.path !== page.path || state.page.publicUrl !== page.publicUrl) throw new Error("点数专项测试页面与配置不匹配");
  const modes = config.ai.modePointRegression.modes;
  if (state.records.length !== modes.length || state.records.some((record, index) => record.mode !== modes[index].key || record.expected_cost !== modes[index].expectedCost || record.heading !== modes[index].heading)) throw new Error("点数专项模式配置已变化，拒绝恢复");
}

export function measuredCost(before, after) {
  if (!Number.isFinite(before) || !Number.isFinite(after)) throw new Error("点数余额不是有效数字");
  return Math.round((before - after) * 100) / 100;
}

export function finishPointsCheck(record, after) {
  record.points_after = after;
  record.actual_cost = measuredCost(record.points_before, after);
  record.points_status = record.actual_cost === record.expected_cost ? "passed" : "failed";
  record.points_checked_at = new Date().toISOString();
  record.points_failure_reason = record.points_status === "passed" ? "" : `预期扣除 ${record.expected_cost} 点，实际扣除 ${record.actual_cost} 点`;
  return record.points_status;
}

export function resumeSafety(state) {
  for (const record of state.records) {
    modeResumeAction(record);
  }
}

export function modeResumeAction(record) {
  if (record.application_status === "applied") return "done";
  if (record.generation_status === "failed" && record.application_status === "failed" &&
      record.refund_confirmed === true && record.actual_cost === 0 &&
      Number.isFinite(record.points_before) && record.points_after === record.points_before) return "skip-failed";
  if (record.application_status === "pending" && record.generation_status === "pending" && record.points_status === "pending") return "generate";
  // A recorded submission + original balance permits read-only history
  // recovery, not a second generation. Legacy timeout states are included.
  const timedOut = record.generation_status === "failed" && /生成结果.*等待超时/.test(record.failure_reason || "");
  if (record.application_status === "pending" && record.started_at && Number.isFinite(record.points_before) &&
      (["running", "uncertain", "succeeded"].includes(record.generation_status) || timedOut ||
       (record.generation_status === "failed" && /AI 类型生成失败/.test(record.failure_reason || "")))) return "recover-history";
  throw new Error(`${record.mode_label} 的生成、扣点或应用状态不确定；请人工检查后再恢复`);
}

export async function readModeJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export async function writeModeJson(file, value) {
  value.updated_at = new Date().toISOString();
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}
