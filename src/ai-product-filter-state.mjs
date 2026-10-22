import path from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

export function productFilterPaths(config, runId) {
  const root = path.join(config.paths.aiLifecycleDir, "runs", runId, "ai-product-filter");
  return {
    root,
    state: path.join(root, "state.json"),
    active: path.join(config.paths.aiLifecycleDir, "product-filter-active.json"),
  };
}

export function newProductFilterRunId(now = new Date()) {
  return `product-filter-${now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
}

export function productFilterDescriptor(config, runId = "") {
  const mode = config.ai.productFilterRegression;
  const suffix = runId ? `-${String(runId).replace(/[^a-zA-Z0-9_-]/g, "-")}` : "";
  const pagePath = `${mode.pagePath.replace(/\/+$/, "")}${suffix}`;
  return {
    number: 4,
    name: `${mode.pageName}${suffix}`,
    path: pagePath,
    publicUrl: new URL(pagePath, config.publicBaseUrl).toString(),
  };
}

export function createProductFilterState(config, runId) {
  const mode = config.ai.productFilterRegression;
  const now = new Date().toISOString();
  const prompt = mode.prompt;
  return {
    version: 1,
    mode: "ai-product-filter",
    run_id: runId,
    site_name: config.siteName,
    site_language: config.siteLanguage,
    created_at: now,
    updated_at: now,
    page: {
      ...productFilterDescriptor(config, runId),
      types: [],
      saved: false,
      editor_verified: false,
      preview_verified: false,
      published_verified: false,
      publish_status: "pending",
      cleanup_status: "pending",
      failure_reason: "",
    },
    types: [{
      index: 0,
      type: mode.type,
      prompt,
      original_prompt: prompt,
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
      filter_settings: {
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
      },
    }],
  };
}

export function assertProductFilterState(state, config, runId) {
  const expected = [productFilterDescriptor(config, runId), productFilterDescriptor(config)]
    .find((candidate) => candidate.name === state?.page?.name && candidate.path === state?.page?.path &&
      candidate.publicUrl === state?.page?.publicUrl);
  if (state?.mode !== "ai-product-filter" || state.run_id !== runId) {
    throw new Error("产品筛选状态与运行 ID 不匹配");
  }
  if (state.site_name !== config.siteName || state.site_language !== config.siteLanguage) {
    throw new Error("产品筛选状态与站点或语言不匹配");
  }
  if (!expected) throw new Error("产品筛选状态中的页面与配置不匹配");
  if (!Array.isArray(state.types) || state.types.length !== 1 || state.types[0].type !== config.ai.productFilterRegression.type) {
    throw new Error("产品筛选状态必须只包含一个产品筛选类型");
  }
  state.types[0].filter_settings ??= {
    block_match_count: 0,
    selection_status: "pending",
    toolbar_status: "pending",
    panel_status: "pending",
    select_all_status: "pending",
    select_all_checked: false,
    apply_status: "pending",
    applied_at: "",
    failure_reason: "",
  };
  return state;
}

export function productFilterResumeAction(state, pageExists) {
  const record = state.types[0];
  if (state.page.cleanup_status === "completed") return "done";
  // A known pre-apply selector failure is recoverable from the existing
  // generation record.  We must never issue a new generation request in this
  // case because that would charge points twice.
  const knownPreApplyFailure = record.recovery_required
    && record.generation_status === "succeeded"
    && record.filter_settings?.apply_status === "failed"
    && record.application_attempted !== true
    && !["applying", "applied"].includes(record.apply_status);
  // Compatibility for older standalone runs that wrote apply_status=applied
  // immediately after clicking the result button without storing either an
  // application attempt or a canvas-commit confirmation. The runner must
  // inspect the page before deciding whether history recovery is safe.
  const unconfirmedLegacyMark = record.apply_status === "applied"
    && record.application_attempted !== true
    && record.application_commit_confirmed !== true;
  const confirmedCommit = record.application_commit_confirmed === true && Boolean(record.committed_block_id);
  if ((record.recovery_required && !knownPreApplyFailure && !unconfirmedLegacyMark && !confirmedCommit) || ["running", "applying"].includes(record.apply_status) ||
      ["running", "succeeded"].includes(record.filter_settings?.apply_status) && record.apply_status !== "applied" && !confirmedCommit) {
    throw new Error("产品筛选生成或设置应用状态不确定，请人工检查后再恢复");
  }
  if (pageExists) {
    if (record.apply_status === "pending" && record.generation_status === "pending") {
      throw new Error("产品筛选测试页已存在但状态为空，拒绝覆盖或重复生成");
    }
    if (record.apply_status === "applied" || confirmedCommit) return "verify-page";
    if (record.generation_status === "succeeded") return "recover-generated-result";
    return "recover-generation";
  }
  if (record.apply_status === "applied" || state.page.saved || state.page.published_verified) {
    throw new Error("状态显示产品筛选已应用但测试页不存在，拒绝重新生成");
  }
  return record.generation_status === "pending" ? "generate" : "recover-generation";
}

export async function readProductFilterJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export async function writeProductFilterJson(file, value) {
  value.updated_at = new Date().toISOString();
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}
