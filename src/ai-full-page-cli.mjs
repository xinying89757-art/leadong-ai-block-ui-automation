#!/usr/bin/env node
import { stderr, stdout } from "node:process";
import { loadConfig } from "./config.mjs";
import { LeadongEditor, launchEditorBrowser } from "./editor.mjs";
import { AiFullPageAutomation } from "./ai-full-page-runner.mjs";
import { parseCliArgs } from "./cli-args.mjs";
import { executeFullPageAttempts, fullPageSummary as summary } from "./ai-full-page-result.mjs";
import {
  createFullPageState,
  fullPagePaths,
  newFullPageRunId,
  readFullPageJson,
  writeFullPageJson,
} from "./ai-full-page-state.mjs";

function parseArgs(argv) {
  return parseCliArgs(argv);
}

function print(value) { stdout.write(`${JSON.stringify(value, null, 2)}\n`); }

function runIdOrThrow(value) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(value ?? "")) throw new Error("run-id 只能包含字母、数字、横线和下划线，最长 80 字符");
  return value;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const command = options._[0] ?? "status";
  if (!["run", "resume", "status", "cleanup"].includes(command)) throw new Error(`未知整页命令：${command}`);
  const config = await loadConfig(options.config ?? "config/run.json");
  if (!config.ai.fullPageRegression?.enabled) throw new Error("AI 整页回归未启用");
  const pointer = fullPagePaths(config, "placeholder").active;
  const active = await readFullPageJson(pointer);
  let runId;
  if (command === "run") {
    if (!options.apply) throw new Error("整页生成需显式传 --apply");
    const explicitNewRun = options["new-run"] === true;
    if (active?.runId && !options["run-id"]) {
      const previous = await readFullPageJson(fullPagePaths(config, active.runId).state);
      const explicitFailedRetry = options["retry-failed"] === true &&
        previous?.generation.generation_status === "failed" && previous?.page.create_status === "pending";
      const explicitUnconfirmedRetry = options["retry-unconfirmed"] === true &&
        previous?.generation.generation_status === "uncertain" && previous?.page.create_status === "pending";
      if (previous && !previous.page.published_verified && previous.page.cleanup_status !== "completed" && !explicitFailedRetry && !explicitUnconfirmedRetry && !explicitNewRun) {
        throw new Error(`整页运行 ${active.runId} 尚未完成，请使用 resume 或 cleanup`);
      }
    }
    runId = runIdOrThrow(options["run-id"] || newFullPageRunId());
    const paths = fullPagePaths(config, runId);
    if (await readFullPageJson(paths.state)) throw new Error(`运行 ID ${runId} 已存在，拒绝重复生成`);
    await writeFullPageJson(paths.state, createFullPageState(config, runId));
    await writeFullPageJson(pointer, { runId, stateFile: paths.state });
  } else runId = runIdOrThrow(options["run-id"] || active?.runId);
  const paths = fullPagePaths(config, runId);
  if (command === "status") {
    const state = await readFullPageJson(paths.state);
    print(state ? { ok: true, command, ...summary(state, paths) } : { ok: false, command, runId, message: "没有运行状态" });
    return;
  }
  if (!options.apply) throw new Error("恢复或清理需显式传 --apply");
  async function execute(targetRunId, targetPaths) {
    const { context, page } = await launchEditorBrowser(
      { ...config, ai: { ...config.ai, runId: targetRunId } },
      // Reuse the login profile created by `npm run login` so repeated
      // regression runs do not ask for credentials again.
      { headless: options.headless === true, isolatedProfile: false, slowMo: 0 },
    );
    try {
      const editor = new LeadongEditor(page, config);
      await editor.goto();
      const runner = new AiFullPageAutomation(editor, config, targetRunId);
      return command === "cleanup" ? await runner.cleanup() : await runner.run();
    } finally { await context.close().catch(() => {}); }
  }

  const result = await executeFullPageAttempts({ config, command, options, runId, execute,
    warn: (message) => stderr.write(`${message}\n`),
  });
  print(result);
  if (!result.ok) {
    if (result.failures?.length) stderr.write(`AI 整页回归失败：${result.failures[0].reason}\n`);
    process.exitCode = 1;
  }
}

main().catch((error) => { stderr.write(`AI 整页回归失败：${error.message}\n`); process.exitCode = 1; });
