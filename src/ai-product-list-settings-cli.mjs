#!/usr/bin/env node
import { stdout, stderr } from "node:process";
import { loadConfig } from "./config.mjs";
import { LeadongEditor, launchEditorBrowser } from "./editor.mjs";
import { AiProductListSettingsAutomation } from "./ai-product-list-settings-runner.mjs";
import {
  newProductListSettingsRunId,
  productListSettingsPaths,
  readProductListSettingsJson,
  seedProductListSettingsFromHistory,
  writeProductListSettingsJson,
} from "./ai-product-list-settings-state.mjs";

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
  const record = state.type;
  return {
    runId: state.run_id,
    stateFile: paths.state,
    page: state.page,
    record: {
      type: record.type,
      generation: record.generation_status,
      application: record.apply_status,
      polish: record.polish_status,
      historySourceRunId: record.history_source_run_id || "",
      applicationSource: record.application_source || "generated",
      historyMarker: record.history_marker,
      settingsStatus: record.settings_status,
      settingsOpened: record.settings_opened,
      settingsReopened: record.settings_reopened,
      settingsSaved: record.settings_saved,
      settings: record.settings,
      runAttempts: record.run_attempts || 0,
      lastRunDurationMs: record.last_run_duration_ms || 0,
      totalRunDurationMs: record.total_run_duration_ms || 0,
      frameSteps: record.frame_steps || [],
      frameDiagnostics: record.frame_diagnostics || [],
      editorVerified: record.editor_verified,
      previewVerified: record.preview_verified,
      publishedVerified: record.published_verified,
      failureReason: record.failure_reason || record.settings_failure_reason,
    },
  };
}

async function main() {
  const options = args(process.argv.slice(2));
  const command = options._[0] ?? "status";
  if (!["run", "resume", "status", "cleanup"].includes(command)) throw new Error(`未知产品列表设置命令：${command}`);
  const config = await loadConfig(options.config ?? "config/run.json");
  if (!config.ai.productListSettingsRegression?.enabled) throw new Error("产品列表设置专项未启用");
  if (options.productCategory || options.scopeOnly) {
    const mode = config.ai.productListSettingsRegression;
    mode.skipProductScope = false;
    mode.productScopeOnly = options.scopeOnly === true;
    mode.productScopeCategoryName = String(options.productCategory ?? "").trim();
    if (!mode.productScopeCategoryName) throw new Error("--scope-only 需同时指定 --product-category=<分类名>");
    mode.productScopeExpectedCount = options.expectedCategoryProducts === undefined
      ? undefined
      : Number(options.expectedCategoryProducts);
    if (mode.productScopeExpectedCount !== undefined && (!Number.isInteger(mode.productScopeExpectedCount) || mode.productScopeExpectedCount < 1)) {
      throw new Error("--expected-category-products 必须是正整数");
    }
    if (mode.productScopeOnly && command === "run" && !options.historyRunId) {
      throw new Error("产品数据单项运行必须通过 --history-run-id 复用已有生成记录，避免重新生成");
    }
  }

  const pointer = productListSettingsPaths(config, "placeholder").active;
  const active = await readProductListSettingsJson(pointer);
  let runId;
  if (command === "run") {
    if (!options.apply) throw new Error("产品列表设置专项会创建和发布页面，必须显式传 --apply");
    if (active?.runId && options.newRun !== true) {
      const previous = await readProductListSettingsJson(productListSettingsPaths(config, active.runId).state);
      if (previous && previous.page.cleanup_status !== "completed" && !previous.page.published_verified) {
        throw new Error(`产品列表设置运行 ${active.runId} 尚未完成，请使用 resume、cleanup 或 --new-run`);
      }
    }
    runId = validateRunId(options.runId || newProductListSettingsRunId());
    const paths = productListSettingsPaths(config, runId);
    if (await readProductListSettingsJson(paths.state)) throw new Error(`运行 ID ${runId} 已存在，拒绝重复生成`);
    const { createProductListSettingsState } = await import("./ai-product-list-settings-state.mjs");
    const state = createProductListSettingsState(config, runId);
    if (options.historyRunId) {
      const historyRunId = validateRunId(options.historyRunId);
      const historyState = await readProductListSettingsJson(productListSettingsPaths(config, historyRunId).state);
      seedProductListSettingsFromHistory(state, historyState, historyRunId);
    }
    await writeProductListSettingsJson(paths.state, state);
    await writeProductListSettingsJson(pointer, { runId, stateFile: paths.state });
  } else {
    if (command === "status" && !options.runId && !active?.runId) { output({ ok: false, command, message: "没有运行状态" }); return; }
    runId = validateRunId(options.runId || active?.runId);
  }

  const paths = productListSettingsPaths(config, runId);
  if (command === "status") {
    const state = await readProductListSettingsJson(paths.state);
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
    const runner = new AiProductListSettingsAutomation(editor, config, runId);
    const state = command === "cleanup"
      ? await runner.cleanup()
      : await runner.run({ resume: command === "resume" });
    const resultChecks = state.type.result_checks ?? {};
    const allowedChecks = ["sort", "loading_pagination", "page_size", "display_field", "base_color", "after_reopen"];
    const requestedSettingsVerified = allowedChecks.every((key) => resultChecks[key]?.status === "passed");
    const productScopeOnlyVerified = resultChecks.product_scope?.status === "passed"
      && resultChecks.preview?.status === "passed"
      && resultChecks.published?.status === "passed";
    const ok = command === "cleanup"
      ? state.page.cleanup_status === "completed"
      : state.page.published_verified && (productScopeOnlyVerified && config.ai.productListSettingsRegression.productScopeOnly === true || (
        state.type.settings_status === "succeeded"
        || (config.ai.productListSettingsRegression.skipProductScope === true
          && resultChecks.product_scope?.status === "skipped"
          && requestedSettingsVerified)
      ));
    output({ ok, command, ...summary(state, paths) });
    if (!ok) process.exitCode = 1;
  } finally {
    await context.close();
  }
}

main().catch((error) => { stderr.write(`AI 产品列表设置专项失败：${error.message}\n`); process.exitCode = 1; });
