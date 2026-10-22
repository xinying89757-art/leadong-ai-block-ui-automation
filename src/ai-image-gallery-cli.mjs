#!/usr/bin/env node
import path from "node:path";
import { stderr, stdout } from "node:process";
import { loadConfig } from "./config.mjs";
import { LeadongEditor, launchEditorBrowser } from "./editor.mjs";
import { AiImageGalleryAutomation } from "./ai-image-gallery-runner.mjs";
import { AiStateStore } from "./ai-state.mjs";
import { parseCliArgs } from "./cli-args.mjs";
import {
  assertImageGalleryState,
  imageGalleryPaths,
  imageGalleryPassed,
  imageGalleryResumeAction,
  imageGalleryScopedConfig,
  newImageGalleryRunId,
  readImageGalleryJson,
  summarizeImageGalleryState,
  writeImageGalleryJson,
} from "./ai-image-gallery-state.mjs";

function output(value) { stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
function validateRunId(value) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(value ?? "")) throw new Error("run-id 只能包含字母、数字、横线和下划线，最长 80 字符");
  return value;
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  const command = options._[0] ?? "status";
  if (!["run", "resume", "status"].includes(command)) throw new Error(`未知图片集专项命令：${command}`);
  const config = await loadConfig(options.config ?? "config/run.json");
  if (!config.ai.imageGalleryRegression?.enabled) throw new Error("AI 图片集专项未启用");
  const activePath = imageGalleryPaths(config, "placeholder").active;
  const active = await readImageGalleryJson(activePath);
  let runId;
  if (command === "run") {
    if (!options.apply) throw new Error("图片集专项会生成、保存并发布页面，必须显式传 --apply");
    if (active?.runId && !options["run-id"]) {
      const previous = await readImageGalleryJson(imageGalleryPaths(config, active.runId).state);
      if (previous && !imageGalleryPassed(previous)) throw new Error(`图片集专项 ${active.runId} 尚未完成，请先使用 ai:image-gallery:resume`);
    }
    runId = validateRunId(options["run-id"] || newImageGalleryRunId());
    const paths = imageGalleryPaths(config, runId);
    if (await readImageGalleryJson(paths.state)) throw new Error(`运行 ID ${runId} 已存在，拒绝重复生成`);
    await writeImageGalleryJson(activePath, { runId, stateFile: paths.state });
  } else {
    if (command === "status" && !options["run-id"] && !active?.runId) {
      output({ ok: false, command, initialized: false, message: "没有图片集专项运行状态" });
      return;
    }
    runId = validateRunId(options["run-id"] || active?.runId);
  }
  const paths = imageGalleryPaths(config, runId);
  if (command === "status") {
    const state = await readImageGalleryJson(paths.state);
    if (state) assertImageGalleryState(state, config, runId);
    output(state ? { ok: imageGalleryPassed(state), command, ...summarizeImageGalleryState(state, paths) }
      : { ok: false, command, runId, stateFile: paths.state, message: "没有图片集专项运行状态" });
    return;
  }
  if (!options.apply) throw new Error("恢复 AI 图片集专项需显式传 --apply");
  if (command === "resume") {
    const existing = await readImageGalleryJson(paths.state);
    if (!existing) throw new Error(`找不到图片集专项状态：${runId}`);
    assertImageGalleryState(existing, config, runId);
    const resumeAction = imageGalleryResumeAction(existing);
    if (resumeAction === "complete") {
      output({ ok: true, command, ...summarizeImageGalleryState(existing, paths) });
      return;
    }
    if (resumeAction === "retry-before-submit") {
      const record = existing.types[0];
      record.generation_status = "pending";
      record.apply_status = "pending";
      record.failure_reason = "";
      record.started_at = "";
      existing.page.type_failures = (existing.page.type_failures || []).filter(item => item.type !== "图片集");
      existing.page.failure_reason = "";
      await writeImageGalleryJson(paths.state, existing);
    }
  }
  const scoped = imageGalleryScopedConfig(config, runId, paths.state);
  const { context, page } = await launchEditorBrowser(scoped, {
    headless: options.headless === true,
    isolatedProfile: false,
    slowMo: 0,
  });
  let automation;
  try {
    const editor = new LeadongEditor(page, scoped);
    await editor.goto();
    await editor.waitForCanvasReady();
    await page.waitForTimeout(5000);
    automation = new AiImageGalleryAutomation(editor, scoped, new AiStateStore(paths.state), 1);
    const state = await automation.run({ maxTypes: 1, resume: command === "resume", publish: true });
    const ok = imageGalleryPassed(state);
    output({ ok, command, ...summarizeImageGalleryState(state, paths) });
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

main().catch(error => { stderr.write(`AI 图片集专项失败：${error.message}\n`); process.exitCode = 1; });
