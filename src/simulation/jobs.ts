import type Database from 'better-sqlite3';
import {randomUUID} from 'node:crypto';
import {Worker} from 'node:worker_threads';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {VgcError, errorMessage} from '../errors.js';

export type JobStatus = 'queued'|'running'|'completed'|'partial'|'cancelled'|'failed'|'interrupted';
export interface SimulationJob {
  id:string; status:JobStatus; createdAt:string; updatedAt:string;
  progress?:unknown; result?:unknown; error?:string;
}
interface Row {
  id:string; owner_pid:number; owner_id:string; status:JobStatus; created_at:string; updated_at:string;
  request_json:string; progress_json:string|null; result_json:string|null; error:string|null;
}
function publicJob(row:Row):SimulationJob {
  return {id:row.id,status:row.status,createdAt:row.created_at,updatedAt:row.updated_at,
    ...(row.progress_json ? {progress:JSON.parse(row.progress_json) as unknown}:{}),
    ...(row.result_json ? {result:JSON.parse(row.result_json) as unknown}:{}),
    ...(row.error ? {error:row.error}:{})};
}
const terminal = new Set(['completed','partial','cancelled','failed','interrupted']);
const OWNER_LEASE_MS=30_000;
const MAX_PROGRESS_BYTES=256*1024;
const MAX_RESULT_BYTES=4*1024*1024;
const MAX_TRACE_BYTES=4*1024*1024;

function serialized(value:unknown,limit:number,label:string):string {
  const json=JSON.stringify(value);
  if(json===undefined) throw new Error(`${label} is not JSON serializable`);
  const size=Buffer.byteLength(json);
  if(size>limit) throw new Error(`${label} exceeds the ${limit} byte persistence limit`);
  return json;
}

function withoutCheckpoints(value:unknown):unknown {
  if(!value||typeof value!=='object'||Array.isArray(value)) return value;
  const {checkpoints: _privateCheckpoints,...visible}=value as Record<string,unknown>;
  return visible;
}

