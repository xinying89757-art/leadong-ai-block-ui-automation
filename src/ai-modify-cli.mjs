#!/usr/bin/env node
import { runNewFlowCli } from './ai-new-flow-cli.mjs';
import { AiModifyAutomation } from './ai-modify-runner.mjs';
runNewFlowCli('modify', AiModifyAutomation).catch(error => { console.error(`AI modify failed: ${error.message}`); process.exitCode = 1; });
