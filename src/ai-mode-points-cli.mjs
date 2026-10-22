#!/usr/bin/env node
import { stdout, stderr } from "node:process";
import { loadConfig } from "./config.mjs";
import { LeadongEditor, launchEditorBrowser } from "./editor.mjs";
import { AiModePointsAutomation } from "./ai-mode-points-runner.mjs";
import { parseCliArgs } from "./cli-args.mjs";
import {
  createModePointsState,
  modePointsPaths,
  newModePointsRunId,
  readModeJson,
  writeModeJson,
} from "./ai-mode-points-state.mjs";

function args(argv) {
  return parseCliArgs(argv);
}

function output(value) { stdout.write(`${JSON.stringify(value, null, 2)}\n`); }

function summary(state, paths) {
  return {
    runId: state.run_id,
    stateFile: paths.state,
    page: state.page,
    initialPoints: state.initial_points,
    records: state.records.map((record) => ({
      mode: record.mode, label: record.mode_label, heading: record.heading,
      generation: record.generation_status, application: record.application_status,
      pointsSource: record.points_source ?? "legacy-moli-workbench",
      pointsBefore: record.points_before, pointsAfter: record.points_after,
      expectedCost: record.expected_cost, actualCost: record.actual_cost,
      pointsStatus: record.points_status, pointsFailureReason: record.points_failure_reason,
      editorVerified: record.editor_verified, previewVerified: record.preview_verified,
      publishedVerified: record.published_verified, failureReason: record.failure_reason,
      generationRecordId: record.generation_record_id ?? "",
      statusRefreshCount: record.status_refresh_count ?? 0,
      generationWaitMs: record.generation_wait_ms ?? null,
      lastObservedStatus: record.last_observed_status ?? "",
      recoveredFromHistory: record.recovered_from_history === true,
    })),
  };
}

function validateRunId(runId) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(runId ?? "")) throw new Error("run-id 只能包含字母、数字、横线和下划线，最长 80 字符");
  return runId;
}

async function main() {
  const options = args(process.argv.slice(2));
  const command = options._[0] ?? "status";
  if (!["run", "resume", "status", "cleanup"].includes(command)) throw new Error(`未知点数专项命令：${command}`);
  const config = await loadConfig(options.config ?? "config/run.json");
  if (!config.ai.modePointRegression?.enabled) throw new Error("AI 模式点数专项未启用");
  const pointer = modePointsPaths(config, "placeholder").active;
  const active = await readModeJson(pointer);
  let runId;
  if (command === "run") {
    if (!options.apply) throw new Error("执行生成需显式传 --apply");
    if (active?.runId && !options["run-id"]) {
      const previous = await readModeJson(modePointsPaths(config, active.runId).state);
      if (previous && !previous.page.published_verified && previous.page.cleanup_status !== "completed") {
        throw new Error(`点数专项 ${active.runId} 尚未完成，请使用 resume 或 cleanup`);
      }
    }
    runId = validateRunId(options["run-id"] || newModePointsRunId());
    const paths = modePointsPaths(config, runId);
    if (await readModeJson(paths.state)) throw new Error(`运行 ID ${runId} 已存在，拒绝重复生成`);
    await writeModeJson(paths.state, createModePointsState(config, runId));
    await writeModeJson(pointer, { runId, stateFile: paths.state });
  } else {
    runId = validateRunId(options["run-id"] || active?.runId);
  }
  const paths = modePointsPaths(config, runId);
  if (command === "status") {
    const state = await readModeJson(paths.state);
    output(state ? { ok: true, command, ...summary(state, paths) } : { ok: false, command, runId, message: "没有运行状态" });
    return;
  }
  if (command === "cleanup" && !options.apply) throw new Error("清理页面和区块需显式传 --apply");
  if (command === "resume" && !options.apply) throw new Error("恢复生成需显式传 --apply");
  const { context, page } = await launchEditorBrowser({ ...config, ai: { ...config.ai, runId } }, { headless: options.headless === true, isolatedProfile: false, slowMo: 0 });
  try {
    const editor = new LeadongEditor(page, config);
    await editor.goto();
    const runner = new AiModePointsAutomation(editor, config, runId);
    const state = command === "cleanup" ? await runner.cleanup() : await runner.run({ resume: command === "resume" });
    const ok = command === "cleanup"
      ? state.page.cleanup_status === "completed"
      : state.page.published_verified && state.records.every((record) => record.points_status === "passed");
    output({ ok, command, ...summary(state, paths) });
    if (!ok) process.exitCode = 1;
  } finally { await context.close(); }
}

main().catch((error) => { stderr.write(`AI 模式点数专项失败：${error.message}\n`); process.exitCode = 1; });
