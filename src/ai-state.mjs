import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const AI_FINAL_STATUSES = new Set(["applied", "failed"]);

export function emptyFilterSettings() {
  return {
    block_match_count: 0,
    selection_status: "pending",
    toolbar_status: "pending",
    panel_status: "pending",
    select_all_status: "pending",
    select_all_checked: false,
    available_fields: [],
    selected_fields: [],
    fields_verified: false,
    fields_load_status: "pending",
    fields_loading_number: null,
    fields_loading_mask_visible: false,
    generated_display_verified: false,
    persisted_display_verified: false,
    apply_status: "pending",
    applied_at: "",
    failure_reason: "",
  };
}

export function emptyNavigationSettings() {
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

export function ensureSpecialTypeState(record) {
  if (record.type === "产品筛选") record.filter_settings ??= emptyFilterSettings();
  if (record.type === "导航") record.navigation_settings ??= emptyNavigationSettings();
  return record;
}

export function createInitialAiState(config, page) {
  const now = new Date().toISOString();
  return {
    version: 1,
    mode: "ai",
    run_id: config.ai.runId ?? "",
    run_marker: config.ai.runId ? `[runId=${config.ai.runId}]` : "",
    created_at: now,
    updated_at: now,
    site_name: config.siteName,
    site_language: config.siteLanguage,
    page: {
      ...page,
      types: [],
      saved: false,
      editor_verified: false,
      preview_verified: false,
      published_verified: false,
      publish_failure_reason: "",
    },
    next_type_index: 0,
    types: config.ai.types.map((type, index) => ensureSpecialTypeState({
      index,
      type,
      prompt: config.ai.runId ? `[runId=${config.ai.runId},type=${type}] ${config.ai.prompts[type]}` : config.ai.prompts[type],
      original_prompt: config.ai.runId ? `[runId=${config.ai.runId},type=${type}] ${config.ai.prompts[type]}` : config.ai.prompts[type],
      generation_prompt: '',
      generation_record_id: '',
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
      started_at: "",
      generated_at: "",
      applied_at: "",
      verified_at: "",
      recovery_required: false,
    })),
  };
}

export function assertAiStateCompatible(state, config, expectedMode = "ai") {
  if (!state) return;
  if (state.mode !== expectedMode) throw new Error(`状态文件不是 ${expectedMode} 模式`);
  if (state.site_name !== config.siteName || state.site_language !== config.siteLanguage) {
    throw new Error("AI 状态文件的站点或语言与当前配置不一致，拒绝恢复");
  }
  if (config.ai.runId && state.run_id && state.run_id !== config.ai.runId) {
    throw new Error(`AI 状态属于 runId ${state.run_id}，当前生命周期为 ${config.ai.runId}，拒绝交叉恢复`);
  }
  const configured = config.ai.types.join("\u0000");
  const saved = (state.types ?? []).map((item) => item.type).join("\u0000");
  if (configured !== saved) throw new Error("AI 类型配置已变化，拒绝复用旧状态");
  let migrated = false;
  for (const record of state.types ?? []) {
    ensureSpecialTypeState(record);
    // Backward-compatible migration for states created before prompt polishing
    // was introduced. Existing applied records remain applied and are not
    // regenerated; they simply report a pending polish status.
    record.original_prompt ??= config.ai.prompts[record.type] ?? record.prompt ?? "";
    record.polished_prompt ??= "";
    record.polish_status ??= "pending";
    record.polished_at ??= "";
    record.polish_failure_reason ??= "";
    // A legacy run could continue generation after the polish preflight
    // failed before its status was persisted. Preserve that evidence as an
    // explicit failure instead of leaving an applied type ambiguously pending.
    if (
      record.generation_status === "succeeded" &&
      record.polish_status === "pending" &&
      !record.polished_prompt
    ) {
      record.polish_status = "failed";
      record.polish_failure_reason = "历史运行未确认“一键润色”按钮触发，已使用原始提示词继续生成";
      migrated = true;
    }
  }
  state.run_id ??= "";
  state.run_marker ??= state.run_id ? `[runId=${state.run_id}]` : "";
  if (config.ai.runId && !state.run_id) state.run_id = config.ai.runId;
  return migrated;
}

export function typeRecord(state, type) {
  const record = state.types?.find((item) => item.type === type);
  if (!record) throw new Error(`状态文件中不存在 AI 类型：${type}`);
  return record;
}

export function assertNoDuplicateAppliedType(state, type) {
  const applied = state.page?.types ?? [];
  if (applied.includes(type)) {
    throw new Error(`当前页面已经应用 AI 类型 ${type}，拒绝重复插入`);
  }
  if (new Set(applied).size !== applied.length) {
    throw new Error("当前页面状态已包含重复 AI 类型，拒绝继续写入");
  }
}

export function markTypeStarted(record) {
  record.original_prompt ??= record.prompt;
  record.prompt = record.original_prompt;
  record.polished_prompt = "";
  record.polish_status = "pending";
  record.polished_at = "";
  record.polish_failure_reason = "";
  record.started_at = new Date().toISOString();
  record.generation_status = "running";
  record.apply_status = "pending";
  record.failure_reason = "";
  record.recovery_required = false;
}

export function markTypePolishStarted(record) {
  record.polish_status = "running";
  record.polish_failure_reason = "";
}

export function markTypePolished(record, polishedPrompt) {
  const value = String(polishedPrompt ?? "").trim();
  if (!value) throw new Error("提示词润色结果为空");
  if (value === String(record.original_prompt ?? record.prompt ?? "").trim()) {
    throw new Error("提示词润色结果未发生变化");
  }
  record.polished_prompt = value;
  record.prompt = value;
  record.polish_status = "succeeded";
  record.polished_at = new Date().toISOString();
  record.polish_failure_reason = "";
}

export function markTypePolishFailed(record, error) {
  record.polish_status = "failed";
  record.polish_failure_reason = error instanceof Error ? error.message : String(error);
}

export function markTypeGenerated(record) {
  record.generation_status = "succeeded";
  record.generated_at = new Date().toISOString();
}

export function markTypeApplied(state, record) {
  if ((state.page?.types ?? []).includes(record.type)) {
    // Safe resume may revisit the same record after a confirmed canvas commit.
    // Finalize that exact attempt idempotently; never use this path to
    // legitimize a second insertion without its stable-ID commit evidence.
    if ((record.apply_status === "applied") ||
        (record.application_commit_confirmed === true && Boolean(record.committed_block_id))) {
      record.apply_status = "applied";
      record.applied_at ||= new Date().toISOString();
      state.next_type_index = Math.max(state.next_type_index, record.index + 1);
      return;
    }
    throw new Error(`当前页面已经应用 AI 类型 ${record.type}，拒绝重复插入`);
  }
  assertNoDuplicateAppliedType(state, record.type);
  record.apply_status = "applied";
  record.applied_at = new Date().toISOString();
  state.page.types.push(record.type);
  state.next_type_index = Math.max(state.next_type_index, record.index + 1);
}

export function markTypeFailed(record, error) {
  const applicationMayHaveReachedPage = record.generation_status === "succeeded";
  record.generation_status = ['succeeded', 'uncertain'].includes(record.generation_status) ? record.generation_status :
    error?.code === 'GENERATION_UNCONFIRMED' ? 'uncertain' : 'failed';
  record.apply_status = record.apply_status === "applied" ? record.apply_status : "failed";
  record.failure_reason = error instanceof Error ? error.message : String(error);
  record.verified_at = new Date().toISOString();
  record.recovery_required = applicationMayHaveReachedPage;
}

export function pendingAiRecords(state) {
  return (state.types ?? []).filter((record) => record.apply_status !== "applied");
}

export function summarizeAiState(state) {
  const counts = {};
  for (const record of state.types ?? []) {
    const key = `${record.generation_status}/${record.apply_status}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  const types = (state.types ?? []).map((record) => ({
    ...record,
    original_prompt: record.original_prompt ?? record.prompt ?? "",
    polished_prompt: record.polished_prompt ?? "",
    polish_status: record.polish_status ?? "pending",
    polished_at: record.polished_at ?? "",
    polish_failure_reason: record.polish_failure_reason ?? "",
  }));
  return {
    page: state.page,
    totalTypes: types.length,
    appliedTypes: state.page?.types?.length ?? 0,
    types,
    counts,
  };
}

export class AiStateStore {
  constructor(stateFile) {
    this.stateFile = stateFile;
  }

  async load() {
    try {
      return JSON.parse(await readFile(this.stateFile, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async save(state) {
    state.updated_at = new Date().toISOString();
    await mkdir(path.dirname(this.stateFile), { recursive: true });
    const temporary = `${this.stateFile}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(temporary, this.stateFile);
  }
}
