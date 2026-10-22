#!/usr/bin/env node
import path from "node:path";
import { stderr, stdout } from "node:process";
import { loadConfig } from "./config.mjs";
import { LeadongEditor, launchEditorBrowser } from "./editor.mjs";
import { AiCompositeRegressionAutomation } from "./ai-composite-runner.mjs";
import { AiStateStore } from "./ai-state.mjs";
import { parseCliArgs } from "./cli-args.mjs";
import {
  assertCompositeState,
  compositePassed,
  compositePaths,
  compositeResumeAction,
  compositeScopedConfig,
  newCompositeRunId,
  readCompositeJson,
  summarizeCompositeState,
  writeCompositeJson,
} from "./ai-composite-state.mjs";

function output(value) { stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
function validateRunId(value) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(value ?? "")) throw new Error("run-id 只能包含字母、数字、横线和下划线，最长 80 字符");
  return value;
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  const command = options._[0] ?? "status";
  if (!["run", "resume", "status"].includes(command)) throw new Error(`未知复合区块专项命令：${command}`);
  const config = await loadConfig(options.config ?? "config/run.json");
  if (!config.ai.compositeRegression?.enabled) throw new Error("AI 复合区块专项未启用");
  const activePath = compositePaths(config, "placeholder").active;
  const active = await readCompositeJson(activePath);
  let runId;
  if (command === "run") {
    if (!options.apply) throw new Error("复合区块专项会生成、保存并发布页面，必须显式传 --apply");
    if (active?.runId && !options["run-id"]) {
      const previous = await readCompositeJson(compositePaths(config, active.runId).state);
      if (previous && !compositePassed(previous, config)) throw new Error(`复合区块专项 ${active.runId} 尚未完成，请先使用 ai:composite:resume`);
    }
    runId = validateRunId(options["run-id"] || newCompositeRunId());
    const paths = compositePaths(config, runId);
    if (await readCompositeJson(paths.state)) throw new Error(`运行 ID ${runId} 已存在，拒绝重复生成`);
    await writeCompositeJson(activePath, { runId, stateFile: paths.state });
  } else {
    if (command === "status" && !options["run-id"] && !active?.runId) {
      output({ ok: false, command, initialized: false, message: "没有复合区块专项运行状态" });
      return;
    }
    runId = validateRunId(options["run-id"] || active?.runId);
  }

  const paths = compositePaths(config, runId);
  if (command === "status") {
    const state = await readCompositeJson(paths.state);
    if (state) assertCompositeState(state, config, runId);
    output(state ? { ok: compositePassed(state, config), command, ...summarizeCompositeState(state, paths) }
      : { ok: false, command, runId, stateFile: paths.state, message: "没有复合区块专项运行状态" });
    return;
  }
  if (!options.apply) throw new Error("恢复 AI 复合区块专项需显式传 --apply");
  let existing = null;
  if (command === "resume") {
    existing = await readCompositeJson(paths.state);
    if (!existing) throw new Error(`找不到复合区块专项状态：${runId}`);
    assertCompositeState(existing, config, runId);
    const action = compositeResumeAction(existing, config);
    if (action === "complete") {
      output({ ok: true, command, ...summarizeCompositeState(existing, paths) });
      return;
    }
    if (action === "retry-before-submit") {
      const record = existing.types[0];
      record.generation_status = "pending";
      record.apply_status = "pending";
      record.failure_reason = "";
      record.started_at = "";
      existing.page.type_failures = (existing.page.type_failures || []).filter(item => item.type !== config.ai.compositeRegression.type);
      existing.page.failure_reason = "";
      await writeCompositeJson(paths.state, existing);
    }
    if (action === "retry-explicit-failure") {
      const record = existing.types[0];
      record.generation_attempt_number = Number(record.generation_attempt_number || 1) + 1;
      record.generation_status = "pending";
      record.apply_status = "pending";
      record.failure_reason = "";
      record.generation_prompt = "";
      record.generation_record_id = "";
      record.generation_submitted_at = "";
      record.generation_submit_confirmed = false;
      record.generation_submission = null;
      record.last_record_status = "";
      record.generation_wait = null;
      record.started_at = "";
      record.generated_at = "";
      record.application_attempted = false;
      record.application_acknowledged = false;
      record.application_commit_confirmed = false;
      record.committed_block_id = "";
      record.recovery_required = false;
      existing.page.type_failures = (existing.page.type_failures || []).filter(item => item.type !== config.ai.compositeRegression.type);
      existing.page.failure_reason = "";
      await writeCompositeJson(paths.state, existing);
    }
  }

  const scoped = compositeScopedConfig(config, runId, paths.state);
  const { context, page } = await launchEditorBrowser(scoped, { headless: options.headless === true, isolatedProfile: false, slowMo: 0 });
  let automation;
  try {
    const editor = new LeadongEditor(page, scoped);
    await editor.goto();
    await editor.waitForCanvasReady();
    await page.waitForTimeout(5000);
    automation = new AiCompositeRegressionAutomation(editor, scoped, new AiStateStore(paths.state), 1);
    const state = await automation.run({ maxTypes: 1, resume: command === "resume", publish: true });
    const ok = compositePassed(state, config);
    output({ ok, command, ...summarizeCompositeState(state, paths) });
    if (!ok) process.exitCode = 1;
  } catch (error) {
    if (automation?.state) {
      automation.state.page.failure_reason = error.message;
      automation.state.page.failure_screenshot = path.join(paths.root, "failure.png");
      await automation.editor.page.screenshot({ path: automation.state.page.failure_screenshot, fullPage: false }).catch(() => {});
      await automation.persist().catch(() => {});
    }
    throw error;
  } finally {
    await context.close();
  }
}

main().catch(error => { stderr.write(`AI 复合区块专项失败：${error.message}\n`); process.exitCode = 1; });
