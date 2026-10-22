#!/usr/bin/env node
import { stdout, stderr } from "node:process";
import { loadConfig } from "./config.mjs";
import { LeadongEditor, launchEditorBrowser } from "./editor.mjs";
import { AiNavigationAutomation } from "./ai-navigation-runner.mjs";
import {
  createNavigationState,
  navigationPaths,
  newNavigationRunId,
  readNavigationJson,
  writeNavigationJson,
} from "./ai-navigation-state.mjs";

function args(argv) {
  const options = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) { options._.push(token); continue; }
    const [rawKey, inlineValue] = token.slice(2).split("=", 2);
    const key = rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (inlineValue !== undefined) options[key] = inlineValue;
    else if (argv[index + 1] && !argv[index + 1].startsWith("--")) options[key] = argv[++index];
    else options[key] = true;
  }
  return options;
}

function output(value) { stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
function validateRunId(runId) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(runId ?? "")) throw new Error("run-id 只能包含字母、数字、横线和下划线，最长 80 字符");
  return runId;
}
function summary(state, paths) {
  const record = state.types[0];
  return {
    runId: state.run_id,
    stateFile: paths.state,
    page: state.page,
    record: {
      type: record.type,
      generation: record.generation_status,
      application: record.apply_status,
      polish: record.polish_status,
      navigation: record.navigation_settings,
      editorVerified: record.editor_verified,
      previewVerified: record.preview_verified,
      publishedVerified: record.published_verified,
      failureReason: record.failure_reason,
    },
  };
}

async function main() {
  const options = args(process.argv.slice(2));
  const command = options._[0] ?? "status";
  if (!["run", "resume", "status", "cleanup"].includes(command)) throw new Error(`未知导航命令：${command}`);
  const config = await loadConfig(options.config ?? "config/run.json");
  if (!config.ai.navigationRegression?.enabled) throw new Error("导航专项未启用");
  const pointer = navigationPaths(config, "placeholder").active;
  const active = await readNavigationJson(pointer);
  let runId;
  if (command === "run") {
    if (!options.apply) throw new Error("导航专项会创建和发布页面，必须显式传 --apply");
    if (active?.runId && options.newRun !== true) {
      const previous = await readNavigationJson(navigationPaths(config, active.runId).state);
      if (previous && previous.page.cleanup_status !== "completed" && !previous.page.published_verified) {
        throw new Error(`导航运行 ${active.runId} 尚未完成，请使用 resume、cleanup 或 --new-run`);
      }
    }
    runId = validateRunId(options.runId || newNavigationRunId());
    const paths = navigationPaths(config, runId);
    if (await readNavigationJson(paths.state)) throw new Error(`运行 ID ${runId} 已存在，拒绝重复生成`);
    await writeNavigationJson(paths.state, createNavigationState(config, runId));
    await writeNavigationJson(pointer, { runId, stateFile: paths.state });
  } else {
    if (command === "status" && !options.runId && !active?.runId) { output({ ok: false, command, message: "没有运行状态" }); return; }
    runId = validateRunId(options.runId || active?.runId);
  }
  const paths = navigationPaths(config, runId);
  if (command === "status") {
    const state = await readNavigationJson(paths.state);
    output(state ? { ok: true, command, ...summary(state, paths) } : { ok: false, command, runId, message: "没有运行状态" });
    return;
  }
  if (!options.apply) throw new Error(`${command} 需显式传 --apply`);
  const { context, page } = await launchEditorBrowser({ ...config, ai: { ...config.ai, runId } }, { headless: options.headless === true, isolatedProfile: false, slowMo: 0 });
  try {
    const editor = new LeadongEditor(page, config);
    await editor.goto();
    const runner = new AiNavigationAutomation(editor, config, runId);
    const state = command === "cleanup" ? await runner.cleanup() : await runner.run({ resume: command === "resume" });
    const ok = command === "cleanup" ? state.page.cleanup_status === "completed" : state.page.published_verified && state.page.public_navigation_verified;
    output({ ok, command, ...summary(state, paths) });
    if (!ok) process.exitCode = 1;
  } finally { await context.close(); }
}

main().catch((error) => { stderr.write(`AI 导航专项失败：${error.message}\n`); process.exitCode = 1; });
