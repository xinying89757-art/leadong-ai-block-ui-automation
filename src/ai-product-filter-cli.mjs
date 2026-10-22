#!/usr/bin/env node
import { stdout, stderr } from "node:process";
import { loadConfig } from "./config.mjs";
import { LeadongEditor, launchEditorBrowser } from "./editor.mjs";
import { AiProductFilterAutomation } from "./ai-product-filter-runner.mjs";
import {
  createProductFilterState,
  newProductFilterRunId,
  productFilterPaths,
  readProductFilterJson,
  writeProductFilterJson,
} from "./ai-product-filter-state.mjs";

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
      settings: record.filter_settings,
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
  if (!["run", "resume", "status", "cleanup"].includes(command)) throw new Error(`未知产品筛选命令：${command}`);
  const config = await loadConfig(options.config ?? "config/run.json");
  const mode = config.ai.productFilterRegression;
  if (!mode?.enabled) throw new Error("产品筛选专项未启用");

  const pointer = productFilterPaths(config, "placeholder").active;
  const active = await readProductFilterJson(pointer);
  let runId;
  if (command === "run") {
    if (!options.apply) throw new Error("产品筛选专项会创建和发布页面，必须显式传 --apply");
    if (active?.runId && options.newRun !== true) {
      const previous = await readProductFilterJson(productFilterPaths(config, active.runId).state);
      if (previous && previous.page.cleanup_status !== "completed" && !previous.page.published_verified) {
        throw new Error(`产品筛选运行 ${active.runId} 尚未完成，请使用 resume、cleanup 或 --new-run`);
      }
    }
    runId = validateRunId(options.runId || newProductFilterRunId());
    const paths = productFilterPaths(config, runId);
    if (await readProductFilterJson(paths.state)) throw new Error(`运行 ID ${runId} 已存在，拒绝重复生成`);
    await writeProductFilterJson(paths.state, createProductFilterState(config, runId));
    await writeProductFilterJson(pointer, { runId, stateFile: paths.state });
  } else {
    if (command === "status" && !options.runId && !active?.runId) {
      output({ ok: false, command, message: "没有运行状态" });
      return;
    }
    runId = validateRunId(options.runId || active?.runId);
  }
  const paths = productFilterPaths(config, runId);
  if (command === "status") {
    const state = await readProductFilterJson(paths.state);
    output(state ? { ok: true, command, ...summary(state, paths) } : { ok: false, command, runId, message: "没有运行状态" });
    return;
  }
  if (!options.apply) throw new Error(`${command} 需显式传 --apply`);

  const { context, page } = await launchEditorBrowser(
    { ...config, ai: { ...config.ai, runId } },
    { headless: options.headless === true, isolatedProfile: false, slowMo: 0 },
  );
  try {
    const editor = new LeadongEditor(page, config);
    await editor.goto();
    const runner = new AiProductFilterAutomation(editor, config, runId);
    const state = command === "cleanup"
      ? await runner.cleanup()
      : await runner.run({ resume: command === "resume" });
    const ok = command === "cleanup"
      ? state.page.cleanup_status === "completed"
      : state.page.published_verified && state.types[0].filter_settings.apply_status === "succeeded";
    output({ ok, command, ...summary(state, paths) });
    if (!ok) process.exitCode = 1;
  } finally {
    await context.close();
  }
}

main().catch((error) => { stderr.write(`AI 产品筛选专项失败：${error.message}\n`); process.exitCode = 1; });
