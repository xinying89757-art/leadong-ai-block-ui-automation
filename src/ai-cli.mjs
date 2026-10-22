#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { stdout, stderr } from "node:process";
import { loadConfig } from "./config.mjs";
import { LeadongEditor, launchEditorBrowser } from "./editor.mjs";
import { AiPagedAutomation } from "./ai-paged-runner.mjs";
import { AiStateStore, summarizeAiState } from "./ai-state.mjs";
import { isGlobalSafetyFailure } from "./ai-regression-state.mjs";
import { AiDetailAutomation, cleanupOwnedDetail, detailStatePath } from "./ai-detail-runner.mjs";
import { DetailContentBrowser } from "./ai-detail-content.mjs";
import {
  backupLifecycle,
  cleanupLifecycle,
  createRunId,
  lifecycleStatus,
  loadActiveLifecycle,
  prepareLifecycle,
  restoreLifecycle,
} from "./ai-lifecycle.mjs";

function parseArgs(argv) {
  const options = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      options._.push(token);
      continue;
    }
    const [rawKey, inlineValue] = token.slice(2).split("=", 2);
    const key = rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (inlineValue !== undefined) options[key] = inlineValue;
    else if (argv[index + 1] && !argv[index + 1].startsWith("--")) options[key] = argv[++index];
    else options[key] = true;
  }
  return options;
}

