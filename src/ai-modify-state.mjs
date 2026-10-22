import { createFlowState } from './ai-new-flow-state.mjs';
export * from './ai-new-flow-state.mjs';
export const createModifyState = (config, runId) => createFlowState(config, 'modify', runId);
