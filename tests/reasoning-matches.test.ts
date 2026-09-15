import {afterEach, describe, expect, it} from 'vitest';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteRepository} from '../src/storage/repository.js';
import {completePreviewTeam,EngineSession} from '../src/simulation/engine.js';
import {ReasoningMatches, type ReasoningRequest} from '../src/simulation/reasoning/matches.js';

const preview=['Dragonite','Garchomp','Whimsicott','Kingambit','Sneasler','Basculegion'];
const request=():ReasoningRequest=>({regulationId:'champions-vgc-2026-m-c',metaTeams:[],usageRows:[],
  teams:{p1:{preview,team:completePreviewTeam(preview)},p2:{preview,team:completePreviewTeam(preview)}},
  seed:'isolated-test',maxTurns:3,budgetMs:180000,informationMode:'closed'});
const cleanup:Array<()=>void>=[];
afterEach(()=>{for(const close of cleanup.splice(0).reverse())close();});
function setup(path=':memory:',now=()=>Date.now()) {
  const repository=new SqliteRepository(path);repository.initialize();
  const matches=new ReasoningMatches(repository.database,{now});
  cleanup.push(()=>{matches.close();repository.close();});return {repository,matches};
}
describe('persistent external reasoning players',()=>{
  it('commits simultaneous decisions, retains private memory and makes retries idempotent',()=>{
    const {matches}=setup();const start=matches.start(request());
    const a=matches.playerView(start.players.p1.playerToken),b=matches.playerView(start.players.p2.playerToken);
    const decision={command:'team 1234',summary:'Lead pressure',plan:'private plan sentinel'};
    const receipt=matches.submit(start.players.p1.playerToken,a.decisionId,decision);
    expect(receipt.accepted).toBe(true);
    expect(matches.playerView(start.players.p2.playerToken)).toEqual(b);
    expect(JSON.stringify(matches.get(start.adminToken))).not.toContain('private plan sentinel');
    expect(matches.playerView(start.players.p1.playerToken).memory.plan).toBe('private plan sentinel');
    expect(matches.submit(start.players.p1.playerToken,a.decisionId,decision)).toEqual(receipt);
    expect(()=>matches.submit(start.players.p1.playerToken,a.decisionId,{...decision,command:'team 2134'})).toThrow(/already|locked/i);
    matches.submit(start.players.p2.playerToken,b.decisionId,{command:'team 1234',summary:'Lead pressure'});
    const next=matches.playerView(start.players.p1.playerToken);
    expect(next.turn).toBe(1);expect(next.decisionId).not.toBe(a.decisionId);
    expect(matches.submit(start.players.p1.playerToken,a.decisionId,decision)).toEqual(receipt);
    expect(()=>matches.submit(start.players.p2.playerToken,'stale',{command:'team 1234',summary:'old'})).toThrow(/stale/i);
  });
  it('scopes credentials, never persists plaintext tokens and survives independent connections',()=>{
    const dir=mkdtempSync(join(tmpdir(),'vgc-reasoning-'));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));
    const path=join(dir,'test.sqlite');const first=setup(path);const start=first.matches.start(request());
    const second=setup(path);const token=start.players.p1.playerToken;
    expect(second.matches.playerView(token)).toEqual(first.matches.playerView(token));
    expect(()=>second.matches.get(token)).toThrow(/credential/i);
    expect(()=>second.matches.playerView(start.adminToken)).toThrow(/credential/i);
    const persisted=JSON.stringify(first.repository.database.prepare('SELECT * FROM reasoning_matches').all());
    for(const secret of [start.adminToken,token,start.players.p2.playerToken])expect(persisted).not.toContain(secret);
    second.matches.submit(token,second.matches.playerView(token).decisionId,{command:'team 1234',summary:'separate process'});
    expect(first.matches.playerView(token).status).toBe('waiting');
  });
  it('hidden team interventions cannot change actor evidence or handoff',()=>{
    const {matches}=setup();const original=request(),changed=request();
    changed.teams.p2.team!.pokemon[0]!.item='Life Orb';
    changed.teams.p2.team!.pokemon[0]!.moves=['Dragon Claw','Protect'];
    const a=matches.start(original),b=matches.start(changed);
    expect(matches.playerView(a.players.p1.playerToken).evidence).toEqual(matches.playerView(b.players.p1.playerToken).evidence);
    expect(a.players.p1.prompt).not.toContain(a.adminToken);
    expect(a.players.p1.prompt).not.toContain(a.players.p2.playerToken);
  });
  it('rejects illegal commands without advancing or locking the phase',()=>{
    const {matches}=setup();const start=matches.start(request()),token=start.players.p1.playerToken;
    const view=matches.playerView(token);
    expect(()=>matches.submit(token,view.decisionId,{command:'move 999',summary:'invalid'})).toThrow(/legal/i);
    expect(matches.playerView(token)).toEqual(view);
  });
  it('persists cancellation and expiration with no automatic heuristic actions',()=>{
    let now=1000;const {matches}=setup(':memory:',()=>now);const start=matches.start(request());
    now+=180001;expect(matches.get(start.adminToken).status).toBe('expired');
    expect(matches.playerView(start.players.p1.playerToken).status).toBe('expired');
    expect(()=>matches.submit(start.players.p1.playerToken,'old',{command:'team 1234',summary:'late'})).toThrow(/expired/i);
    const next=matches.start(request());expect(matches.cancel(next.adminToken).status).toBe('cancelled');
    expect(matches.cancel(next.adminToken).status).toBe('cancelled');
  });
  it('resolves a bounded game and saves the final resolution plus agent decision provenance',()=>{
    const {matches}=setup();const start=matches.start(request());
    for(let i=0;i<30&&matches.get(start.adminToken).status==='active';i++){
      for(const side of ['p1','p2'] as const){
        const token=start.players[side].playerToken,view=matches.playerView(token);
        if(view.status!=='decision')continue;
        matches.submit(token,view.decisionId,{command:view.evidence.legalCommands[0]!,summary:'scripted lifecycle test',agent:'test-driver'});
      }
    }
    const result=matches.get(start.adminToken);
    expect(['completed','capped']).toContain(result.status);
    expect(result.result?.battleLogs.p1.lines.some(line=>line.startsWith('|move|'))).toBe(true);
    expect(result.result?.decisions.every(d=>d.source==='external-agent')).toBe(true);
    expect(result.result?.battleLogs.p1.lines).toEqual(matches.playerView(start.players.p1.playerToken).battleLog?.lines);
  });
  it('uses distinct decision revisions for replacements and includes the terminal win/tie event',()=>{
    const {matches}=setup();const names=['Forretress','Glalie','Metagross','Garbodor','Vanilluxe','Glimmora'];
    const team=completePreviewTeam(names);for(const set of team.pokemon){set.moves=['Explosion'];set.gender=set.species==='Metagross'?'N':'M';}
    const input=request();input.teams={p1:{preview:names,team},p2:{preview:names,team}};input.maxTurns=12;
    const start=matches.start(input);let forced=0;const revisions=new Set<string>();
    for(let i=0;i<40&&matches.get(start.adminToken).status==='active';i++)for(const side of ['p1','p2'] as const){
      const token=start.players[side].playerToken,view=matches.playerView(token);if(view.status!=='decision')continue;
      if(view.evidence.phase==='forced_switch'){forced++;expect(revisions.has(view.decisionId+side)).toBe(false);}
      revisions.add(view.decisionId+side);
      matches.submit(token,view.decisionId,{command:view.evidence.legalCommands[0]!,summary:'Explosion mechanics test'});
    }
    const result=matches.get(start.adminToken);expect(result.status).toBe('completed');expect(forced).toBeGreaterThan(0);
    expect(result.result!.battleLogs.p1.lines.some(line=>/^\|(win|tie)\|?/.test(line))).toBe(true);
  });
  it('runs bounded actor-only evaluation in a worker and permits no work after submission',async()=>{
    const {matches}=setup(),start=matches.start(request()),token=start.players.p1.playerToken;
    const view=matches.playerView(token);
    const evaluation=await matches.evaluate(token,view.decisionId,{plans:[{label:'lead',command:'team 1234'}],samples:1,maxTurns:1,budgetMs:500});
    expect(evaluation.result.evaluations).toHaveLength(1);
    expect(matches.playerView(start.players.p2.playerToken).evaluations).toEqual([]);
    expect(matches.playerView(token).evaluations[0]!.status).toBe('completed');
    expect(matches.playerView(token).evaluations[0]!.configuration).toMatchObject({samples:1,maxTurns:1,budgetMs:500});
    matches.submit(token,view.decisionId,{command:'team 1234',summary:'Selected after evidence'});
    await expect(matches.evaluate(token,view.decisionId,{plans:[{label:'late',command:'team 1234'}],samples:1,maxTurns:1,budgetMs:10})).rejects.toThrow(/locked/);
  });
  it('cancels an in-flight worker and recovers abandoned evaluation leases',async()=>{
    let now=1000;const {matches,repository}=setup(':memory:',()=>now),start=matches.start(request()),token=start.players.p1.playerToken;
    const view=matches.playerView(token);
    const running=matches.evaluate(token,view.decisionId,{plans:[{label:'lead',command:'team 1234'}],samples:32,maxTurns:3,budgetMs:10000});
    const assertion=expect(running).rejects.toThrow(/cancelled/);
    matches.cancel(start.adminToken);await assertion;
    const next=matches.start(request()),nextToken=next.players.p1.playerToken;
    const row=repository.database.prepare('SELECT payload_json FROM reasoning_matches WHERE id=?').get(next.matchId) as {payload_json:string};
    const state=JSON.parse(row.payload_json);state.evaluations.push({id:'abandoned',side:'p1',decisionId:matches.playerView(nextToken).decisionId,status:'running',expiresAt:1500});
    repository.database.prepare('UPDATE reasoning_matches SET payload_json=? WHERE id=?').run(JSON.stringify(state),next.matchId);
    now=1600;expect(matches.playerView(nextToken).evaluations[0]!.status).toBe('failed');
  });
  it('continues an internal checkpoint without exposing it to either player',()=>{
    const {matches}=setup(),input=request(),game=EngineSession.create({teams:{p1:input.teams.p1.team!,p2:input.teams.p2.team!},seed:[1,2,3,4]});
    game.step({p1:'team 1234',p2:'team 1234'});input.checkpoint=game.snapshot();
    const start=matches.start(input),view=matches.playerView(start.players.p1.playerToken);
    expect(view.turn).toBe(1);expect(view.evidence.request).toEqual(game.view('p1').request);
    expect(Object.keys(view)).not.toContain('checkpoint');expect(Object.keys(matches.get(start.adminToken))).not.toContain('checkpoint');
  });
  it('keeps legal external play available when opponent set inference has no coverage',()=>{
    const {matches}=setup(),input=request();const ditto={...input.teams.p2.team!.pokemon[0]!,species:'Ditto',moves:['Transform'],ability:'Imposter',item:'Choice Scarf',gender:'N' as const};
    input.teams.p2.team!.pokemon[0]=ditto;input.teams.p2.preview=['Ditto',...preview.slice(1)];
    const start=matches.start(input),token=start.players.p1.playerToken,view=matches.playerView(token);
    expect(view.status).toBe('decision');expect(view.evidence.legalCommands).toContain('team 1234');
    expect(()=>matches.submit(token,view.decisionId,{command:'team 1234',summary:'Coverage is insufficient, use visible preview'})).not.toThrow();
  });
});
