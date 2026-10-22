import {runNewFlowCli} from './ai-new-flow-cli.mjs';
import {AiValidationAutomation} from './ai-validation-runner.mjs';
runNewFlowCli('validation',AiValidationAutomation).catch(error=>{console.error(`AI validation failed: ${error.message}`);process.exitCode=1;});
