#!/usr/bin/env node
import path from "node:path";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { stderr, stdout } from "node:process";
import { loadConfig, projectRoot } from "./config.mjs";
import {
  assertRegressionState,
  createRegressionState,
  newRegressionRunId,
  readRegressionJson,
  regressionComplete,
  regressionPaths,
  summarizeRegression,
  writeRegressionJson,
} from "./ai-regression-state.mjs";
import { writeRegressionReport } from "./ai-regression-report.mjs";
import { executeRegressionStages } from './ai-regression-execution.mjs';
import { collectStageItems } from './ai-retry-targets.mjs';

function parseArgs(argv) {
  const options = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) { options._.push(token); continue; }
    const [key, inline] = token.slice(2).split("=", 2);
    if (inline !== undefined) options[key] = inline;
    else if (argv[index + 1] && !argv[index + 1].startsWith("--")) options[key] = argv[++index];
    else options[key] = true;
  }
  return options;
}

function validateRunId(value) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(value ?? "")) {
    throw new Error("run-id 只能包含字母、数字、横线和下划线，最长 80 字符");
  }
  return value;
}

function compactResult(value) {
  if (!value || typeof value !== "object") return null;
  return {
    ok: value.ok,
    command: value.command,
    stateFile: value.stateFile,
    runId: value.runId,
    page: value.page?.name ?? value.page,
    failures: value.failures,
    pages: value.pages?.map(item => ({ page: typeof item.page === 'object' ? item.page?.number : item.page,
      type: item.type, systemPage: item.systemPage, stateFile: item.stateFile })),
  };
}

async function runChild(stage, action, options, runId, extra = []) {
  const args = [path.resolve(projectRoot, stage.entry), action, "--apply", `--run-id=${runId}`];
  if (options.config) args.push("--config", options.config);
  if (options.headless === true) args.push("--headless");
  args.push(...(stage.extra ?? []));
  args.push(...extra);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: projectRoot, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => { const text = chunk.toString(); out += text; stdout.write(text); });
    child.stderr.on("data", (chunk) => { const text = chunk.toString(); err += text; stderr.write(text); });
    child.on("error", (error) => resolve({ code: 1, stdout: out, stderr: `${err}${error.message}` }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout: out, stderr: err }));
  });
}

function parseChildOutput(text) {
  try { return JSON.parse(text); }
  catch { return null; }
}

async function refreshReport(config, state, paths, { required = false } = {}) {
  try {
    const result = await writeRegressionReport(config, state, paths);
    state.report = {
      status: "generated",
      file: result.file,
      latest_file: result.latest,
      generated_at: result.generatedAt,
      failure_reason: "",
    };
    await writeRegressionJson(paths.state, state);
    return result;
  } catch (error) {
    state.report = {
      ...(state.report ?? {}),
      status: "failed",
      failure_reason: error.message,
    };
    await writeRegressionJson(paths.state, state).catch(() => {});
    if (required) throw error;
    stderr.write(`AI 回归报告刷新失败：${error.message}\n`);
    return null;
  }
}