/** SQLite is used only by the MCP thread; computation runs in one bounded worker. */
export class SimulationJobs {
  private readonly owner = randomUUID();
  private readonly queue:string[] = [];
  private active:{id:string;worker:Worker;timer:ReturnType<typeof setInterval>}|undefined;
  private readonly heartbeat:ReturnType<typeof setInterval>;
  private closed = false;
  constructor(private readonly database:Database.Database,private readonly options:{workerUrl?:URL} = {}) {
    this.requireDatabase();
    const rows=database.prepare("SELECT * FROM simulation_jobs WHERE status IN ('queued','running')").all() as Row[];
    const now=Date.now();
    for(const row of rows) {
      let ownerAlive=true;
      try {process.kill(row.owner_pid,0);} catch(error) {
        if((error as NodeJS.ErrnoException).code==='ESRCH') ownerAlive=false;
      }
      const updated=Date.parse(row.updated_at);
      const leaseExpired=!Number.isFinite(updated)||now-updated>OWNER_LEASE_MS;
      if(!ownerAlive||leaseExpired) this.finish(row.id,'interrupted',ownerAlive
        ? 'Owning server lease expired before this job completed.'
        : 'Owning server stopped before this job completed.');
    }
    this.heartbeat=setInterval(()=>{
      if(this.closed)return;
      if(!this.database.open) {this.close();return;}
      this.database.prepare("UPDATE simulation_jobs SET updated_at=? WHERE owner_id=? AND status IN ('queued','running')")
        .run(new Date().toISOString(),this.owner);
    },1000);
    this.heartbeat.unref();
  }
  start(request:Record<string,unknown>&{budgetMs:number}):SimulationJob {
    if(this.closed) throw new VgcError('INVALID_INPUT','Simulation worker manager is closed');
    this.requireDatabase();
    if(!Number.isInteger(request.budgetMs)||request.budgetMs<1||request.budgetMs>900_000) throw new VgcError('INVALID_INPUT','Simulation budget must be 1–900000 ms');
    const queued=this.database.prepare("SELECT id FROM simulation_jobs WHERE owner_id=? AND status='queued'").all(this.owner) as Array<{id:string}>;
    const pending=new Set(queued.map(row=>row.id));
    for(let i=this.queue.length-1;i>=0;i--) if(!pending.has(this.queue[i]!)) this.queue.splice(i,1);
    if(this.queue.length>=8) throw new VgcError('INVALID_INPUT','Simulation queue is full; wait or cancel a job');
    const id=`sim_${randomUUID()}`; const now=new Date().toISOString();
    this.database.prepare('INSERT INTO simulation_jobs (id,owner_pid,owner_id,status,created_at,updated_at,request_json) VALUES (?,?,?,?,?,?,?)')
      .run(id,process.pid,this.owner,'queued',now,now,JSON.stringify(request));
    this.queue.push(id); this.pump(); return this.get(id);
  }
  get(id:string):SimulationJob {return publicJob(this.row(id));}
  /** Internal source specification for continuation; excluded from public job responses. */
  request(id:string):Record<string,unknown> {return JSON.parse(this.row(id).request_json) as Record<string,unknown>;}
  trace(id:string,offset=0,limit=1):{items:unknown[];nextOffset:number|null} {
    if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>5) throw new VgcError('INVALID_INPUT','Trace offset/limit is invalid');
    const raw=this.rawTrace(id,offset,limit);
    return {items:raw.items.map(withoutCheckpoints),nextOffset:raw.nextOffset};
  }
  private rawTrace(id:string,offset:number,limit:number):{items:unknown[];nextOffset:number|null} {
    this.row(id);
    const rows=this.database.prepare('SELECT payload_json FROM simulation_traces WHERE job_id=? ORDER BY trace_index LIMIT ? OFFSET ?').all(id,limit+1,offset) as Array<{payload_json:string}>;
    return {items:rows.slice(0,limit).map(row=>JSON.parse(row.payload_json) as unknown),nextOffset:rows.length>limit?offset+limit:null};
  }
  /** Private retrieval for branching. Never pass a checkpoint to a player policy. */
  checkpoint(id:string,traceIndex:number,turn:number):unknown {
    if(!Number.isInteger(traceIndex)||traceIndex<0)throw new VgcError('INVALID_INPUT','Trace index is invalid');
    const record=this.rawTrace(id,traceIndex,1).items[0] as {checkpoints?:Array<{turn:number;checkpoint:unknown}>}|undefined;
    const match=record?.checkpoints?.find(entry=>entry.turn===turn);
    if(!match) throw new VgcError('NOT_FOUND','No stored engine checkpoint at that turn');
    return structuredClone(match.checkpoint);
  }
  cancel(id:string):SimulationJob {
    this.row(id);
    this.finish(id,'cancelled');
    const queued=this.queue.indexOf(id);if(queued>=0)this.queue.splice(queued,1);
    if(this.active?.id===id) void this.active.worker.terminate();
    return this.get(id);
  }
  close():void {
    if(this.closed) return; this.closed=true;
    clearInterval(this.heartbeat);
    if(this.active) {clearInterval(this.active.timer); void this.active.worker.terminate();}
    if(this.database.open) this.database.prepare("UPDATE simulation_jobs SET status='interrupted',updated_at=?,error=? WHERE owner_id=? AND status IN ('queued','running')")
      .run(new Date().toISOString(),'Server closed; completed progress is preserved.',this.owner);
    this.queue.length=0;
  }
  private requireDatabase():void {
    if(!this.database.open) throw new VgcError('STORAGE_ERROR','Simulation database is closed');
  }
  private row(id:string):Row {
    this.requireDatabase();
    const row=this.database.prepare('SELECT * FROM simulation_jobs WHERE id=?').get(id) as Row|undefined;
    if(!row) throw new VgcError('NOT_FOUND',`Simulation job ${id} not found`); return row;
  }
  private finish(id:string,status:Exclude<JobStatus,'queued'|'running'>,error?:string):boolean {
    return this.database.prepare("UPDATE simulation_jobs SET status=?,updated_at=?,error=? WHERE id=? AND status IN ('queued','running')")
      .run(status,new Date().toISOString(),error??null,id).changes>0;
  }
  private pump():void {
    if(this.closed||this.active) return;
    let id=this.queue.shift();
    while(id&&this.row(id).status!=='queued') id=this.queue.shift();
    if(!id) return;
    const request=JSON.parse(this.row(id).request_json) as {budgetMs:number};
    let url=this.options.workerUrl??new URL('./worker.js',import.meta.url);
    // Tests/dev run TypeScript directly; shipped builds use the compiled worker.
    if(!this.options.workerUrl&&import.meta.url.endsWith('.ts')) {
      const require=createRequire(import.meta.url);
      const loader=pathToFileURL(require.resolve('tsx/esm/api')).href;
      const source=`import {register} from ${JSON.stringify(loader)}; register(); await import(${JSON.stringify(new URL('./worker.ts',import.meta.url).href)});`;
      url=new URL(`data:text/javascript,${encodeURIComponent(source)}`);
    }
    const claimed=this.database.prepare("UPDATE simulation_jobs SET status='running',updated_at=? WHERE id=? AND status='queued'")
      .run(new Date().toISOString(),id).changes;
    if(!claimed) {this.pump();return;}
    const jobId=id;
    let worker:Worker;
    try {worker=new Worker(url,{workerData:{request,jobId},resourceLimits:{maxOldGenerationSizeMb:512}});}
    catch(error) {this.finish(jobId,'failed',errorMessage(error)); this.pump(); return;}
    const deadline=Date.now()+request.budgetMs+10_000;
    const timer=setInterval(()=>{
      if(this.closed) return;
      if(!this.database.open) {this.close();return;}
      if(terminal.has(this.row(jobId).status)) void worker.terminate();
      else if(Date.now()>deadline) {this.finish(jobId,'partial','Worker reached its wall-time limit; completed progress is preserved.');void worker.terminate();}
    },100);
    timer.unref(); this.active={id:jobId,worker,timer};
    worker.on('message',(message:{type?:unknown;value?:unknown;status?:unknown})=>{
      if(this.closed) return;
      if(!this.database.open) {this.close();return;}
      if(terminal.has(this.row(jobId).status)) return;
      const now=new Date().toISOString();
      try {
        if(message.type==='progress') {
          const updated=this.database.prepare("UPDATE simulation_jobs SET progress_json=?,updated_at=? WHERE id=? AND status IN ('queued','running')")
            .run(serialized(message.value,MAX_PROGRESS_BYTES,'Worker progress'),now,jobId).changes;
          if(!updated) void worker.terminate();
        }
        else if(message.type==='trace') {
          const count=this.database.prepare('SELECT COUNT(*) AS count FROM simulation_traces WHERE job_id=?').get(jobId) as {count:number};
          if(count.count<5) {
            const inserted=this.database.prepare("INSERT INTO simulation_traces SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM simulation_jobs WHERE id=? AND status IN ('queued','running'))")
              .run(jobId,count.count,serialized(message.value,MAX_TRACE_BYTES,'Worker trace'),jobId).changes;
            if(!inserted) void worker.terminate();
          }
        } else if(message.type==='result') {
          const updated=this.database.prepare("UPDATE simulation_jobs SET result_json=?,status=?,updated_at=? WHERE id=? AND status IN ('queued','running')")
            .run(serialized(message.value,MAX_RESULT_BYTES,'Worker result'),message.status==='partial'?'partial':'completed',now,jobId).changes;
          if(!updated) void worker.terminate();
        } else throw new Error('Worker sent an unsupported message type');
      } catch(error) {
        this.finish(jobId,'failed',errorMessage(error));void worker.terminate();
      }
    });
    worker.on('error',error=>{if(!this.closed&&this.database.open) this.finish(jobId,'failed',errorMessage(error));});
    worker.on('exit',()=>{
      clearInterval(timer);this.active=undefined;
      if(!this.closed&&this.database.open) {this.finish(jobId,'failed','Worker exited without a result'); this.pump();}
    });
  }
}
