#!/usr/bin/env node
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { loadConfig } from "./config.mjs";
import { LeadongEditor, launchEditorBrowser } from "./editor.mjs";
import { AiComboSystemPageAutomation } from "./ai-combo-system-runner.mjs";
import { AiStateStore } from "./ai-state.mjs";
import { parseCliArgs } from "./cli-args.mjs";
import { compositePaths, compositeScopedConfig, readCompositeJson, writeCompositeJson } from "./ai-composite-state.mjs";
import { compositeSelectionValid } from "./ai-composite-runner.mjs";
import { categorySystemPageFor, snapshotSystemPageBlocks, assertSystemPageRestored } from "./ai-system-page-snapshot.mjs";

const combos = {
  product_pair: ["产品列表", "产品分类"],
  article_pair: ["文章列表", "文章分类"],
  three_type: ["产品列表", "产品分类", "文章列表"],
};
function reportPath(runId) { return path.resolve("reports", "ai-combo", runId); }
function render(state) {
  const record = state.types?.[0] ?? {};
  return `# AI combo: ${state.run_id}\n\nAssertions: ${state.combo_assertions_status ?? "FAIL"}\n\nPreview: ${state.combo_preview_status ?? "not-applicable"}\n\nOverall: ${state.combo_overall ?? "FAIL"}\n\nDuration: ${state.duration_ms ?? "running"} ms\n\nPage: ${state.page?.name ?? ""} (${state.page?.page_type ?? "custom"})\n\nCategory routing: ${JSON.stringify(state.page?.category_routing ?? null)}\n\nSystem page restored: ${state.page?.restored === true ? "PASS" : state.page?.page_type === "system" ? "pending/FAIL" : "not-applicable"}\n\nSelection: ${JSON.stringify(record.composite_selection ?? null)}\n\nGeneration: ${record.generation_status}; attempts: ${JSON.stringify(record.generation_attempts ?? [])}\n\nPoints: ${record.combo_points_before ?? "?"} → ${record.combo_points_after ?? "?"} (${record.combo_points_charged ?? "?"}); history badge: ${record.combo_history_before ?? "?"} → ${record.combo_history_after ?? "?"}; usage badge: ${record.combo_history_record?.points ?? "?"}\n\nSub-block DOM: ${JSON.stringify(record.combo_subblock_dom ?? null)}\n\nSave/reopen: ${record.combo_reopen_verified === true ? "PASS" : "pending"}\n\nPublishing: not performed.\n\nFailure: ${state.page?.failure_reason || record.failure_reason || ""}\n`;
}
async function persistReport(state, paths) {
  await writeCompositeJson(paths.state, state);
  const dir = reportPath(state.run_id); await mkdir(dir, { recursive: true });
  await writeCompositeJson(path.join(dir, "report.json"), state);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path.join(dir, "report.md"), render(state));
}
function scopedForCombo(config, runId, stateFile, comboKey, modeKey) {
  const dynamicTypes = combos[comboKey];
  if (!dynamicTypes) throw new Error("combo must be product_pair, article_pair, or three_type");
  const scoped = compositeScopedConfig(config, runId, stateFile);
  const mode = scoped.ai.generationModes.find(item => item.key === modeKey);
  if (!mode) throw new Error(`Unsupported generation mode: ${modeKey}`);
  scoped.ai.compositeRegression.generationMode = mode.label;
  scoped.ai.compositeRegression.dynamicTypes = [...dynamicTypes];
  scoped.ai.compositeRegression.maxGenerationAttempts = 3;
  const body = dynamicTypes.includes("文章列表")
    ? "Include an English solar hero, a product catalog section, product category navigation, and an article/news list with titles, summaries and dates."
    : "Include an English solar hero, product cards, and product category navigation with category imagery and labels.";
  scoped.ai.prompts["复合区块"] = `Create a cohesive English solar company composite block. ${body} Ensure each selected component is a separate, editable, populated section.`;
  return scoped;
}
function routeFor(config, comboKey) { return categorySystemPageFor(combos[comboKey], config.ai.categorySystemPages); }
function checkState(state, config, runId, comboKey) {
  const route = routeFor(config, comboKey);
  if (!state || state.run_id !== runId || state.site_name !== config.siteName || state.site_language !== config.siteLanguage ||
    state.types?.length !== 1 || state.types[0].type !== config.ai.compositeRegression.type ||
    !(state.page?.page_type === "system" ? state.page?.name === route.systemPage && state.page?.path === `system:${route.systemPage}` :
      state.page?.name === `${config.ai.compositeRegression.pageNamePrefix}001-${runId}` && state.page?.path === `/${config.ai.compositeRegression.pagePathPrefix}001-${runId}`) ||
    !compositeSelectionValid(state.types[0].composite_selection, combos[comboKey])) throw new Error("Combo state identity/selection mismatch");
}
async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const command = args._[0] ?? "status";
  if (!["run", "resume", "status", "cleanup"].includes(command)) throw new Error("Unknown ai:combo command");
  if (command !== "status" && args.apply !== true) throw new Error(`${command} requires --apply`);
  const comboKey = args.combo ?? "product_pair";
  if (!combos[comboKey]) throw new Error("combo must be product_pair, article_pair, or three_type");
  const config = await loadConfig(args.config ?? "config/run.json");
  const runId = args["run-id"] ?? `combo-${comboKey}-${new Date().toISOString().replace(/[-:.TZ]/g, "")}`;
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(runId)) throw new Error("Invalid run-id");
  const paths = compositePaths(config, runId);
  const current = await readCompositeJson(paths.state);
  const route = routeFor(config, comboKey);
  const savedMode = current?.types?.[0]?.generation_attempts?.[0]?.generation_mode;
  const configuredMode = args.mode ?? (savedMode ? config.ai.generationModes.find(item => item.label === savedMode)?.key : undefined);
  const modeKey = configuredMode || config.ai.generationModes.find(item => item.label === config.ai.compositeRegression.generationMode)?.key;
  if (command === "status") {
    if (!current) throw new Error("No combo state");
    checkState(current, config, runId, comboKey);
    console.log(JSON.stringify({ runId, combo: comboKey, assertions_status: current.combo_assertions_status ?? "FAIL",
      preview_status: current.combo_preview_status ?? "not-applicable", overall: current.combo_overall ?? "FAIL",
      durationMs: current.duration_ms, page: current.page.name, points: current.types[0].combo_points_charged,
      pageType: current.page.page_type ?? "custom", systemPage: current.page.page_type === "system" ? current.page.name : undefined,
      restored: current.page.restored ?? false, report: reportPath(runId) }, null, 2)); return;
  }
  if (command === "cleanup") {
    if (!current) throw new Error("No combo state"); checkState(current, config, runId, comboKey);
    const scoped = scopedForCombo(config, runId, paths.state, comboKey, modeKey);
    const { context, page } = await launchEditorBrowser(scoped, { headless: true, isolatedProfile: false });
    try {
      const editor = new LeadongEditor(page, scoped); await editor.goto();
      if (current.page.page_type === "system") {
        await editor.openSystemPage(current.page.name);
        const identity = await editor.currentPageIdentity();
        if (identity.name !== current.page.name || identity.id !== current.page.target_identity?.id) throw new Error("System page identity mismatch; refusing cleanup");
        const beforeCleanup = await snapshotSystemPageBlocks(editor.canvasContexts());
        const baseline = current.page.system_page_snapshot;
        if (!baseline) throw new Error("Missing system page baseline snapshot; refusing cleanup");
        const ownId = current.ownership?.identity?.id;
        if (ownId && current.ownership.status !== "removed") {
          const wrappers = await editor.describeAiBlockWrappers();
          const matches = wrappers.filter(item => item.identity.id === ownId);
          if (matches.length > 1) throw new Error("Owned block identity is ambiguous; refusing cleanup");
          if (matches.length === 1) {
            const result = await editor.deleteAiBlock({ identity: current.ownership.identity, apply: true });
            if (!result.applied) throw new Error("Owned system-page block removal was not confirmed");
            await editor.savePage();
          }
        }
        const after = await snapshotSystemPageBlocks(editor.canvasContexts());
        assertSystemPageRestored(baseline, after);
        current.page.cleanup_status = "completed"; current.page.restored = true; current.page.restored_snapshot = after;
        current.cleanup_snapshot_before = beforeCleanup;
      } else {
        const receipt = current.page.creation_receipt;
        if (!receipt?.id || receipt.name !== current.page.name || receipt.path !== current.page.path) throw new Error("Missing owned page receipt; refusing cleanup");
        const identity = await editor.openCustomPage(current.page.name);
        if (identity?.id !== receipt.id) throw new Error("Owned page identity mismatch; refusing cleanup");
        const result = await editor.deleteCustomPage(current.page.name, { apply: true });
        if (!result.applied) throw new Error("Owned page deletion was not confirmed");
        current.page.cleanup_status = "completed";
      }
      await persistReport(current, paths);
      console.log(JSON.stringify({ ok: true, runId, page: current.page.name, cleanup: "completed" }));
    } finally { await context.close(); }
    return;
  }
  if (command === "run" && current) throw new Error("Run ID exists; use resume");
  if (command === "resume" && !current) throw new Error("No combo state to resume");
  const scoped = scopedForCombo(config, runId, paths.state, comboKey, modeKey);
  scoped.ai.runId = runId;
  scoped.ai.compositeRegression.pageNamePrefix = "system-combo-";
  scoped.ai.compositeRegression.pagePathPrefix = "system-combo-";
  scoped.ai.compositeRegression.dynamicTypes = [...combos[comboKey]];
  if (current) checkState(current, config, runId, comboKey);
  const { context, page } = await launchEditorBrowser(scoped, { headless: true, isolatedProfile: false });
  const started = Date.now(); let automation;
  try {
    const editor = new LeadongEditor(page, scoped); await editor.goto(); await editor.waitForCanvasReady();
    automation = new AiComboSystemPageAutomation(editor, scoped, new AiStateStore(paths.state), 1, route.systemPage);
    const originalPersist = automation.persist.bind(automation);
    automation.persist = async () => { await originalPersist(); automation.state.duration_ms = (current?.duration_ms ?? 0) + Date.now() - started; await persistReport(automation.state, paths); };
    const result = await automation.runUnpublished({ resume: command === "resume" });
    result.page.category_routing = { category: route.category, system_page: route.systemPage, rule: "first category type in combo order" };
    result.duration_ms = (current?.duration_ms ?? 0) + Date.now() - started;
    await persistReport(result, paths);
    console.log(JSON.stringify({ ok: result.combo_assertions_status === "PASS", runId, combo: comboKey,
      assertions_status: result.combo_assertions_status, preview_status: result.combo_preview_status, overall: result.combo_overall,
      durationMs: result.duration_ms, points: result.types[0].combo_points_charged, pageType: "system", page: route.systemPage,
      restored: result.page.restored === true, report: reportPath(runId) }, null, 2));
    if (result.combo_assertions_status !== "PASS") process.exitCode = 1;
  } catch (error) {
    if (automation?.state) {
      automation.state.status = "failed"; automation.state.combo_assertions_status = "FAIL";
      automation.state.combo_preview_status = automation.state.page.preview_verified ? "passed" : "blocked-environment";
      automation.state.combo_overall = "FAIL"; automation.state.page.failure_reason = error.message;
      automation.state.duration_ms = (current?.duration_ms ?? 0) + Date.now() - started;
      await persistReport(automation.state, paths).catch(() => {});
    }
    throw error;
  } finally { await context.close(); }
}
main().catch(error => { console.error(`AI combo failed: ${error.message}`); process.exitCode = 1; });
