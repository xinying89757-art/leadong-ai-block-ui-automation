#!/usr/bin/env node
import { runNewFlowCli } from './ai-new-flow-cli.mjs';
import { AiResultActionsAutomation } from './ai-result-actions-runner.mjs';
runNewFlowCli('result-actions', AiResultActionsAutomation).catch(error => { console.error(`AI result-actions failed: ${error.message}`); process.exitCode = 1; });