function output(value) {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function applyIsolatedRunConfig(config, runId) {
  config.ai.runId = runId;
  config.ai.isolatedPages = true;
  // aiPageDescriptor appends the sanitized run id once when isolatedPages is
  // enabled; keep the configured base prefixes unchanged.
  const runRoot = path.join(config.paths.aiLifecycleDir, "runs", runId);
  config.paths.aiDetailLegacyStateDir ??= config.paths.aiDetailStateDir;
  config.paths.aiStateFile = path.join(runRoot, "ai-state.json");
  config.paths.aiRemainingStateDir = path.join(runRoot, "ai-remaining");
  config.paths.aiDetailStateDir = path.join(runRoot, "ai-detail");
  return config;
}

async function status(config) {
  try {
    const state = JSON.parse(await readFile(config.paths.aiStateFile, "utf8"));
    output({ initialized: true, stateFile: config.paths.aiStateFile, ...summarizeAiState(state) });
  } catch (error) {
    if (error.code === "ENOENT") output({ initialized: false, stateFile: config.paths.aiStateFile, message: "尚无 AI 运行状态" });
    else throw error;
  }
}

async function run(config, command, options) {
  if (!options.apply) throw new Error(`${command} 会创建/应用 AI 区块，必须显式传 --apply`);
  const maxTypes = command === "poc" ? 1 : config.ai.blocksPerPage;
  const { context, page } = await launchEditorBrowser(config, {
    headless: options.headless === true,
    slowMo: 0,
    isolatedProfile: false,
  });
  try {
    const editor = new LeadongEditor(page, config);
    await editor.goto();
    const automation = new AiPagedAutomation(editor, config);
    const state = await automation.run({
      maxTypes,
      resume: command === "resume",
      publish: command !== "poc",
    });
    const ok = !state.page.type_failures?.length;
    output({ ok, command, stateFile: config.paths.aiStateFile, ...summarizeAiState(state), failures: state.page.type_failures ?? [] });
    if (!ok) process.exitCode = 1;
  } finally {
    await context.close();
  }
}

function continuationStatePath(config, page) {
  return path.join(
    config.paths.aiRemainingStateDir,
    `page-${String(page.number).padStart(3, "0")}.json`,
  );
}

function pageConfig(config, page) {
  return {
    ...config,
    ai: {
      ...config.ai,
      blocksPerPage: page.types.length,
      types: [...page.types],
      followupPages: [],
    },
    paths: {
      ...config.paths,
      aiStateFile: continuationStatePath(config, page),
    },
  };
}

async function runRemaining(config, command, options) {
  if (!options.apply) throw new Error(`${command} 会创建/应用 AI 区块，必须显式传 --apply`);
  const pages = config.ai.followupPages ?? [];
  if (pages.length === 0) throw new Error("配置中没有 AI 后续页面");
  const { context, page } = await launchEditorBrowser(config, {
    headless: options.headless === true,
    slowMo: 0,
    isolatedProfile: false,
  });
  const results = [];
  try {
    const editor = new LeadongEditor(page, config);
    await editor.goto();
    for (const descriptor of pages) {
      const scopedConfig = pageConfig(config, descriptor);
      // A resumed full run may revisit the continuation pages in order. Do
      // not reopen an already completed page just to discover it is done; the
      // page selector can still be on the following page after a prior
      // process, which makes a redundant switch look like a timeout.
      if (command === "remaining:resume") {
        try {
          const existing = JSON.parse(await readFile(scopedConfig.paths.aiStateFile, "utf8"));
          if (existing.page?.saved && existing.page?.preview_verified && existing.page?.published_verified &&
              existing.page.types?.length === descriptor.types.length && !existing.page.type_failures?.length &&
              existing.types?.every((record) => record.editor_verified &&
                (record.type !== '产品筛选' || record.filter_settings?.public_display_verified === true))) {
            results.push({
              page: descriptor.number,
              stateFile: scopedConfig.paths.aiStateFile,
              ...summarizeAiState(existing),
            });
            continue;
          }
        } catch {
          // Missing or malformed state is handled by the normal automation
          // path, which will stop safely instead of guessing.
        }
      }
      // Each continuation page starts from a clean 3.0 shell. A prior AI
      // dialog/full-page editor can leave the page selector on a different
      // page even after its process exits; reloading the canonical editor
      // URL makes the subsequent page switch deterministic.
      await editor.goto();
      await editor.waitForCanvasReady().catch(() => {});
      const automation = new AiPagedAutomation(
        editor,
        scopedConfig,
        new AiStateStore(scopedConfig.paths.aiStateFile),
        descriptor.number,
      );
      try {
        const state = await automation.run({
          maxTypes: descriptor.types.length,
          resume: command === "remaining:resume",
          publish: true,
        });
        results.push({ page: descriptor.number, stateFile: scopedConfig.paths.aiStateFile,
          ok: !state.page.type_failures?.length, ...summarizeAiState(state), failures: state.page.type_failures ?? [] });
      } catch (error) {
        if (isGlobalSafetyFailure(error.message)) throw error;
        // A page-level count/render failure must not skip page 003's filter
        // and navigation. Persist the failed page, then start the next page.
        if (automation.state) {
          automation.state.page.failure_reason = error.message;
          await automation.persist();
        }
        results.push({ page: descriptor.number, stateFile: scopedConfig.paths.aiStateFile,
          ok: false, failure_reason: error.message,
          ...(automation.state ? summarizeAiState(automation.state) : {}) });
      }
    }
  } finally {
    await context.close();
  }
  const ok = results.every((result) => result.ok !== false);
  output({ ok, command, pages: results, failures: results.filter((result) => result.ok === false).map((result) => ({
    page: result.page, stateFile: result.stateFile,
    reason: result.failure_reason || result.failures?.map((failure) => failure.reason).join("；") || "页面必要链路未通过",
  })) });
  if (!ok) process.exitCode = 1;
}

async function remainingStatus(config) {
  const pages = [];
  for (const descriptor of config.ai.followupPages ?? []) {
    const stateFile = continuationStatePath(config, descriptor);
    try {
      const state = JSON.parse(await readFile(stateFile, "utf8"));
      pages.push({ page: descriptor.number, stateFile, ...summarizeAiState(state) });
    } catch (error) {
      if (error.code === "ENOENT") pages.push({ page: descriptor.number, stateFile, initialized: false });
      else throw error;
    }
  }
  output({ pages });
}

async function detailStatus(config) {
  const pages = [];
  const configured = new Set((config.ai.detailPages ?? []).map((detail) => detail.type));
  const uncovered = (config.ai.excludedTypes ?? [])
    .filter((type) => type.includes("详情") && !configured.has(type))
    .map((type) => ({ type, reason: "系统页 AI 类型菜单当前未提供，按用户选择暂不覆盖" }));
  for (const detail of config.ai.detailPages ?? []) {
    const stateFile = detailStatePath(config, detail);
    const state = await new AiStateStore(stateFile).load();
    pages.push(state
      ? { type: detail.type, systemPage: detail.systemPage, stateFile, ...summarizeAiState(state) }
      : { type: detail.type, systemPage: detail.systemPage, stateFile, initialized: false });
  }
  output({ pages, uncovered });
}

async function lifecycleCommand(config, command, options) {
  const active = await loadActiveLifecycle(config);
  const runId = options.runId || active?.runId;
  if (command === "lifecycle:prepare") {
    const manifest = await prepareLifecycle(config, options.runId || createRunId());
    output({ ok: true, command, runId: manifest.runId, manifest });
    return;
  }
  if (!runId && command === "lifecycle:status") {
    output({ ok: true, command, ...(await lifecycleStatus(config)) });
    return;
  }
  if (!runId) throw new Error(`${command} 找不到 runId，请先执行 npm run ai:prepare`);
  if (["lifecycle:backup", "lifecycle:cleanup", "lifecycle:restore"].includes(command) && !options.apply && command !== "lifecycle:backup") {
    throw new Error(`${command} 会恢复或清理本地状态，必须显式传 --apply`);
  }
  const manifest = command === "lifecycle:backup"
    ? await backupLifecycle(config, runId)
    : command === "lifecycle:cleanup"
      ? await cleanupLifecycle(config, runId)
      : command === "lifecycle:restore"
        ? await restoreLifecycle(config, runId)
        : await lifecycleStatus(config, runId);
  output({ ok: true, command, runId, ...manifest && command === "lifecycle:status" ? manifest : { manifest } });
}

async function runDetail(config, command, options) {
  if (!options.apply) throw new Error(`${command} 会修改并发布系统详情页，必须显式传 --apply`);
  const { context, page } = await launchEditorBrowser(config, {
    headless: options.headless === true,
    slowMo: 0,
    isolatedProfile: false,
  });
  const results = [];
  const failures = [];
  const content = new DetailContentBrowser(context, config);
  try {
    const editor = new LeadongEditor(page, config);
    await editor.goto();
    for (const detail of config.ai.detailPages ?? []) {
      if (command === "detail:cleanup") {
        try {
          results.push(await cleanupOwnedDetail(editor, config, detail, { publish: true }));
        } catch (error) {
          failures.push({ type: detail.type, systemPage: detail.systemPage, reason: error.message });
          results.push({ type: detail.type, systemPage: detail.systemPage, failed: true, reason: error.message });
        }
        continue;
      }
      const stateFile = detailStatePath(config, detail);
      const store = new AiStateStore(stateFile);
      try {
        const previous = await store.load();
        const item = previous ? null : await content.findPublishedDetail(detail);
        const automation = new AiDetailAutomation(editor, config, detail, item, store);
        const state = await automation.run();
        results.push({ type: detail.type, systemPage: detail.systemPage, stateFile, ...summarizeAiState(state) });
      } catch (error) {
        if (isGlobalSafetyFailure(error.message)) throw error;
        failures.push({ type: detail.type, systemPage: detail.systemPage, reason: error.message });
        results.push({ type: detail.type, systemPage: detail.systemPage, stateFile, failed: true, reason: error.message });
      }
    }
  } finally {
    await content.close();
    await context.close();
  }
  output({ ok: failures.length === 0, command, pages: results, failures });
  if (failures.length > 0) process.exitCode = 1;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const command = options._[0] ?? "help";
  if (command === "help" || options.help) {
  stdout.write(`AI 区块自动化命令：
  npm run ai:poc
  npm run ai:add
  npm run ai:resume
  npm run ai:status
  npm run ai:remaining
  npm run ai:remaining:resume
  npm run ai:remaining:status
  npm run ai:detail
  npm run ai:detail:resume
  npm run ai:detail:status
  npm run ai:detail:cleanup -- --apply
  npm run ai:prepare
  npm run ai:backup
  npm run ai:cleanup -- --apply
  npm run ai:restore -- --apply
  npm run ai:lifecycle:status

可追加 --headless、--config config/run.json。
`);
    return;
  }
  let config = await loadConfig(options.config ?? "config/run.json");
  const activeLifecycle = await loadActiveLifecycle(config);
  const explicitRunId = options.runId;
  if (explicitRunId) {
    config = applyIsolatedRunConfig(config, explicitRunId);
  } else if (activeLifecycle?.runId) {
    const isolatedCommands = [
      "poc", "add", "resume", "status",
      "remaining", "remaining:resume", "remaining:status",
      "detail", "detail:resume", "detail:status", "detail:cleanup",
    ];
    config = isolatedCommands.includes(command)
      ? applyIsolatedRunConfig(config, activeLifecycle.runId)
      : Object.assign(config, { ai: { ...config.ai, runId: activeLifecycle.runId } });
  }
  if (["lifecycle:prepare", "lifecycle:backup", "lifecycle:cleanup", "lifecycle:restore", "lifecycle:status"].includes(command)) {
    return lifecycleCommand(config, command, options);
  }
  if (command === "status") return status(config);
  if (command === "remaining:status") return remainingStatus(config);
  if (command === "detail:status") return detailStatus(config);
  if (["detail", "detail:resume", "detail:cleanup"].includes(command)) return runDetail(config, command, options);
  if (["remaining", "remaining:resume"].includes(command)) return runRemaining(config, command, options);
  if (!["poc", "add", "resume"].includes(command)) throw new Error(`未知 AI 命令：${command}`);
  return run(config, command, options);
}

main().catch((error) => {
  stderr.write(`\nAI 区块自动化失败：${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
