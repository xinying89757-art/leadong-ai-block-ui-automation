#!/usr/bin/env node
import { stderr, stdout } from "node:process";
import { loadConfig } from "./config.mjs";
import { LeadongEditor, launchEditorBrowser } from "./editor.mjs";
import { AiHistoryReuseAutomation } from "./ai-history-reuse-runner.mjs";
import { parseCliArgs } from "./cli-args.mjs";
import {
  createHistoryReuseState,
  historyReusePaths,
  newHistoryReuseRunId,
  readHistoryReuseJson,
  writeHistoryReuseJson,
} from "./ai-history-reuse-state.mjs";

function parseArgs(argv) {
  return parseCliArgs(argv);
}

function print(value) { stdout.write(`${JSON.stringify(value, null, 2)}\n`); }

function runIdOrThrow(value) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(value ?? "")) {
    throw new Error("run-id 只能包含字母、数字、横线和下划线，最长 80 字符");
  }
  return value;
}

function summary(state, paths) {
  return {
    runId: state.run_id,
    stateFile: paths.state,
    fullPage: state.full_page,
    block: state.block,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const command = options._[0] ?? "status";
  if (!["run", "resume", "status", "cleanup"].includes(command)) {
    throw new Error(`未知生成记录复用命令：${command}`);
  }
  const config = await loadConfig(options.config ?? "config/run.json");
  if (!config.ai.historyReuseRegression?.enabled) throw new Error("AI 生成记录复用回归未启用");
  const pointer = historyReusePaths(config, "placeholder").active;
  const active = await readHistoryReuseJson(pointer);
  let runId;
  if (command === "run") {
    if (!options.apply) throw new Error("生成记录复用回归需显式传 --apply");
    if (active?.runId && !options["run-id"] && options["new-run"] !== true) {
      const previous = await readHistoryReuseJson(historyReusePaths(config, active.runId).state);
      const complete = previous?.full_page?.page?.published_verified && previous?.block?.page?.published_verified;
      const cleaned = previous?.full_page?.page?.cleanup_status === "completed" && previous?.block?.page?.cleanup_status === "completed";
      if (previous && !complete && !cleaned) {
        throw new Error(`生成记录复用运行 ${active.runId} 尚未完成，请使用 resume 或 cleanup`);
      }
    }
    runId = runIdOrThrow(options["run-id"] || newHistoryReuseRunId());
    const paths = historyReusePaths(config, runId);
    if (await readHistoryReuseJson(paths.state)) throw new Error(`运行 ID ${runId} 已存在，拒绝重复生成`);
    await writeHistoryReuseJson(paths.state, createHistoryReuseState(config, runId));
    await writeHistoryReuseJson(pointer, { runId, stateFile: paths.state });
  } else {
    runId = runIdOrThrow(options["run-id"] || active?.runId);
  }
  const paths = historyReusePaths(config, runId);
  if (command === "status") {
    const state = await readHistoryReuseJson(paths.state);
    print(state ? { ok: true, command, ...summary(state, paths) } : { ok: false, command, runId, message: "没有运行状态" });
    return;
  }
  if (!options.apply) throw new Error("恢复或清理需显式传 --apply");
  const runtimeConfig = { ...config, ai: { ...config.ai, runId } };
  const { context, page } = await launchEditorBrowser(runtimeConfig, {
    headless: options.headless === true,
    isolatedProfile: false,
    slowMo: 0,
  });
  try {
    const editor = new LeadongEditor(page, runtimeConfig);
    await editor.goto();
    const runner = new AiHistoryReuseAutomation(editor, runtimeConfig, runId);
    const state = command === "cleanup" ? await runner.cleanup() : await runner.run();
    const ok = command === "cleanup"
      ? state.full_page.page.cleanup_status === "completed" && state.block.page.cleanup_status === "completed"
      : state.full_page.page.published_verified && state.block.page.published_verified &&
        state.full_page.history.application_source === "history" && state.block.history.application_source === "history";
    print({ ok, command, ...summary(state, paths) });
    if (!ok) process.exitCode = 1;
  } finally {
    await context.close().catch(() => {});
  }
}

main().catch((error) => {
  stderr.write(`AI 生成记录复用回归失败：${error.message}\n`);
  process.exitCode = 1;
});
