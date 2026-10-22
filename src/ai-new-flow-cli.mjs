import { loadConfig } from './config.mjs';
import { LeadongEditor, launchEditorBrowser } from './editor.mjs';
import { ensureAuthenticated, dismissBlockingModals } from './auth.mjs';
import { parseCliArgs } from './cli-args.mjs';
import { assertFlowState, createExclusiveFlowState, createFlowState, flowPaths, readFlowJson, validateRunId, writeFlowJson } from './ai-new-flow-state.mjs';
export async function runNewFlowCli(flow, Runner, argv = process.argv.slice(2)) {
  const args = parseCliArgs(argv), command = args._[0] ?? 'status';
  if (!['run', 'resume', 'status', 'cleanup'].includes(command)) throw new Error('Unknown command');
  if (command !== 'status' && args.apply !== true) throw new Error(`${command} requires --apply`);
  const config = await loadConfig(args.config ?? 'config/run.json');
  const pointer = flowPaths(config, flow, 'placeholder').active;
  const active = await readFlowJson(pointer);
  const runId = validateRunId(args['run-id'] ?? (command === 'run' ? `${flow}-${new Date().toISOString().replace(/[-:.TZ]/g, '')}` : active?.runId));
  const paths = flowPaths(config, flow, runId);
  if (command === 'run') {
    if (await readFlowJson(paths.state)) throw new Error(`Run ${runId} already exists; use resume`);
    if (active?.runId && !args['run-id'] && !args['new-run']) {
      const previous = await readFlowJson(flowPaths(config, flow, validateRunId(active.runId)).state);
      if (previous && previous.status !== 'passed' && previous.page.cleanup_status !== 'completed') throw new Error(`Run ${active.runId} is incomplete; use resume or cleanup`);
    }
    await createExclusiveFlowState(paths.state, createFlowState(config, flow, runId));
    await writeFlowJson(pointer, { runId });
  }
  const state = await readFlowJson(paths.state);
  if (!state) throw new Error(`No state for ${runId}`);
  assertFlowState(state, config, flow, runId);
  if (command === 'status') { console.log(JSON.stringify(state, null, 2)); return; }
  const runner = new Runner(null, config, runId);
  await runner.initialize({ command });
  let context;
  try {
    const launched = await launchEditorBrowser(config, { headless: true, isolatedProfile: false });
    context = launched.context;
    // The unauthenticated editor redirects via HTTP and can stall navigation.
    // Enter the selected site from the authenticated overview, as a user does.
    await launched.page.goto(config.auth.adminUrl, { waitUntil: 'domcontentloaded' });
    await ensureAuthenticated(launched.page, context, config);
    await dismissBlockingModals(launched.page);
    const editor = new LeadongEditor(launched.page, config);
    await editor.enterTargetSite();
    runner.attach(editor);
    await (command === 'cleanup' ? runner.cleanup() : runner.run());
    console.log(JSON.stringify({ ok: true, runId, command, page: runner.state.page.name, report: paths.report }));
  } catch (error) {
    await runner.fail(error);
    throw error;
  } finally { await context?.close().catch(() => {}); }
}
