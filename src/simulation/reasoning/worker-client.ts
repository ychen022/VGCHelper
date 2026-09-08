import {Worker} from 'node:worker_threads';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import type {evaluatePlayerPlans} from './scenarios.js';

type Args=Parameters<typeof evaluatePlayerPlans>;
export interface EvaluationInput {view:Args[0];belief:Args[1];sources:Args[2];options:Args[3]}
export type EvaluationResult=ReturnType<typeof evaluatePlayerPlans>;

/** The worker receives only the requesting player's information set. */
export function runEvaluation(input:EvaluationInput,shouldStop:()=>boolean):{promise:Promise<EvaluationResult>;cancel:()=>void} {
  let url=new URL('./worker.js',import.meta.url);
  if(import.meta.url.endsWith('.ts')){
    const register=pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href;
    url=new URL(`data:text/javascript,${encodeURIComponent(`import {register} from ${JSON.stringify(register)};register();await import(${JSON.stringify(new URL('./worker.ts',import.meta.url).href)});`)}`);
  }
  const worker=new Worker(url,{workerData:input,resourceLimits:{maxOldGenerationSizeMb:512}});
  let cancel=()=>{};
  const promise=new Promise<EvaluationResult>((resolve,reject)=>{
    let done=false;
    const finish=(error?:Error,result?:EvaluationResult)=>{
      if(done)return;done=true;clearInterval(poll);clearTimeout(timeout);void worker.terminate();
      if(error)reject(error);else resolve(result!);
    };
    cancel=()=>finish(new Error('Scenario evaluation cancelled or decision no longer active'));
    const poll=setInterval(()=>{try{if(shouldStop())cancel();}catch{cancel();}},100);
    const timeout=setTimeout(()=>finish(new Error('Scenario worker exceeded its time budget')),input.options.budgetMs+5000);
    worker.once('message',(message:{error?:string;result?:EvaluationResult})=>finish(message.error?new Error(message.error):undefined,message.result));
    worker.once('error',error=>finish(error));
    worker.once('exit',()=>{if(!done)finish(new Error('Scenario worker exited without a result'));});
  });
  return {promise,cancel:()=>cancel()};
}
