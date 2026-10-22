import { createFullPageState, fullPagePaths, newFullPageRunId, readFullPageJson, shouldAutoRetryFailed, writeFullPageJson } from "./ai-full-page-state.mjs";

export function fullPageSummary(state, paths) {
  return { runId: state.run_id, stateFile: paths.state, page: state.page, generation: state.generation };
}

// Return the final attempt's state even on failure. The browser executor is
// injected so this contract can be tested offline without generating AI data.
export async function executeFullPageAttempts({ config, command, options, runId, execute, warn = () => {}, nextRunId = newFullPageRunId }) {
  let attempt = 0;
  while (true) {
    const paths = fullPagePaths(config, runId);
    try {
      const state = await execute(runId, paths);
      const ok = command === "cleanup" ? state.page.cleanup_status === "completed" :
        state.generation.generation_status === 'succeeded' && state.generation.application_status === 'applied' &&
        state.page.editor_verified && state.page.saved && state.page.preview_verified && state.page.published_verified;
      return { ok: Boolean(ok), command, ...fullPageSummary(state, paths) };
    } catch (error) {
      const failed = await readFullPageJson(paths.state);
      if (!["run", "resume"].includes(command) || options["no-auto-retry"] === true || !shouldAutoRetryFailed(failed, config, attempt)) {
        return { ok: false, command, ...(failed ? fullPageSummary(failed, paths) : { runId, stateFile: paths.state }), failures: [{ reason: error.message }] };
      }
      attempt += 1;
      const previousRunId = runId;
      runId = `${nextRunId()}-retry${attempt}`;
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(runId)) throw new Error("整页重试运行 ID 不合法");
      const retryPaths = fullPagePaths(config, runId);
      await writeFullPageJson(retryPaths.state, createFullPageState(config, runId, {
        attempt, previousRunId, reason: failed?.generation?.failure_reason || error.message,
      }));
      await writeFullPageJson(retryPaths.active, { runId, stateFile: retryPaths.state });
      warn(`整页生成明确失败，已记录运行 ${previousRunId}；自动重试 ${attempt}/${config.ai.fullPageRegression.maxGenerationRetries ?? 0}，新运行 ${runId}`);
    }
  }
}
