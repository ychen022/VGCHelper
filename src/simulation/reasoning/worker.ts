import {parentPort,workerData} from 'node:worker_threads';
import {evaluatePlayerPlans} from './scenarios.js';
import type {EvaluationInput} from './worker-client.js';
const input=workerData as EvaluationInput;
try {
  parentPort!.postMessage({result:evaluatePlayerPlans(input.view,input.belief,input.sources,input.options)});
} catch(error) {
  parentPort!.postMessage({error:error instanceof Error?error.message:'Scenario evaluation failed'});
}
