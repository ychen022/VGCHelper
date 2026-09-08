import {parentPort,workerData} from 'node:worker_threads';
parentPort.postMessage({type:'progress',value:{completed:1}});
if(workerData.request.kind==='slow') setTimeout(()=>{},10000);
else {
  parentPort.postMessage({type:'trace',value:{episode:0,decisions:[]}});
  parentPort.postMessage({type:'result',value:{wins:2},status:'completed'});
}
