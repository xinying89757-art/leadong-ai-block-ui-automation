import { runNewFlowCli } from './ai-new-flow-cli.mjs';
import { AiHistoryAutomation } from './ai-history-runner.mjs';
runNewFlowCli('history', AiHistoryAutomation).catch(error=>{console.error(`AI history failed: ${error.message}`);process.exitCode=1;});