function outputSummary(state, paths) {
  return {
    ok: state.status === "passed",
    ...summarizeRegression(state, paths),
    reportFile: state.report?.file || "",
    reportStatus: state.report?.status || "pending",
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const command = options._[0] ?? "status";
  if (!["run", "resume", "status", "report"].includes(command)) throw new Error(`未知全量回归命令：${command}`);
  const config = await loadConfig(options.config ?? "config/run.json");
  if (!config.ai.regressionSuite?.enabled) throw new Error("AI 全量回归未启用");
  const activePath = regressionPaths(config, "placeholder").active;
  const active = await readRegressionJson(activePath);
  if (["status", "report"].includes(command) && !options["run-id"] && !active?.runId) {
    stdout.write(`${JSON.stringify({ initialized: false, message: "尚无全量回归状态" }, null, 2)}\n`);
    return;
  }
  let runId;
  let state;
  if (command === "run") {
    if (!options.apply) throw new Error("全量回归需显式传 --apply");
    runId = validateRunId(options["run-id"] || newRegressionRunId());
    const paths = regressionPaths(config, runId);
    if (await readRegressionJson(paths.state)) throw new Error(`全量回归 ${runId} 已存在，请使用 resume`);
    state = createRegressionState(config, runId);
    await writeRegressionJson(paths.state, state);
    await writeRegressionJson(activePath, { runId, stateFile: paths.state });
  } else {
    runId = validateRunId(options["run-id"] || active?.runId);
    state = await readRegressionJson(regressionPaths(config, runId).state);
    if (!state) throw new Error(`找不到全量回归状态：${runId}`);
    assertRegressionState(state, config, runId);
  }
  const paths = regressionPaths(config, runId);
  if (["status", "report"].includes(command)) {
    await refreshReport(config, state, paths, { required: true });
    stdout.write(`${JSON.stringify(outputSummary(state, paths), null, 2)}\n`);
    return;
  }
  try {
    state.status = "running";
    state.fatal_failure = false;
    state.execution_failure_reason = "";
    await writeRegressionJson(paths.state, state);
    await refreshReport(config, state, paths);

    await executeRegressionStages(state, config.ai.regressionSuite, {
      collectItems: stage => collectStageItems(config, state, stage),
      executeRetry: async (definition, { stage, item, runId }) => {
        const taskFile = path.join(paths.root, 'item-retries', runId, 'task.json');
        if (!await readRegressionJson(taskFile)) {
          await writeRegressionJson(taskFile, { version: 1, mode: 'ai-item-retry', run_id: runId,
            item: item.initial_result || item, status: 'reserved',
            related_items: stage.retry_items.filter(other => other.source_file === item.source_file) });
        }
        stderr.write(`精准重试：${item.label}（仅处理该项，${runId}）\n`);
        const result = await runChild({ entry: 'src/ai-item-retry-cli.mjs' }, 'run', options, runId, [`--task-file=${taskFile}`]);
        const parsed = parseChildOutput(result.stdout);
        return parsed || { ok: false, reason: result.stderr || '结果未确认：精准重试未返回结构化结果' };
      },
      persist: async () => {
        await writeRegressionJson(paths.state, state);
        await refreshReport(config, state, paths);
      },
      execute: async (definition, attempt) => {
        const childPaths = regressionPaths(config, attempt.runId);
        const childState = path.join(path.dirname(childPaths.root), definition.stateFile);
        const exists = await access(childState).then(() => true).catch(() => false);
        const action = !attempt.fresh && exists ? definition.resume : definition.run;
        stderr.write(`${attempt.finalRetry ? '最终重试' : '执行'}：${definition.label}（${attempt.runId}）\n`);
        const result = await runChild(definition, action, options, attempt.runId);
        const parsed = parseChildOutput(result.stdout);
        const reason = (parsed?.failures?.map(item => item.reason).join('；') || result.stderr || result.stdout || `退出码 ${result.code}`).trim();
        const linked = { ...compactResult(parsed), childRunId: attempt.runId };
        let ok = result.code === 0 && parsed?.ok !== false;
        let finalReason = reason;
        if (ok) {
          const items = await collectStageItems(config, state, { ...attempt.stage, key: definition.key, result: linked });
          const missing = items.filter(item => item.status !== 'passed');
          if (!items.length || missing.length) {
            ok = false;
            finalReason = missing.map(item => `${item.label}：${item.failure_reason}`).join('；') || '结果未确认：没有具体测试项证据';
          }
        }
        return { ok, result: linked, reason: finalReason };
      },
    });

    state.status = regressionComplete(state) ? "passed" : state.fatal_failure ? "blocked" : "failed";
    state.completed_at = new Date().toISOString();
    await writeRegressionJson(paths.state, state);
    await refreshReport(config, state, paths, { required: true });
    stdout.write(`${JSON.stringify(outputSummary(state, paths), null, 2)}\n`);
    if (state.status !== "passed") process.exitCode = 1;
  } catch (error) {
    state.status = state.fatal_failure ? "blocked" : "failed";
    state.execution_failure_reason = error.message;
    await writeRegressionJson(paths.state, state).catch(() => {});
    await refreshReport(config, state, paths).catch(() => {});
    throw error;
  }
}

main().catch((error) => {
  stderr.write(`AI 全量回归失败：${error.message}\n`);
  process.exitCode = 1;
});
