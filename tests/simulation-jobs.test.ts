import {afterEach, describe, expect, it, vi} from 'vitest';
import type Database from 'better-sqlite3';
import {randomUUID} from 'node:crypto';
import {rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {SqliteRepository} from '../src/storage/repository.js';
import {SimulationJobs} from '../src/simulation/jobs.js';

const resources: Array<()=>void> = [];
afterEach(()=>{vi.restoreAllMocks();for (const close of resources.splice(0).reverse()) close();});
function setup(databasePath=':memory:',worker=new URL('./fixtures/simulation-worker.mjs',import.meta.url)) {
  const repository = new SqliteRepository(databasePath); repository.initialize();
  resources.push(()=>repository.close());
  const jobs = new SimulationJobs(repository.database, {workerUrl:worker});
  resources.push(()=>jobs.close()); return {jobs,repository};
}
function shared(worker?:URL) {
  const path=resolve(`.simulation-jobs-${randomUUID()}.sqlite`);
  resources.push(()=>{for(const suffix of ['','-wal','-shm'])rmSync(path+suffix,{force:true});});
  const owner=setup(path,worker),observer=setup(path);
  return {...owner,observer:observer.jobs,observerRepository:observer.repository};
}
function beforeWrite(database:Database.Database,match:(sql:string,args:unknown[])=>boolean,action:(args:unknown[])=>void) {
  const prepare=database.prepare.bind(database);
  let fired=false;
  vi.spyOn(database,'prepare').mockImplementation(((sql:string)=>{
    const statement=prepare(sql);
    const run=statement.run.bind(statement);
    vi.spyOn(statement,'run').mockImplementation((...args:unknown[])=>{
      if(!fired&&match(sql,args)) {fired=true;action(args);}
      return run(...args);
    });
    return statement;
  }) as typeof database.prepare);
  return ()=>fired;
}
function workerUrl(source:string) {
  return new URL(`data:text/javascript,${encodeURIComponent(source)}`);
}
async function until(check:()=>boolean) {
  const deadline = performance.now()+5000;
  while(!check()) { if(performance.now()>deadline) throw new Error('Job did not settle'); await new Promise(resolve=>setTimeout(resolve,10)); }
}
describe('persistent simulation jobs',()=>{
  it('releases a worker that reports completion but retains an open handle',async()=>{
    const repository=new SqliteRepository(':memory:');repository.initialize();resources.push(()=>repository.close());
    const jobs=new SimulationJobs(repository.database,{workerUrl:workerUrl(`import {parentPort} from 'node:worker_threads';parentPort.postMessage({type:'result',value:{ok:true}});setInterval(()=>{},1000);`)});resources.push(()=>jobs.close());
    const first=jobs.start({budgetMs:1000});const second=jobs.start({budgetMs:1000});
    await until(()=>jobs.get(second.id).status==='completed');
    expect(jobs.get(first.id).status).toBe('completed');
  });
  it('runs away from the MCP thread and persists completed progress and traces',async()=>{
    const {jobs,repository} = setup();
    const started = jobs.start({budgetMs:2000,kind:'test'});
    expect(['queued','running']).toContain(started.status);
    await until(()=>jobs.get(started.id).status==='completed');
    expect(jobs.get(started.id).result).toEqual({wins:2});
    expect(jobs.trace(started.id,0,1).items[0]).toMatchObject({episode:0});
    expect(repository.database.prepare('SELECT count(*) AS count FROM simulation_jobs').get()).toEqual({count:1});
  });
  it('cancels a running worker without converting unfinished games into losses',async()=>{
    const {jobs} = setup(); const started=jobs.start({budgetMs:2000,kind:'slow'});
    await until(()=>Boolean(jobs.get(started.id).progress));
    jobs.cancel(started.id);
    await until(()=>jobs.get(started.id).status==='cancelled');
    expect(jobs.get(started.id).progress).toEqual({completed:1});
    expect(jobs.get(started.id).result).toBeUndefined();
  });
  it.each(['completed','partial'])('preserves remote cancellation racing a worker %s result',async status=>{
    const {jobs,repository,observer}=shared(workerUrl(`
      import {parentPort} from 'node:worker_threads';
      parentPort.postMessage({type:'result',value:{wins:2},status:${JSON.stringify(status)}});
    `));
    const started=jobs.start({budgetMs:2000});
    const raced=beforeWrite(repository.database,sql=>sql.startsWith('UPDATE simulation_jobs SET result_json='),()=>{
      expect(observer.cancel(started.id).status).toBe('cancelled');
    });
    await until(raced);
    expect(jobs.get(started.id)).toMatchObject({status:'cancelled'});
    expect(jobs.get(started.id).result).toBeUndefined();
  });
  it.each([
    ['error',`throw new Error('worker boom');`],
    ['exit',``],
    ['invalid output',`import {parentPort} from 'node:worker_threads';parentPort.postMessage({type:'unsupported'});`],
  ])('preserves remote cancellation racing worker %s failure',async(_label,source)=>{
    const {jobs,repository,observer}=shared(workerUrl(source!));
    const started=jobs.start({budgetMs:2000});
    const raced=beforeWrite(repository.database,(sql,args)=>sql.startsWith('UPDATE simulation_jobs SET status=')&&args[0]==='failed',()=>{
      expect(observer.cancel(started.id).status).toBe('cancelled');
    });
    await until(raced);
    expect(jobs.get(started.id)).toMatchObject({status:'cancelled'});
    expect(jobs.get(started.id).error).toBeUndefined();
  });
  it('preserves cancellation racing the worker deadline',async()=>{
    const {jobs,repository,observer}=shared();
    const started=jobs.start({budgetMs:2000,kind:'slow'});
    await until(()=>Boolean(jobs.get(started.id).progress));
    const raced=beforeWrite(repository.database,(sql,args)=>sql.startsWith('UPDATE simulation_jobs SET status=')&&args[0]==='partial',()=>{
      expect(observer.cancel(started.id).status).toBe('cancelled');
    });
    const now=Date.now();
    vi.spyOn(Date,'now').mockReturnValue(now+20_000);
    await until(raced);
    expect(jobs.get(started.id)).toMatchObject({status:'cancelled',progress:{completed:1}});
    expect(jobs.get(started.id).error).toBeUndefined();
  });
  it('returns the committed result when completion races cancellation',()=>{
    const {jobs,repository,observerRepository}=shared();
    const started=jobs.start({budgetMs:2000,kind:'slow'});
    beforeWrite(repository.database,(sql,args)=>sql.startsWith('UPDATE simulation_jobs SET status=')&&args[0]==='cancelled',()=>{
      observerRepository.database.prepare("UPDATE simulation_jobs SET status='completed',result_json=? WHERE id=?").run('{"wins":2}',started.id);
    });
    expect(jobs.cancel(started.id)).toMatchObject({status:'completed',result:{wins:2}});
  });
  it.each(['progress','trace'])('does not append %s after a concurrent cancellation',async type=>{
    const {jobs,repository,observer}=shared(workerUrl(`
      import {parentPort} from 'node:worker_threads';
      parentPort.postMessage({type:${JSON.stringify(type)},value:{completed:1}});
      setInterval(()=>{},1000);
    `));
    const started=jobs.start({budgetMs:2000});
    const raced=beforeWrite(repository.database,sql=>type==='progress'?sql.startsWith('UPDATE simulation_jobs SET progress_json='):sql.startsWith('INSERT INTO simulation_traces'),()=>{
      expect(observer.cancel(started.id).status).toBe('cancelled');
    });
    await until(raced);
    expect(jobs.get(started.id).progress).toBeUndefined();
    expect(jobs.trace(started.id).items).toEqual([]);
  });
  it('does not launch a queued worker cancelled while it is being claimed',()=>{
    const {jobs,repository,observer}=shared();
    beforeWrite(repository.database,sql=>sql.startsWith("UPDATE simulation_jobs SET status='running'"),args=>{
      expect(observer.cancel(String(args[1])).status).toBe('cancelled');
    });
    expect(jobs.start({budgetMs:2000,kind:'slow'}).status).toBe('cancelled');
    expect(jobs.start({budgetMs:2000,kind:'slow'}).status).toBe('running');
  });
  it('keeps only one active worker and can cancel a queued job',async()=>{
    const {jobs}=setup(); const first=jobs.start({budgetMs:2000,kind:'slow'});
    const second=jobs.start({budgetMs:2000,kind:'test'});
    expect(second.status).toBe('queued'); jobs.cancel(second.id); jobs.cancel(first.id);
    expect(jobs.get(second.id).status).toBe('cancelled');
  });
  it('returns an explicit error for missing jobs and invalid budgets',()=>{
    const {jobs}=setup(); expect(()=>jobs.get('absent')).toThrow('not found');
    expect(()=>jobs.start({budgetMs:0})).toThrow('budget');
  });
  it('redacts private checkpoints from public traces but retains private branching access',async()=>{
    const repository = new SqliteRepository(':memory:'); repository.initialize(); resources.push(()=>repository.close());
    const jobs = new SimulationJobs(repository.database,{workerUrl:workerUrl(`
      import {parentPort} from 'node:worker_threads';
      parentPort.postMessage({type:'trace',value:{episode:0,decisions:[{side:'p1'}],checkpoints:[{turn:1,checkpoint:{secretTeam:'hidden'}}]}});
      parentPort.postMessage({type:'result',value:{ok:true},status:'completed'});
    `)}); resources.push(()=>jobs.close());
    const started=jobs.start({budgetMs:2000});await until(()=>jobs.get(started.id).status==='completed');
    expect(jobs.trace(started.id).items[0]).toEqual({episode:0,decisions:[{side:'p1'}]});
    expect(jobs.checkpoint(started.id,0,1)).toEqual({secretTeam:'hidden'});
  });
  it('fails and terminates workers that exceed persisted output bounds',async()=>{
    const repository = new SqliteRepository(':memory:'); repository.initialize(); resources.push(()=>repository.close());
    const jobs = new SimulationJobs(repository.database,{workerUrl:workerUrl(`
      import {parentPort} from 'node:worker_threads';
      parentPort.postMessage({type:'progress',value:{text:'x'.repeat(300000)}});
      setTimeout(()=>{},10000);
    `)}); resources.push(()=>jobs.close());
    const started=jobs.start({budgetMs:2000});await until(()=>jobs.get(started.id).status==='failed');
    expect(jobs.get(started.id).error).toMatch(/exceeds.*limit/i);
    expect(jobs.get(started.id).progress).toBeUndefined();
  });
  it('releases cancelled queued jobs from the queue capacity immediately',()=>{
    const {jobs}=setup();const active=jobs.start({budgetMs:2000,kind:'slow'});
    const queued=Array.from({length:8},()=>jobs.start({budgetMs:2000,kind:'test'}));
    expect(()=>jobs.start({budgetMs:2000,kind:'test'})).toThrow(/queue is full/i);
    jobs.cancel(queued[0]!.id);
    expect(()=>jobs.start({budgetMs:2000,kind:'test'})).not.toThrow();
    jobs.cancel(active.id);
  });
  it('reconciles remotely cancelled jobs before enforcing queue capacity',()=>{
    const {jobs,observer}=shared();
    const active=jobs.start({budgetMs:2000,kind:'slow'});
    const queued=Array.from({length:8},()=>jobs.start({budgetMs:2000,kind:'test'}));
    expect(()=>jobs.start({budgetMs:2000,kind:'test'})).toThrow(/queue is full/i);
    for(const job of queued) expect(observer.cancel(job.id).status).toBe('cancelled');
    expect(jobs.get(active.id).status).toBe('running');
    for(let i=0;i<8;i++) expect(jobs.start({budgetMs:2000,kind:'test'}).status).toBe('queued');
    expect(()=>jobs.start({budgetMs:2000,kind:'test'})).toThrow(/queue is full/i);
  });
  it('cleans its local queue when cancellation already committed remotely',()=>{
    const {jobs,observer}=shared();
    jobs.start({budgetMs:2000,kind:'slow'});
    const queued=jobs.start({budgetMs:2000,kind:'test'});
    observer.cancel(queued.id);
    expect(jobs).toHaveProperty('queue',[queued.id]);
    expect(jobs.cancel(queued.id).status).toBe('cancelled');
    expect(jobs).toHaveProperty('queue',[]);
  });
  it('recovers stale leases while preserving a fresh live foreign owner',()=>{
    const repository = new SqliteRepository(':memory:'); repository.initialize();resources.push(()=>repository.close());
    const insert=repository.database.prepare('INSERT INTO simulation_jobs (id,owner_pid,owner_id,status,created_at,updated_at,request_json) VALUES (?,?,?,?,?,?,?)');
    const fresh=new Date().toISOString(),stale=new Date(Date.now()-31_000).toISOString();
    insert.run('fresh',process.pid,'other-live','running',fresh,fresh,'{}');
    insert.run('stale',process.pid,'orphaned','running',stale,stale,'{}');
    const jobs=new SimulationJobs(repository.database,{workerUrl:new URL('./fixtures/simulation-worker.mjs',import.meta.url)});resources.push(()=>jobs.close());
    expect(jobs.get('fresh').status).toBe('running');
    expect(jobs.get('stale')).toMatchObject({status:'interrupted',error:expect.stringMatching(/lease/i)});
  });
  it('preserves cancellation racing stale-lease recovery',()=>{
    const {jobs,repository,observer}=shared();
    const stale=new Date(Date.now()-31_000).toISOString();
    repository.database.prepare('INSERT INTO simulation_jobs (id,owner_pid,owner_id,status,created_at,updated_at,request_json) VALUES (?,?,?,?,?,?,?)')
      .run('stale',process.pid,'orphaned','running',stale,stale,'{}');
    const raced=beforeWrite(repository.database,(sql,args)=>sql.startsWith('UPDATE simulation_jobs SET status=')&&args[0]==='interrupted',()=>{
      expect(observer.cancel('stale').status).toBe('cancelled');
    });
    const recovering=new SimulationJobs(repository.database);resources.push(()=>recovering.close());
    expect(raced()).toBe(true);
    expect(jobs.get('stale').status).toBe('cancelled');
    expect(jobs.get('stale').error).toBeUndefined();
  });
  it('marks owned work interrupted on close and records worker errors',async()=>{
    const {jobs}=setup();const slow=jobs.start({budgetMs:2000,kind:'slow'});await until(()=>jobs.get(slow.id).status==='running');
    jobs.close();expect(jobs.get(slow.id)).toMatchObject({status:'interrupted',error:expect.stringMatching(/closed/i)});

    const repository = new SqliteRepository(':memory:'); repository.initialize();resources.push(()=>repository.close());
    const broken = new SimulationJobs(repository.database,{workerUrl:workerUrl(`throw new Error('worker boom')`)});resources.push(()=>broken.close());
    const failed=broken.start({budgetMs:2000});await until(()=>broken.get(failed.id).status==='failed');
    expect(broken.get(failed.id).error).toContain('worker boom');
  });
  it('tolerates late worker callbacks after the database closes',async()=>{
    const {jobs,repository}=setup();
    jobs.start({budgetMs:2000,kind:'slow'});
    repository.close();
    expect(()=>jobs.close()).not.toThrow();
    expect(()=>jobs.get('absent')).toThrow('Simulation database is closed');
    expect(()=>new SimulationJobs(repository.database)).toThrow('Simulation database is closed');
    await new Promise(resolve=>setTimeout(resolve,150));
  });
});
