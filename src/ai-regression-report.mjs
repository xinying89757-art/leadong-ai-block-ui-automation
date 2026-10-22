import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { readableCheck, renderRegressionHtml } from "./ai-regression-report-view.mjs";

export function redact(value) {
  return String(value ?? "")
    .replace(/(authorization|cookie|password|passwd|token)(\s*[:=]\s*)[^,;\s]+/gi, "$1$2[REDACTED]")
    .replace(/([?&](?:authorization|token|password|access_token)=)[^&\s]+/gi, "$1[REDACTED]");
}

export function formatDuration(milliseconds = 0) {
  const totalSeconds = Math.max(0, Math.round(Number(milliseconds || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours}小时 ${minutes}分 ${seconds}秒`;
  if (minutes) return `${minutes}分 ${seconds}秒`;
  return `${seconds}秒`;
}

function statusFromFlags(flags, fallback = "blocked") {
  if (flags.every(Boolean)) return "passed";
  if (flags.some((flag) => flag === false)) return "failed";
  return fallback;
}

async function readJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch { return null; }
}

async function resolveStateFile(root, candidate) {
  if (!candidate) return null;
  const file = path.isAbsolute(candidate) ? candidate : path.resolve(root, candidate);
  return await access(file).then(() => file).catch(() => null);
}

function check(label, status, details = {}) {
  return { label, status, steps: [], details };
}

function pageChecks(page, label = "页面链路") {
  if (!page) return [check(label, "blocked", { reason: "数据不可用" })];
  const flags = [
    page.saved === true,
    page.editor_verified === true,
    page.preview_verified === true,
    page.published_verified === true,
  ];
  if (Object.prototype.hasOwnProperty.call(page, "public_navigation_verified")) {
    flags.push(page.public_navigation_verified === true);
  }
  return [check(label, statusFromFlags(flags), {
    page: page.name,
    publicUrl: page.publicUrl,
    saved: page.saved,
    editor: page.editor_verified,
    preview: page.preview_verified,
    published: page.published_verified,
    ...(Object.hasOwn(page, "public_navigation_verified") ? { navigation: page.public_navigation_verified } : {}),
    publishStatus: page.publish_status,
    navigationLinks: page.public_link_results,
    failure: page.failure_reason || page.publish_failure_reason || "",
    pageFailureStep: page.failure_step,
    screenshot: page.failure_screenshot || "",
  })];
}

function typeChecks(state, pageLabel) {
  const types = Array.isArray(state?.types) ? state.types : [];
  if (!types.length) return [check(pageLabel, "blocked", { reason: "数据不可用" })];
  return types.map((item) => {
    const specialized = item.type === "产品筛选"
      ? [item.filter_settings?.selection_status === "succeeded", item.filter_settings?.select_all_checked === true, item.filter_settings?.apply_status === "succeeded"]
      : item.type === "导航"
        ? [item.navigation_settings?.selected_count === 2, item.navigation_settings?.add_status === "succeeded", item.navigation_settings?.save_status === "succeeded"]
        : [];
    const status = statusFromFlags([
      item.generation_status === "succeeded",
      item.apply_status === "applied",
      item.editor_verified === true,
      item.preview_verified === true,
      item.published_verified === true,
      ...specialized,
    ]);
    return check(`${pageLabel} / ${item.type}`, status, {
      type: item.type,
      generation: item.generation_status,
      applied: item.apply_status,
      editor: item.editor_verified,
      saved: state.page?.saved,
      preview: item.preview_verified,
      published: item.published_verified,
      points: item.actual_cost === undefined ? undefined : `${item.actual_cost}/${item.expected_cost}`,
      filterSelectAll: item.filter_settings?.select_all_checked,
      filterSettings: item.filter_settings?.apply_status,
      navigationSelectedCount: item.navigation_settings?.selected_count,
      navigationAdd: item.navigation_settings?.add_status,
      navigationSave: item.navigation_settings?.save_status,
      ...(item.type === "导航" ? { navigation: state.page?.public_navigation_verified } : {}),
      failure: item.failure_reason || state.page?.failure_reason || "",
      pageFailureStep: state.page?.failure_step,
      applicationSource: item.application_source,
      polishWarning: item.polish_status === "failed",
      screenshot: item.failure_screenshot || item.screenshot || "",
    });
  });
}

function detailChecks(state) {
  const types = Array.isArray(state?.types) ? state.types : [];
  return types.length ? types.map((item) => check(`详情 / ${item.type}`, statusFromFlags([
    item.generation_status === "succeeded",
    item.apply_status === "applied",
    item.editor_verified === true,
    item.preview_verified === true,
    item.published_verified === true,
  ]), {
    type: item.type,
    page: state.page?.name,
    publicUrl: state.page?.publicUrl,
    generation: item.generation_status,
    applied: item.apply_status,
    editor: item.editor_verified,
    saved: state.page?.saved,
    preview: item.preview_verified,
    published: item.published_verified,
    failure: item.failure_reason || state.page?.failure_reason || "",
    screenshot: item.failure_screenshot || state.page?.failure_screenshot || state.failure_screenshot || "",
  })) : [check("详情链路", "blocked", { reason: "数据不可用" })];
}

function modeChecks(state) {
  const records = Array.isArray(state?.records) ? state.records : [];
  return records.length ? records.map((item) => check(`生成模式 / ${item.mode_label || item.mode}`, statusFromFlags([
    item.generation_status === "succeeded",
    item.application_status === "applied",
    item.points_status === "passed",
    item.editor_verified === true,
    item.preview_verified === true,
    item.published_verified === true,
  ]), {
    mode: item.mode_label || item.mode,
    points: `${item.actual_cost}/${item.expected_cost}`,
    expectedCost: item.expected_cost,
    actualCost: item.actual_cost,
    pointsStatus: item.points_status,
    generation: item.generation_status,
    application: item.application_status,
    applicationSource: item.application_source,
    editor: item.editor_verified,
    saved: state.page?.saved,
    preview: item.preview_verified,
    published: item.published_verified,
    screenshot: item.failure_screenshot || item.screenshot || "",
    recordId: item.generation_record_id,
    statusRefreshCount: item.status_refresh_count,
    generationWaitMs: item.generation_wait_ms,
    recoveredFromHistory: item.recovered_from_history,
    page: state.page?.name,
    publicUrl: state.page?.publicUrl,
    failure: item.failure_reason || item.points_failure_reason || "",
  })) : [check("生成模式点数", "blocked", { reason: "数据不可用" })];
}

function inputChecks(state) {
  const records = Array.isArray(state?.records) ? state.records : [];
  return records.length ? records.map((item) => check(`输入方式 / ${item.input_mode_label || item.input_mode}`, statusFromFlags([
    item.input_status === "succeeded",
    item.generation_status === "succeeded",
    item.application_status === "applied",
    item.points_status === "passed",
    item.editor_verified === true,
    item.preview_verified === true,
    item.published_verified === true,
  ]), {
    input: item.input_mode_label || item.input_mode,
    points: `${item.actual_cost}/${item.expected_cost}`,
    inputStatus: item.input_status,
    expectedCost: item.expected_cost,
    actualCost: item.actual_cost,
    pointsStatus: item.points_status,
    generation: item.generation_status,
    application: item.application_status,
    editor: item.editor_verified,
    saved: state.page?.saved,
    preview: item.preview_verified,
    published: item.published_verified,
    screenshot: item.failure_screenshot || item.screenshot || "",
    page: state.page?.name,
    publicUrl: state.page?.publicUrl,
    failure: item.failure_reason || item.input_failure_reason || item.points_failure_reason || "",
  })) : [check("输入方式回归", "blocked", { reason: "数据不可用" })];
}

function fullPageChecks(state) {
  if (!state?.page || !state?.generation) return [check("整页生成", "blocked", { reason: "数据不可用" })];
  const page = state.page;
  return [check("整页生成", statusFromFlags([
    state.generation.generation_status === "succeeded",
    state.generation.application_status === "applied",
    page.saved === true,
    page.editor_verified === true,
    page.preview_verified === true,
    page.published_verified === true,
  ]), {
    page: page.name,
    publicUrl: page.publicUrl,
    generation: state.generation.generation_status,
    application: state.generation.application_status,
    saved: page.saved,
    publishStatus: page.publish_status,
    applicationLoadStatus: page.application_load_status,
    expectedBlockCount: state.generation.expected_block_count,
    loadedBlockCount: page.application_evidence?.ready_count ?? page.application_progress?.ready_count,
    editor: page.editor_verified,
    preview: page.preview_verified,
    published: page.published_verified,
    retries: state.retry?.attempt ?? 0,
    failure: page.failure_reason || state.generation.failure_reason || "",
    screenshot: page.failure_screenshot || state.generation.failure_screenshot || "",
  })];
}

function historyChecks(state) {
  if (!state) return [check("生成记录复用", "blocked", { reason: "数据不可用" })];
  const result = [];
  for (const [key, label] of [["full_page", "整页生成记录复用"], ["block", "区块生成记录复用"]]) {
    const item = state[key];
    const page = item?.page;
    result.push(check(label, statusFromFlags([
      item?.generation?.generation_status === "succeeded",
      item?.generation?.application_status === "applied",
      item?.history?.application_source === "history",
      page?.saved === true,
      page?.editor_verified === true,
      page?.preview_verified === true,
      page?.published_verified === true,
    ]), {
      page: page?.name,
      publicUrl: page?.publicUrl,
      applicationSource: item?.history?.application_source,
      generation: item?.generation?.generation_status,
      application: item?.history?.application_source === "history" ? item?.generation?.application_status : "pending",
      historyReopened: item?.history?.reopened,
      historyMatch: item?.history?.match_status,
      publishStatus: page?.publish_status,
      editor: page?.editor_verified,
      saved: page?.saved,
      preview: page?.preview_verified,
      published: page?.published_verified,
      ...(key === "block" ? { blockIncrement: Number.isFinite(item?.block_count_before) && Number.isFinite(item?.block_count_after) ? item.block_count_after - item.block_count_before === 1 : undefined } : {}),
      applicationLoadStatus: page?.application_load_status,
      expectedBlockCount: item?.generation?.expected_block_count,
      loadedBlockCount: page?.application_evidence?.ready_count ?? page?.application_progress?.ready_count,
      failure: page?.failure_reason || item?.generation?.failure_reason || item?.history?.failure_reason || "",
      screenshot: page?.failure_screenshot || item?.generation?.failure_screenshot || item?.history?.failure_screenshot || item?.failure_screenshot || state.failure_screenshot || "",
    }));
  }
  return result;
}

async function readChildState(root, result, fallbackFiles = []) {
  const candidates = [];
  if (result?.stateFile) candidates.push(result.stateFile);
  else candidates.push(...fallbackFiles.map((file) => path.join(root, file)));
  for (const candidate of candidates) {
    const file = await resolveStateFile(root, candidate);
    if (file) return { file, state: await readJson(file) };
  }
  return { file: "", state: null };
}

// Older failed CLIs only recorded the retry ID in stderr. Follow that exact ID
// and its ownership chain; a global latest pointer can belong to another run.
async function fullPageChild(config, suite, stage, root) {
  if (stage.result?.stateFile) return readChildState(root, stage.result);
  const ids = [...String(stage.failure_reason || "").matchAll(/新运行\s+([a-zA-Z0-9_-]{1,80})(?=\s|$)/g)].map((match) => match[1]);
  if (!ids.length) return readChildState(root, null, ["../ai-full-page/state.json"]);
  const runs = config.paths?.aiLifecycleDir ? path.join(config.paths.aiLifecycleDir, "runs") : path.resolve(root, "../..");
  const finalId = ids.at(-1);
  const file = path.join(runs, finalId, "ai-full-page/state.json");
  const state = await readJson(file);
  let current = state;
  let expectedId = finalId;
  const visited = new Set();
  while (current && visited.size < 10 && !visited.has(expectedId)) {
    if (current.run_id !== expectedId) break;
    visited.add(expectedId);
    if (current.site_name && suite.site_name && current.site_name !== suite.site_name) break;
    if (current.site_language && suite.site_language && current.site_language !== suite.site_language) break;
    const parent = current.retry?.previous_run_id;
    if (parent === suite.run_id && ids.every((id) => visited.has(id))) return { file, state };
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(parent || "")) break;
    expectedId = parent;
    current = await readJson(path.join(runs, parent, "ai-full-page/state.json"));
  }
  return { file: "", state: null, unconfirmed: true };
}

export async function normalizeRegressionReport(config, suiteState, suiteRoot) {
  const stages = [];
  for (const stage of suiteState.stages ?? []) {
    // Retry child runs are isolated; never fall back to the original run's
    // state when the final attempt has its own recorded run ID.
    const stageRoot = stage.result?.childRunId
      ? path.join(config.paths.aiLifecycleDir, 'runs', stage.result.childRunId, 'suite') : suiteRoot;
    let checks = [];
    let sourceFile = "";
    if (stage.key === "blocks-page-001") {
      const child = await readChildState(stageRoot, stage.result, ["../ai-state.json"]);
      sourceFile = child.file; checks = [...typeChecks(child.state, "区块页面 001"), ...pageChecks(child.state?.page, "区块页面 001")];
    } else if (stage.key === "blocks-pages-002-003") {
      for (const [number, label] of [[2, "区块页面 002"], [3, "区块页面 003"]]) {
        const pageResult = stage.result?.pages?.find(item => item.page === number);
        const child = await readChildState(stageRoot, pageResult || (number === 2 ? stage.result : null), [`../ai-remaining/page-00${number}.json`]);
        sourceFile ||= child.file;
        const expected = config.ai?.followupPages?.find((page) => page.number === number)?.types || [];
        if (!child.file && stage.status !== "passed" && expected.length) {
          checks.push(...expected.map((type) => check(`${label} / ${type}`, "pending", { type, generation: "pending", applied: "pending" })), check(label, "pending"));
        } else checks.push(...typeChecks(child.state, label), ...pageChecks(child.state?.page, label));
      }
    } else if (stage.key === "details") {
      for (const name of ["article", "gallery", "video"]) {
        const detailResult = stage.result?.pages?.find(item => item.stateFile?.endsWith(`/ai-detail/${name}.json`));
        const child = await readChildState(stageRoot, detailResult, [`../ai-detail/${name}.json`]);
        sourceFile ||= child.file; checks.push(...detailChecks(child.state));
      }
    } else if (stage.key === "mode-points") {
      const child = await readChildState(stageRoot, stage.result, ["../ai-mode-points/state.json"]);
      sourceFile = child.file; checks = [...modeChecks(child.state), ...pageChecks(child.state?.page, "三模式点数页面")];
    } else if (stage.key === "input-modes") {
      const child = await readChildState(stageRoot, stage.result, ["../ai-input-modes/state.json"]);
      sourceFile = child.file; checks = [...inputChecks(child.state), ...pageChecks(child.state?.page, "三输入方式页面")];
    } else if (stage.key === "full-page") {
      const child = await fullPageChild(config, suiteState, stage, stageRoot);
      sourceFile = child.file; checks = child.unconfirmed ? [check("整页生成", "blocked", { reason: "结果未确认" })] : fullPageChecks(child.state);
    } else if (stage.key === "history-reuse") {
      const child = await readChildState(stageRoot, stage.result, ["../ai-history-reuse/state.json"]);
      sourceFile = child.file; checks = historyChecks(child.state);
      if (stage.result?.sections?.length === 1) checks = checks.filter(item =>
        stage.result.sections[0] === 'full_page' ? item.label.includes('整页') : item.label.includes('区块'));
    }
    if (stage.retry_items?.length) {
      // Merge by business item, not by retry page/stage. Never replace a
      // successful original record with an unrelated retry child state.
      checks = stage.retry_items.map(item => {
        const final = item.final_result || item;
        const initial = item.initial_result || item;
        const attempts = [{ label: '首次执行', status: initial.status, ...initial.evidence }];
        if (item.retry_count) attempts.push({ label: '精准重试', status: item.status, ...final.evidence });
        return { ...check(item.label, item.status, { ...final.evidence,
          failure: item.status === 'passed' ? '' : item.failure_reason || final.failure_reason,
          attempts, retries: item.retry_count || 0,
          originalPageUnchanged: item.retry_result?.application === 'isolated-retry-page',
        }), item_key: item.key, item_retry: item.retry_count || 0,
          recovered: item.recovered_without_generation === true };
      });
    }
    if (!checks.length) checks = [check(stage.label, stage.status === "passed" ? "blocked" : stage.status, { reason: "数据不可用" })];
    checks = checks.map(readableCheck);
    if (stage.retry_items?.length) checks = checks.map((item, index) => {
      const saved = stage.retry_items[index];
      return { ...item, status: saved.status,
        resultLabel: saved.status === 'passed' && saved.retry_count ? '重试通过'
          : saved.status === 'passed' && saved.recovered_without_generation ? '恢复通过' : item.resultLabel };
    });
    if (stage.status === "pending") checks = checks.map((item) => ({ ...item, status: "pending", resultLabel: "未执行", details: {}, steps: item.steps.map((entry) => ({ ...entry, status: "pending" })) }));
    if (["failed", "blocked"].includes(stage.status)) checks = checks.map((item) => ({ ...item,
      status: item.status === "running" ? "blocked" : item.status,
      steps: item.steps.map((entry) => entry.status === "running" ? { ...entry, status: "blocked" } : entry),
    }));
    if (stage.status === "failed" && checks.every((item) => item.status === "passed")) {
      checks.push(check(`${stage.label} 阶段结果`, "failed", { reason: stage.failure_reason || "阶段失败" }));
    }
    let initialFailure = stage.attempt_history?.find(item => ['failed', 'blocked'].includes(item.status))?.failure_reason || '';
    if (!initialFailure && stage.end_retry_count && stage.key === 'blocks-page-001') {
      // Legacy suites did not have an attempt ledger. Their exact original
      // run still contains the type failures; use it only as diagnostic
      // history, never as the final result or timing source.
      const initial = await readChildState(suiteRoot, null, ['../ai-state.json']);
      initialFailure = initial.state?.types?.map(item => item.failure_reason).filter(Boolean).join('；') || '';
    }
    stages.push({
      key: stage.key,
      label: stage.label,
      status: stage.status,
      attempts: stage.attempts,
      end_retry_count: stage.end_retry_count || 0,
      precise_retry: Array.isArray(stage.retry_items),
      item_retry_count: (stage.retry_items || []).filter(item => item.retry_count > 0).length,
      initial_attempts: stage.attempt_history?.filter(item => item.phase === 'initial').length ||
        Math.max(0, Number(stage.attempts || 0) - (stage.retry_items || []).reduce((sum, item) => sum + (item.attempt_history?.length || item.retry_count || 0), 0)),
      initial_failure_reason: initialFailure,
      duration_ms: stage.duration_ms || 0,
      started_at: stage.started_at,
      completed_at: stage.completed_at,
      failure_reason: ['failed', 'blocked'].includes(stage.status)
        ? checks.find(item => ['failed', 'blocked'].includes(item.status) && (item.details?.failure || item.details?.reason))?.details?.failure ||
          checks.find(item => ['failed', 'blocked'].includes(item.status) && item.details?.reason)?.details?.reason || stage.failure_reason
        : stage.failure_reason,
      source_file: sourceFile,
      checks,
    });
  }
  const checks = stages.flatMap((stage) => stage.checks);
  const counts = checks.reduce((acc, item) => { acc[item.status] = (acc[item.status] || 0) + 1; return acc; }, {});
  const totalDurationMs = stages.reduce((sum, stage) => sum + stage.duration_ms, 0);
  return {
    runId: suiteState.run_id,
    status: suiteState.status,
    siteName: suiteState.site_name,
    siteLanguage: suiteState.site_language,
    createdAt: suiteState.created_at,
    updatedAt: suiteState.updated_at,
    completedAt: suiteState.completed_at || suiteState.finished_at || "",
    durationMs: totalDurationMs,
    duration: formatDuration(totalDurationMs),
    stages,
    counts,
    passed: counts.passed || 0,
    failed: counts.failed || 0,
    blocked: counts.blocked || 0,
    pending: counts.pending || 0,
    running: counts.running || 0,
  };
}

export function buildRegressionHtml(report) {
  return renderRegressionHtml(report, formatDuration);
}

export function regressionReportPaths(config, runId) {
  const dir = path.join(config.paths.aiRegressionReportsDir, runId);
  return { dir, file: path.join(dir, "report.html"), latest: path.join(config.paths.aiRegressionReportsDir, "latest.html") };
}

async function atomicWrite(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, content, "utf8");
  await rename(temp, file);
}

function imageMime(bytes) {
  if (bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && bytes.toString("ascii", 12, 16) === "IHDR" && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0
    && bytes.includes(Buffer.from("IEND"))) return "png";
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes.at(-2) === 255 && bytes.at(-1) === 217) return "jpeg";
  if (bytes.length >= 20 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" && bytes.readUInt32LE(4) + 8 <= bytes.length) return "webp";
  return "";
}

export async function writeRegressionReport(config, suiteState, suitePaths) {
  const report = await normalizeRegressionReport(config, suiteState, suitePaths.root);
  const embedScreenshot = async (details, stage) => {
    const screenshot = details?.screenshot;
    if (!screenshot) return;
    try {
      const file = path.isAbsolute(screenshot) ? screenshot : path.resolve(stage.source_file ? path.dirname(stage.source_file) : suitePaths.root, screenshot);
      const image = await readFile(file);
      const mime = imageMime(image);
      details.screenshot = mime ? `data:image/${mime};base64,${image.toString('base64')}` : '截图不可用';
    } catch { details.screenshot = '截图不可用'; }
  };
  for (const stage of report.stages) {
    for (const item of stage.checks) {
      await embedScreenshot(item.details, stage);
      for (const attempt of item.details?.attempts || []) await embedScreenshot(attempt, stage);
    }
  }
  const output = regressionReportPaths(config, suiteState.run_id);
  const html = buildRegressionHtml(report);
  await atomicWrite(output.file, html);
  await atomicWrite(output.latest, html);
  return { ...output, report, generatedAt: new Date().toISOString() };
}
