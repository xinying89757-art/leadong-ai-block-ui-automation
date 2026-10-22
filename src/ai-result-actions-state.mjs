import { createFlowState } from './ai-new-flow-state.mjs';
export * from './ai-new-flow-state.mjs';
export const createResultActionsState = (config, runId) => createFlowState(config, 'result-actions', runId);
