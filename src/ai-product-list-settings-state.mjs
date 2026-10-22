import path from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

export function productListSettingsPaths(config, runId) {
  const root = path.join(config.paths.aiLifecycleDir, "runs", runId, "ai-product-list-settings");
  return {
    root,
    state: path.join(root, "state.json"),
    active: path.join(config.paths.aiLifecycleDir, "product-list-settings-active.json"),
  };
}

export function newProductListSettingsRunId(now = new Date()) {
  return `product-list-settings-${now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
}

export function productListSettingsDescriptor(config, runId) {
  const mode = config.ai.productListSettingsRegression;
  const suffix = String(runId).replace(/[^a-zA-Z0-9_-]+/g, "-");
  const pathName = `/${mode.pagePathPrefix}${suffix}`;
  return {
    number: 0,
    name: `${mode.pageNamePrefix}${suffix}`,
    path: pathName,
    publicUrl: new URL(pathName, config.publicBaseUrl).toString(),
  };
}

export function productScopeResumeAction(state, { categoryName, expectedCount } = {}) {
  const runId = String(state?.run_id ?? "");
  const pageName = String(state?.page?.name ?? "");
  const type = state?.type;
  if (!runId || !pageName.endsWith(runId)) throw new Error("产品数据恢复页不属于当前 runId，拒绝修改");
  const target = String(categoryName ?? "").trim();
  if (!target || type?.catalog?.selected_category?.name !== target) throw new Error(`产品数据恢复状态未确认目标分类“${target || "(empty)"}”`);
  const expectedIds = type.catalog.selected_category.products?.map((item) => String(item.id)).filter(Boolean) ?? [];
  if (!Number.isInteger(expectedCount) || expectedCount < 1 || expectedIds.length !== expectedCount) {
    throw new Error(`产品数据恢复测试数据数量不符：配置 ${expectedCount}，后台分类产品 ID 数量 ${expectedIds.length}`);
  }
  const resultStatus = type.result_checks?.product_scope?.status;
  if (state.page.published_verified && resultStatus !== "passed") {
    throw new Error("产品数据设置结果未通过但页面已发布，拒绝自动重写线上页面");
  }
  if (state.page.saved && resultStatus !== "passed") {
    const preview = type.result_checks?.preview;
    const reason = String(preview?.evidence?.reason ?? "");
    if (preview?.status === "failed" && /分类结果包含|分类结果缺少|分类产品数量不匹配|分类结果产品数量/.test(reason)) {
      return "reapply-scope-and-revalidate";
    }
  }
  return "continue";
}

export function markProductScopeEffect(record, evidence) {
  if (evidence?.passed !== true || evidence?.exact_match !== true || evidence.actual_count < 1) {
    throw new Error("产品分类缺少实际产品 ID 精确匹配证据，拒绝标记效果通过");
  }
  const setting = record.settings.find((item) => item.key === "product_scope");
  if (!setting) throw new Error("产品分类设置记录缺失");
  setting.status = "succeeded";
  setting.effect_status = "passed";
  setting.effect_after = { ...setting.effect_after, verified_result: evidence };
  setting.effect_failure_reason = "";
}

export function emptyProductListSetting(key, label) {
  return {
    key,
    label,
    status: "pending",
    before: "",
    selected: "",
    after: "",
    reopened: "",
    failure_reason: "",
    changed_at: "",
    effect_status: "pending",
    effect_before: null,
    effect_after: null,
    effect_reopened: null,
    effect_failure_reason: "",
    locator_source: "playwright",
    fallback_used: false,
    midscene_duration_ms: 0,
    midscene_rect: null,
    midscene_failure_reason: "",
  };
}

export function createProductListSettingsState(config, runId) {
  const mode = config.ai.productListSettingsRegression;
  const now = new Date().toISOString();
  const historyMarker = `AI Product List Settings ${runId}`;
  const prompt = `${mode.prompt} Include regression marker "${historyMarker}".`;
  const typeRecord = {
    index: 0,
    type: mode.type,
    prompt,
    original_prompt: prompt,
    polished_prompt: "",
    polish_status: "pending",
    polished_at: "",
    polish_failure_reason: "",
    history_marker: historyMarker,
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
    settings_status: "pending",
    settings_opened: false,
    settings_reopened: false,
    settings_saved: false,
    settings: [
      emptyProductListSetting("product_scope", "选择产品"),
      emptyProductListSetting("sort", "产品排序"),
      emptyProductListSetting("loading", "加载方式"),
      emptyProductListSetting("page_size", "每页显示数量"),
      emptyProductListSetting("display_content", "展示内容"),
      emptyProductListSetting("base_color", "基础配色"),
    ],
    catalog: {
      source: "site-content-management",
      products: [],
      categories: [],
      selected_category: null,
      captured_at: "",
      status: "pending",
      failure_reason: "",
    },
    result_checks: Object.fromEntries([
      "product_scope", "sort", "loading_pagination", "loading_flat", "page_size",
      "display_field", "base_color", "after_reopen", "preview", "published",
    ].map((key) => [key, { status: "pending", evidence: null }])),
    settings_failure_reason: "",
    screenshot: "",
  };
  return {
    version: 2,
    mode: "ai-product-list-settings",
    run_id: runId,
    site_name: config.siteName,
    site_language: config.siteLanguage,
    created_at: now,
    updated_at: now,
    page: {
      ...productListSettingsDescriptor(config, runId),
      types: [],
      saved: false,
      editor_verified: false,
      preview_verified: false,
      published_verified: false,
      publish_status: "pending",
      cleanup_status: "pending",
      failure_reason: "",
    },
    type: typeRecord,
    // Keep the common AI runner shape so generation/apply/preview helpers
    // can be reused without allowing a second product-list record.
    types: [typeRecord],
  };
}

export function seedProductListSettingsFromHistory(state, historyState, historyRunId) {
  const source = historyState?.type;
  if (!state?.type || source?.generation_status !== "succeeded" || !source.history_marker) {
    throw new Error(`历史运行 ${historyRunId} 没有可复用的成功产品列表生成记录`);
  }
  Object.assign(state.type, {
    prompt: source.prompt,
    original_prompt: source.original_prompt || source.prompt,
    polished_prompt: source.polished_prompt || "",
    polish_status: source.polish_status || "pending",
    polished_at: source.polished_at || "",
    polish_failure_reason: source.polish_failure_reason || "",
    history_marker: source.history_marker,
    generation_status: "succeeded",
    generated_at: source.generated_at || historyState.updated_at || "",
    history_source_run_id: historyRunId,
    application_source: "history",
  });
  state.types = [state.type];
  return state;
}

export function assertProductListSettingsState(state, config, runId) {
  const expected = productListSettingsDescriptor(config, runId);
  if (state?.mode !== "ai-product-list-settings" || state.run_id !== runId) {
    throw new Error("产品列表设置状态与运行 ID 不匹配");
  }
  const priorVersion = Number(state.version ?? 1);
  if (state.site_name !== config.siteName || state.site_language !== config.siteLanguage) {
    throw new Error("产品列表设置状态与站点或语言不匹配");
  }
  for (const key of ["name", "path", "publicUrl"]) {
    if (state.page?.[key] !== expected[key]) throw new Error(`产品列表设置状态中的 ${key} 与配置不匹配`);
  }
  if (state.type?.type !== config.ai.productListSettingsRegression.type) {
    throw new Error("产品列表设置状态类型不匹配");
  }
  if (Array.isArray(state.types) && state.types.length === 1) state.type = state.types[0];
  else if (state.type) state.types = [state.type];
  state.type.settings ??= createProductListSettingsState(config, runId).type.settings;
  for (const item of state.type.settings) {
    item.locator_source ??= "playwright";
    item.fallback_used ??= false;
    item.midscene_duration_ms ??= 0;
    item.midscene_rect ??= null;
    item.midscene_failure_reason ??= "";
    item.effect_status ??= "pending";
    item.effect_before ??= null;
    item.effect_after ??= null;
    item.effect_reopened ??= null;
    item.effect_failure_reason ??= "";
    // Earlier runs only observed control values. They must be rerun because
    // they contain no evidence that the rendered product list changed.
    if (["succeeded", "passed"].includes(item.status) && item.effect_status === "pending") item.status = "pending";
  }
  state.type.catalog ??= { source: "site-content-management", products: [], categories: [], selected_category: null, captured_at: "", status: "pending", failure_reason: "" };
  state.type.result_checks ??= {};
  for (const key of ["product_scope", "sort", "loading_pagination", "loading_flat", "page_size", "display_field", "base_color", "after_reopen", "preview", "published"]) {
    state.type.result_checks[key] ??= { status: "pending", evidence: null };
  }
  if (priorVersion < 2 && state.type.settings_status === "succeeded") {
    state.type.settings_status = "failed";
    state.type.settings_failure_reason = "旧运行仅检查控件值，需补充产品列表实际效果断言";
    if (state.type.apply_status === "applied") state.type.recovery_required = true;
  }
  state.version = 2;
  state.type.history_marker ??= state.type.prompt ?? state.type.original_prompt ?? "";
  return state;
}

export function productListSettingsResumeAction(state, pageExists) {
  const record = state.type;
  if (state.page.cleanup_status === "completed") return "done";
  // A settings-only failure happens after generation has succeeded but before
  // the final AI-editor apply.  The generated record is safe to reuse; do not
  // force a new generation or treat it as an ambiguous application.  Keep the
  // hard stop for an actually running/applying operation or any other recovery
  // marker.
  const recoverableSettingsFailure =
    record.generation_status === "succeeded" &&
    record.apply_status === "applied" &&
    record.settings_status === "failed";
  const needsCommitReconciliation =
    record.generation_status === "succeeded" &&
    record.apply_status === "applied" &&
    !state.page.saved &&
    !state.page.published_verified;
  const safeToResumeUnappliedHistory =
    record.generation_status === "succeeded" &&
    record.apply_status === "pending" &&
    !state.page.saved &&
    !state.page.published_verified;
  if ((record.recovery_required && !recoverableSettingsFailure && !needsCommitReconciliation && !safeToResumeUnappliedHistory) || ["running", "applying"].includes(record.apply_status) || record.settings_status === "running") {
    throw new Error("产品列表生成或侧边栏设置状态不确定，请人工检查后再恢复");
  }
  if (pageExists) {
    if (record.apply_status === "pending" && record.generation_status === "pending") {
      throw new Error("产品列表测试页已存在但状态为空，拒绝覆盖或重复生成");
    }
    if (record.settings_status === "succeeded" && record.apply_status === "applied") return "verify-page";
    if (record.apply_status === "applied" && record.settings_status === "failed") return "continue-settings";
    if (record.generation_status === "succeeded") return "recover-generated-result";
    return "recover-generation";
  }
  if (record.apply_status === "applied" || state.page.saved || state.page.published_verified) {
    throw new Error("状态显示产品列表已应用但测试页不存在，拒绝重新生成");
  }
  return record.generation_status === "pending" ? "generate" : "recover-generation";
}

export async function readProductListSettingsJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export async function writeProductListSettingsJson(file, value) {
  value.updated_at = new Date().toISOString();
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}
