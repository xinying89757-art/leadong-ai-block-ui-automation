import path from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

export const REGRESSION_STAGES = [
  { key: "blocks-page-001", label: "AI 区块页面 001", entry: "src/ai-cli.mjs", run: "add", resume: "resume", stateFile: "ai-state.json" },
  { key: "blocks-pages-002-003", label: "AI 区块页面 002-003", entry: "src/ai-cli.mjs", run: "remaining", resume: "remaining:resume", stateFile: "ai-remaining/page-002.json" },
  { key: "details", label: "AI 详情区块", entry: "src/ai-cli.mjs", run: "detail", resume: "detail:resume", stateFile: "ai-detail/article.json" },
  { key: "mode-points", label: "三模式点数", entry: "src/ai-mode-points-cli.mjs", run: "run", resume: "resume", stateFile: "ai-mode-points/state.json" },
  { key: "input-modes", label: "三输入方式", entry: "src/ai-input-modes-cli.mjs", run: "run", resume: "resume", stateFile: "ai-input-modes/state.json" },
  // The suite owns the one final retry; disable nested immediate retries.
  { key: "full-page", label: "AI 生成整页", entry: "src/ai-full-page-cli.mjs", run: "run", resume: "resume", stateFile: "ai-full-page/state.json", extra: ['--no-auto-retry'] },
  { key: "history-reuse", label: "生成记录复用", entry: "src/ai-history-reuse-cli.mjs", run: "run", resume: "resume", stateFile: "ai-history-reuse/state.json" },
];

export function newRegressionRunId(now = new Date()) {
  return `regression-${now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
}

export function regressionPaths(config, runId) {
  const root = path.join(config.paths.aiLifecycleDir, "runs", runId, "suite");
  return {
    root,
    state: path.join(root, "state.json"),
    active: path.join(config.paths.aiLifecycleDir, "suite-active.json"),
  };
}

export function createRegressionState(config, runId) {
  const now = new Date().toISOString();
  return {
    version: 1,
    mode: "ai-regression-suite",
    run_id: runId,
    site_name: config.siteName,
    site_language: config.siteLanguage,
    created_at: now,
    updated_at: now,
    status: "pending",
    fatal_failure: false,
    execution_failure_reason: "",
    report: {
      status: "pending",
      file: "",
      latest_file: "",
      generated_at: "",
      failure_reason: "",
    },
    stages: REGRESSION_STAGES.map((stage, index) => ({
      index,
      key: stage.key,
      label: stage.label,
      status: "pending",
      attempts: 0,
      started_at: "",
      completed_at: "",
      duration_ms: 0,
      failure_reason: "",
      result: null,
    })),
  };
}

export function assertRegressionState(state, config, runId) {
  if (state?.mode !== "ai-regression-suite" || state.run_id !== runId) {
    throw new Error("全量回归状态与运行 ID 不匹配");
  }
  if (state.site_name !== config.siteName || state.site_language !== config.siteLanguage) {
    throw new Error("全量回归状态与站点或语言不匹配");
  }
  const expected = REGRESSION_STAGES.map((item) => item.key).join("\0");
  const actual = (state.stages ?? []).map((item) => item.key).join("\0");
  if (expected !== actual) throw new Error("全量回归阶段定义已变化，拒绝复用旧状态");
  return state;
}

export function regressionComplete(state) {
  return state.stages.every((stage) => stage.status === "passed");
}

export function isSafetyFailure(message = "") {
  return /登录失败|登录态|站点.*(?:不匹配|不存在)|语言.*不匹配|余额不足|点数不足|扣点状态.*不确定|应用状态.*不确定|恢复.*状态不确定|拒绝误操作/.test(message);
}

// Local application ambiguity quarantines that page/stage, not the suite.
export function isGlobalSafetyFailure(message = '') {
  return /登录失败|登录后仍停留在登录页|登录态(?:失效|无效|过期|异常)|站点.*(?:不匹配|不存在|不一致)|语言.*(?:不匹配|不一致)|余额不足|点数不足|可用点数.{0,40}不足|页面数量.*(?:最大限制|上限)|拒绝误操作其他(?:站点|网站)/.test(message);
}

export async function readRegressionJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function writeRegressionJson(file, value) {
  value.updated_at = new Date().toISOString();
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

export function summarizeRegression(state, paths) {
  return {
    runId: state.run_id,
    stateFile: paths.state,
    status: state.status,
    fatalFailure: state.fatal_failure,
    passed: state.stages.filter((stage) => stage.status === "passed").length,
    failed: state.stages.filter((stage) => stage.status === "failed").length,
    pending: state.stages.filter((stage) => !["passed", "failed"].includes(stage.status)).length,
    report: state.report ?? { status: "pending", file: "", latest_file: "", failure_reason: "" },
    stages: state.stages,
  };
}
