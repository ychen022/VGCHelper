import {parentPort,workerData} from 'node:worker_threads';
import {runSimulation,type SimulationRequest} from './runner.js';
import {runCohortExperiment,type CohortRequest} from './experiment.js';
const request=(workerData as {request:SimulationRequest|CohortRequest}).request;
const callbacks={progress:(value:unknown)=>parentPort?.postMessage({type:'progress',value}),trace:(value:unknown)=>parentPort?.postMessage({type:'trace',value})};
const report=request.kind==='cohort'?runCohortExperiment(request,callbacks):runSimulation(request,callbacks);
parentPort?.postMessage({type:'result',value:report,status:report.status});
