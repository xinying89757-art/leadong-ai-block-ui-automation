#!/usr/bin/env node
import { stdout, stderr } from "node:process";
import { loadConfig } from "./config.mjs";
import { LeadongEditor, launchEditorBrowser } from "./editor.mjs";
import { AiArticleListSettingsAutomation } from "./ai-article-list-settings-runner.mjs";
import {
  articleListSettingsPaths,
  newArticleListSettingsRunId,
  readArticleListSettingsJson,
  writeArticleListSettingsJson,
} from "./ai-article-list-settings-state.mjs";
import { parseCliArgs } from "./cli-args.mjs";

const print = (value) => stdout.write(`${JSON.stringify(value, null, 2)}\n`);
const validRunId = (value) => {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(value ?? "")) throw new Error("run-id 只能包含字母、数字、横线和下划线，最长 80 字符");
  return value;
};

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  const command = options._[0] ?? "status";
  if (!["run", "resume", "status", "cleanup"].includes(command)) throw new Error(`未知文章列表设置命令：${command}`);
  const config = await loadConfig(options.config ?? "config/run.json");
  const mode = config.ai.articleListSettingsRegression;
  if (!mode?.enabled) throw new Error("文章列表设置专项未启用");
  const pointer = await readArticleListSettingsJson(articleListSettingsPaths(config, "placeholder").active);
  let runId = command === "run" ? validRunId(options["run-id"] || newArticleListSettingsRunId()) : validRunId(options["run-id"] || pointer?.runId);
  const paths = articleListSettingsPaths(config, runId);
  let state = await readArticleListSettingsJson(paths.state);
  if (command === "run") {
    if (!options.apply) throw new Error("文章列表专项会创建测试页并发布，必须显式传 --apply");
    if (state) throw new Error(`运行 ID ${runId} 已存在，拒绝重复生成`);
    const { createArticleListSettingsState } = await import("./ai-article-list-settings-state.mjs");
    state = createArticleListSettingsState(config, runId);
    await writeArticleListSettingsJson(paths.state, state);
    await writeArticleListSettingsJson(paths.active, { runId, stateFile: paths.state });
  }
  if (command === "status") {
    if (!state) { print({ ok: false, command, runId, message: "没有文章列表专项运行状态" }); return; }
    const record = state.type;
    print({ ok: true, command, runId, stateFile: paths.state, page: state.page, record: {
      generation: record.generation_status, application: record.apply_status, applicationSource: record.application_source || "",
      settings: record.settings, settingsStatus: record.settings_status, settingsPanel: record.settings_panel || null,
      resultChecks: record.result_checks, previewVerified: record.preview_verified, publishedVerified: record.published_verified,
      failureReason: record.failure_reason || record.settings_failure_reason || "",
    } });
    return;
  }
  if (!options.apply) throw new Error(`${command} 命令会操作站点，必须显式传 --apply`);
  const { context, page } = await launchEditorBrowser({ ...config, ai: { ...config.ai, runId } }, { headless: options.headless === true, isolatedProfile: false, slowMo: 0 });
  try {
    const editor = new LeadongEditor(page, config);
    await editor.goto();
    const runner = new AiArticleListSettingsAutomation(editor, config, runId);
    state = command === "cleanup" ? await runner.cleanup() : await runner.run({ resume: command === "resume", publish: true });
    const record = state.type;
    const checks = record.result_checks ?? {};
    const required = ["article_scope", "sort", "loading_pagination", "page_size", "display_field", "base_color", "after_reopen", "preview", "published"];
    const ok = required.every((key) => checks[key]?.status === "passed") && state.page.published_verified === true;
    print({ ok, command, runId, stateFile: paths.state, page: state.page, record: {
      generation: record.generation_status, application: record.apply_status, applicationSource: record.application_source || "generated",
      settings: record.settings, settingsStatus: record.settings_status, resultChecks: checks,
      previewVerified: record.preview_verified, publishedVerified: record.published_verified,
      failureReason: record.failure_reason || record.settings_failure_reason || "",
    } });
    if (!ok) process.exitCode = 1;
  } finally { await context.close().catch(() => {}); }
}

main().catch((error) => { stderr.write(`AI 文章列表设置专项失败：${error.message}\n`); process.exitCode = 1; });
