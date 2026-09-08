import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {readFileSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {createInterface} from 'node:readline';
import {expect,it} from 'vitest';
import {SqliteRepository} from '../src/storage/repository.js';

async function until(check:()=>boolean,timeout=10_000) {
  const deadline=performance.now()+timeout;
  while(!check()) {
    if(performance.now()>deadline) throw new Error('Stdio server did not reach the expected state');
    await new Promise(resolve=>setTimeout(resolve,20));
  }
}

it('interrupts active and queued simulations and exits promptly on stdin EOF',async()=>{
  const databasePath=resolve(`.stdio-lifecycle-${randomUUID()}.sqlite`);
  const environment:NodeJS.ProcessEnv={...process.env,VGC_HELPER_DATABASE:databasePath};
  delete environment['VGC_PLAYER_TOKEN'];
  const child=spawn(process.execPath,['--import','tsx',resolve('src','index.ts')],{env:environment,stdio:['pipe','pipe','pipe']});
  let stderr='';
  child.stderr.setEncoding('utf8').on('data',(chunk:string)=>{stderr+=chunk;});
  const pending=new Map<number,{resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  const responses=createInterface({input:child.stdout});
  let sequence=0,closed=false;
  const exited=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>{
    child.once('close',(code,signal)=>{
      closed=true;
      for(const request of pending.values()) {clearTimeout(request.timer);request.reject(new Error(`Stdio server exited: ${stderr}`));}
      pending.clear();
      resolve({code,signal});
    });
  });
  child.on('error',error=>{
    for(const request of pending.values()) {clearTimeout(request.timer);request.reject(error);}
    pending.clear();
  });
  responses.on('line',line=>{
    const response=JSON.parse(line) as {id?:number;result?:unknown;error?:unknown};
    if(response.id===undefined) return;
    const request=pending.get(response.id);
    if(!request) return;
    pending.delete(response.id);clearTimeout(request.timer);
    if(response.error) request.reject(new Error(JSON.stringify(response.error)));
    else request.resolve(response.result);
  });
  function request(method:string,params:Record<string,unknown>):Promise<unknown> {
    const id=++sequence;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{
        pending.delete(id);reject(new Error(`Stdio ${method} timed out: ${stderr}`));
      },10_000);
      pending.set(id,{resolve,reject,timer});
      child.stdin.write(`${JSON.stringify({jsonrpc:'2.0',id,method,params})}\n`);
    });
  }
  let repository:SqliteRepository|undefined;
  try {
    await request('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'stdio-lifecycle-test',version:'1.0.0'}});
    child.stdin.write(`${JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})}\n`);
    repository=new SqliteRepository(databasePath);repository.initialize();
    const team_export=readFileSync(resolve('examples','sample-team.txt'),'utf8');
    const args={p1:{team_export},p2:{team_export},samples:10000,max_turns:80,budget_ms:60000,seed:'stdio-eof',
      p1_policy:'search',p2_policy:'search',search:{budgetMs:30000,iterations:10000}};
    async function start() {
      const response=await request('tools/call',{name:'vgc_simulate_battle',arguments:args}) as {isError?:boolean;structuredContent:{result:{id:string;status:string}}};
      expect(response.isError).not.toBe(true);
      return response.structuredContent.result;
    }
    const active=await start(),queued=await start();
    expect(active.status).toBe('running');
    expect(queued.status).toBe('queued');
    const read=repository.database.prepare('SELECT status,progress_json,result_json,error FROM simulation_jobs WHERE id=?');
    const state=(id:string)=>read.get(id) as {status:string;progress_json:string|null;result_json:string|null;error:string|null};
    await until(()=>state(active.id).progress_json!==null);
    await new Promise(resolve=>setTimeout(resolve,1000));
    expect(state(active.id).status).toBe('running');
    expect(state(queued.id)).toMatchObject({status:'queued',progress_json:null,result_json:null});

    child.stdin.end();
    await until(()=>closed,5000);
    expect(await exited,stderr).toEqual({code:0,signal:null});
    expect(state(active.id)).toMatchObject({status:'interrupted',result_json:null,error:expect.stringMatching(/closed/i)});
    expect(state(active.id).progress_json).not.toBeNull();
    expect(state(queued.id)).toMatchObject({status:'interrupted',progress_json:null,result_json:null,error:expect.stringMatching(/closed/i)});
    expect(stderr).not.toMatch(/database.*closed|not open|uncaught/i);
  } finally {
    if(!closed) {child.kill('SIGKILL');await exited;}
    responses.close();
    for(const request of pending.values()) clearTimeout(request.timer);
    repository?.close();
    for(const suffix of ['','-wal','-shm']) rmSync(databasePath+suffix,{force:true});
  }
});
