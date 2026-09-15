import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {AppContext} from '../src/app/context.js';
import {createMcpServer} from '../src/mcp/server.js';
import {HumanBattles} from '../src/battle/matches.js';
import {BATTLE_PROFILE,HumanBattleEngine} from '../src/battle/engine.js';
import {resolveBattlePaste} from '../src/mcp/human-battle.js';

// Explicit genders keep independent random battles comparable at preview.
const paste=readFileSync('examples/sample-team.txt','utf8').replace(/\r\n/g,'\n').replace(/^(\w+) @/gm,'$1 (M) @');
const cleanups:Array<()=>void>=[];
afterEach(()=>{for(const close of cleanups.splice(0).reverse())close();});
function setup(path=':memory:') {
  let now=Date.parse('2026-09-14T12:00:00Z');
  const context=new AppContext({databasePath:path,now:()=>new Date(now)});cleanups.push(()=>context.close());
  return {context,matches:context.humanBattles,advance:(ms:number)=>{now+=ms;}};
}
function start(matches:HumanBattles,mode:'closed'|'open_sheet'='closed',userPaste=paste){
  return matches.start({userPaste,agentPaste:paste,mode});
}
function begin(matches:HumanBattles,battle:ReturnType<typeof start>){
  matches.view(battle.agentToken,'agent');matches.ready(battle.userToken);
}
function preview(matches:HumanBattles,battle:ReturnType<typeof start>){
  begin(matches,battle);const a=matches.view(battle.agentToken,'agent');
  matches.submit(battle.userToken,'user',a.decisionId,'team 1234');
  matches.submit(battle.agentToken,'agent',a.decisionId,'team 1234','Lead plan');
}
describe('human battle referee',()=>{
  it('pins a real M-C format, validates full teams and rejects unsupported regulations',()=>{
    const {matches}=setup();expect(start(matches).profile).toEqual(BATTLE_PROFILE);
    expect(()=>start(matches,'closed',paste.replace('Garchomp','Mewtwo'))).toThrow(/team/i);
    expect(()=>matches.start({userPaste:paste,agentPaste:paste,mode:'closed',regulation:'M-B'})).toThrow(/M-C only/);
    expect(()=>start(matches,'closed',paste.split('\n\n')[0]!)).toThrow(/six/);
  });
  it('accepts new M-C species with the new engine and rejects illegal duplicate items',()=>{
    const mc=paste.replace(/Garchomp \(M\) @ Life Orb[\s\S]*?(?=\n\n)/,'Rillaboom (M) @ Miracle Seed\nAbility: Grassy Surge\nEVs: 32 HP / 32 Atk / 2 SpD\nAdamant Nature\n- Fake Out\n- Grassy Glide\n- Wood Hammer\n- U-turn');
    const {matches}=setup();expect(start(matches,'open_sheet',mc).profile.id).toContain('m-c');
    expect(()=>start(matches,'closed',paste.replace('Focus Sash','Life Orb'))).toThrow(/item/i);
  });
  it('does not silently call an expired supported format latest',()=>{
    const {matches,advance}=setup();advance(100*86400000);
    expect(()=>start(matches)).toThrow(/latest regulation/i);
    expect(matches.start({userPaste:paste,agentPaste:paste,mode:'closed',regulation:'M-C'})).toBeTruthy();
  });
  it('gives closed-sheet agents identical knowledge under private team interventions',()=>{
    const {matches}=setup();
    const changed=paste.replace('Life Orb','Lum Berry').replace('20 Atk / 20 Spe','32 HP / 32 Atk').replace('Jolly Nature','Adamant Nature').replace('- Rock Slide','- Dragon Tail');
    const a=start(matches),b=start(matches,'closed',changed);
    const va=matches.view(a.agentToken,'agent'),vb=matches.view(b.agentToken,'agent');
    expect(va.opponentSheet).toEqual(vb.opponentSheet);
    expect(va.observations).toEqual(vb.observations);
    expect(va.moveInfo).toEqual(vb.moveInfo);
    expect(va.opponentSheet.every(mon=>Object.keys(mon).join()==='species')).toBe(true);
    expect(va.observations.filter(line=>line.startsWith('|poke|p1|')).every(line=>!line.includes(','))).toBe(true);
    expect(JSON.stringify(va)).not.toContain('Lum Berry');
  });
  it('open sheets disclose required fields but are invariant to hidden investments',()=>{
    const {matches}=setup();const a=start(matches,'open_sheet'),b=start(matches,'open_sheet',paste.replace('20 Atk / 20 Spe','32 HP / 32 Atk'));
    const va=matches.view(a.agentToken,'agent'),vb=matches.view(b.agentToken,'agent');
    expect(va.opponentSheet[0]).toMatchObject({species:'Garchomp',item:'Life Orb',ability:'Rough Skin',nature:'Jolly',moves:expect.any(Array)});
    expect(va.opponentSheet).toEqual(vb.opponentSheet);expect(va.observations).toEqual(vb.observations);
    expect(Object.keys(va.opponentSheet[0]!).sort()).toEqual(['ability','item','moves','nature','species']);
  });
  it('does not reveal the human selection, choices or exact enemy health through the agent view',()=>{
    const {matches}=setup(),battle=start(matches);begin(matches,battle);
    const before=matches.view(battle.agentToken,'agent');
    matches.submit(battle.userToken,'user',before.decisionId,'team 6521');
    expect(matches.view(battle.agentToken,'agent')).toEqual(before);
    matches.submit(battle.agentToken,'agent',before.decisionId,'team 1234','hidden-summary','hidden-plan');
    const human=matches.view(battle.userToken,'user');
    expect(JSON.stringify(human)).not.toContain('hidden-plan');expect(JSON.stringify(human)).not.toContain('hidden-summary');
    expect(human.opponentSheet.map(p=>p.species)).toEqual(['Garchomp','Whimsicott','Kingambit','Sneasler','Basculegion','Dragonite']);
  });
  it('starts clocks only after both parties are ready, with a separate 90-second preview',()=>{
    const {matches,advance}=setup(),battle=start(matches);advance(1_000_000);
    expect(matches.view(battle.userToken,'user').timers!.phase).toBe(90_000);
    matches.ready(battle.userToken);advance(1_000_000);matches.view(battle.agentToken,'agent');advance(10_000);
    const view=matches.view(battle.userToken,'user');expect(view.status).toBe('decision');expect(view.timers).toMatchObject({phase:80_000,player:420_000,battle:1_200_000});
  });
  it('defaults to medium effort and supports completely untimed games',()=>{
    const {matches,advance}=setup(),defaults=start(matches);
    expect(defaults.settings).toEqual({userTimer:true,agentTimer:false,reasoningEffort:'medium'});
    expect(defaults.agent.codexSpawn).toEqual({fork_turns:'none',reasoning_effort:'medium'});
    expect(defaults.agent).not.toHaveProperty('model');
    const battle=matches.start({userPaste:paste,agentPaste:paste,mode:'closed',userTimer:false,agentTimer:false,reasoningEffort:'high'});
    begin(matches,battle);advance(86400000);matches.tick();
    expect(matches.view(battle.userToken,'user')).toMatchObject({status:'decision',timers:{phase:90000,player:420000,battle:1200000,running:false,battleRunning:false}});
    expect(matches.view(battle.agentToken,'agent')).toMatchObject({status:'decision',settings:{reasoningEffort:'high'}});
    preview(matches,battle);advance(86400000);matches.tick();
    expect(matches.view(battle.userToken,'user')).toMatchObject({status:'decision',timers:{phase:45000,player:420000,battle:1200000}});
    expect(matches.view(battle.agentToken,'agent').status).toBe('decision');
  });
  it('can time only the agent, including automatic choices and bank forfeiture',()=>{
    const {context,matches,advance}=setup();
    const battle=matches.start({userPaste:paste,agentPaste:paste,mode:'closed',userTimer:false,agentTimer:true});
    begin(matches,battle);advance(90000);matches.tick();
    const user=matches.view(battle.userToken,'user');
    expect(user.status).toBe('decision');expect(user.timers!.phase).toBe(90000);
    expect(matches.view(battle.agentToken,'agent')).toMatchObject({status:'waiting',agentTimer:{phase:0,player:420000,running:false}});
    matches.submit(battle.userToken,'user',user.decisionId,'team 1234');
    advance(45000);matches.tick();
    expect(matches.view(battle.agentToken,'agent')).toMatchObject({status:'waiting',agentTimer:{phase:0,player:375000}});
    const turn=matches.view(battle.userToken,'user');
    expect(turn.timers).toMatchObject({phase:45000,player:420000,battle:1155000});
    // Start the bank check at a known decision, independent of random KOs/forced switches.
    const bankBattle=matches.start({userPaste:paste,agentPaste:paste,mode:'closed',userTimer:false,agentTimer:true});preview(matches,bankBattle);
    context.repository.database.prepare("UPDATE human_battles SET payload_json=json_set(payload_json,'$.agentRemaining.player',1000) WHERE id=?").run(bankBattle.matchId);
    advance(1000);matches.tick();
    expect(matches.view(bankBattle.userToken,'user')).toMatchObject({status:'completed',winner:'You'});
  });
  it('counts simultaneous timers once against shared time and pauses each committed player',()=>{
    const {matches,advance}=setup();
    const battle=matches.start({userPaste:paste,agentPaste:paste,mode:'closed',agentTimer:true});preview(matches,battle);
    advance(10000);let user=matches.view(battle.userToken,'user');
    expect(user.timers).toMatchObject({player:410000,phase:35000,battle:1190000,agent:{player:410000,phase:35000}});
    matches.submit(battle.userToken,'user',user.decisionId,user.legalCommands[0]!);
    advance(10000);user=matches.view(battle.userToken,'user');
    expect(user.timers).toMatchObject({player:410000,phase:35000,battle:1180000,running:false,battleRunning:true,agent:{player:400000,phase:25000,running:true}});
  });
  it('ties when both enabled player banks expire together',()=>{
    const {context,matches,advance}=setup();
    const battle=matches.start({userPaste:paste,agentPaste:paste,mode:'closed',agentTimer:true});preview(matches,battle);
    context.repository.database.prepare("UPDATE human_battles SET payload_json=json_set(payload_json,'$.remaining.player',1000,'$.agentRemaining.player',1000) WHERE id=?").run(battle.matchId);
    advance(1000);matches.tick();
    expect(matches.view(battle.userToken,'user')).toMatchObject({status:'completed',winner:'draw'});
    expect(matches.status(battle.adminToken).results).toEqual([{game:1,winner:'draw'}]);
  });
  it('restores pre-settings saved games with the new defaults',()=>{
    const {context,matches}=setup(),battle=start(matches);
    context.repository.database.prepare("UPDATE human_battles SET payload_json=json_remove(payload_json,'$.settings','$.agentRemaining','$.game','$.memorySince','$.games') WHERE id=?").run(battle.matchId);
    expect(matches.view(battle.userToken,'user')).toMatchObject({game:1,settings:{userTimer:true,agentTimer:false,reasoningEffort:'medium'}});
  });
  it.each(['remember','fresh'] as const)('reports each completed result once across %s rematches',mode=>{
    const {context,matches}=setup(),battle=start(matches);
    expect(matches.status(battle.adminToken).results).toEqual([]);
    begin(matches,battle);
    expect(matches.status(battle.adminToken).results).toEqual([]);
    matches.forfeit(battle.userToken);
    const first=[{game:1,winner:'Agent'}];
    expect(matches.status(battle.adminToken).results).toEqual(first);
    expect(matches.status(battle.adminToken).results).toEqual(first);
    const stored=()=>JSON.parse((context.repository.database.prepare('SELECT payload_json FROM human_battles WHERE id=?').get(battle.matchId) as {payload_json:string}).payload_json);
    expect(stored().games).toHaveLength(0);
    const request=matches.requestRematch(battle.userToken,matches.view(battle.userToken,'user').decisionId,mode);
    expect(matches.status(battle.adminToken).results).toEqual(first);
    const next=matches.rematch(battle.adminToken,request.id);
    matches.rematch(battle.adminToken,request.id);
    expect(matches.status(battle.adminToken).results).toEqual(first);
    expect(stored().games).toHaveLength(1);
    begin(matches,{...battle,agentToken:next.agent.token});
    matches.forfeit(battle.userToken);
    expect(matches.status(battle.adminToken).results).toEqual([...first,{game:2,winner:'Agent'}]);
    expect(stored().games).toHaveLength(1);
    const third=matches.requestRematch(battle.userToken,matches.view(battle.userToken,'user').decisionId,mode);
    matches.rematch(battle.adminToken,third.id);
    matches.cancel(battle.adminToken);
    expect(matches.status(battle.adminToken).results).toEqual([...first,{game:2,winner:'Agent'}]);
  });
  it('rematches with actor-only history, fresh memory epochs, rotated credentials and reset games',()=>{
    const {context,matches,advance}=setup();
    const battle=matches.start({userPaste:paste.replace('Life Orb','Lum Berry'),agentPaste:paste,mode:'closed',userTimer:false,agentTimer:true,reasoningEffort:'high'});
    const finish=(agentToken:string,summary:string)=>{
      const next={...battle,agentToken};begin(matches,next);
      const agent=matches.view(agentToken,'agent');
      matches.submit(battle.userToken,'user',agent.decisionId,'team 6123');
      matches.submit(agentToken,'agent',agent.decisionId,'team 1234',summary,'Private plan');
      matches.forfeit(battle.userToken);
      return matches.view(agentToken,'agent');
    };
    expect(()=>matches.requestRematch(battle.userToken,matches.view(battle.userToken,'user').decisionId,'remember')).toThrow(/only after/);
    const old=finish(battle.agentToken,'First game plan');
    const request=matches.requestRematch(battle.userToken,old.decisionId,'remember');
    expect(matches.requestRematch(battle.userToken,old.decisionId,'remember')).toEqual(request);
    expect(()=>matches.requestRematch(battle.userToken,old.decisionId,'fresh')).toThrow(/different/);
    const second=matches.rematch(battle.adminToken,request.id);
    expect(matches.rematch(battle.adminToken,request.id)).toEqual(second);
    expect(second.settings).toEqual(battle.settings);expect(second.agent.reasoningEffort).toBe('high');
    expect(()=>matches.view(battle.agentToken,'agent')).toThrow(/credential/);
    advance(86400000);
    const lobby=matches.view(battle.userToken,'user');
    expect(lobby).toMatchObject({status:'lobby',game:2,turn:0,ready:{agent:false,user:false},timers:{phase:90000,player:420000,battle:1200000,agent:{player:420000,phase:90000}}});
    expect(lobby.ownTeam).toHaveLength(6);expect(lobby.observations.join('\n')).not.toContain('|win|');
    let agent=matches.view(second.agent.token,'agent');
    expect(agent).toMatchObject({memory:{summary:'First game plan'},priorBattles:[{game:1,summary:'First game plan',observations:old.observations}]});
    expect(agent.priorBattles![0]).not.toHaveProperty('userLog');
    expect(JSON.stringify(agent)).not.toContain('Lum Berry');
    expect(JSON.stringify(lobby)).not.toContain('Private plan');
    expect(()=>matches.submit(second.agent.token,'agent',old.decisionId,'team 1234','stale')).toThrow(/Stale/);
    const game2=finish(second.agent.token,'Second game plan');
    const request3=matches.requestRematch(battle.userToken,game2.decisionId,'remember');
    const third=matches.rematch(battle.adminToken,request3.id);
    expect(matches.view(third.agent.token,'agent').priorBattles).toHaveLength(2);
    expect(()=>matches.rematch(battle.adminToken,request.id)).toThrow(/stale/);
    const game3=finish(third.agent.token,'Third game plan');
    const request4=matches.requestRematch(battle.userToken,game3.decisionId,'fresh');
    const fourth=matches.rematch(battle.adminToken,request4.id);
    expect(fourth.agent.contextPolicy).toContain('fresh context');
    agent=matches.view(fourth.agent.token,'agent');
    expect(agent.memory).toEqual({});expect(agent.priorBattles).toEqual([]);
    expect(JSON.stringify(agent)).not.toContain('First game plan');
    expect(()=>matches.view(third.agent.token,'agent')).toThrow(/credential/);
    const game4=finish(fourth.agent.token,'Fresh epoch plan');
    const fifth=matches.rematch(battle.adminToken,matches.requestRematch(battle.userToken,game4.decisionId,'remember').id);
    expect(matches.view(fifth.agent.token,'agent').priorBattles!.map(g=>g.game)).toEqual([4]);
    const raw=JSON.stringify(context.repository.database.prepare('SELECT * FROM human_battles').all());
    for(const secret of [battle.adminToken,battle.userToken,battle.agentToken,second.agent.token,third.agent.token,fourth.agent.token,fifth.agent.token])expect(raw).not.toContain(secret);
  });
  it('auto-selects preview on deadline and never chooses on behalf of the agent',()=>{
    const {matches,advance}=setup(),battle=start(matches);begin(matches,battle);advance(90_001);matches.tick();
    expect(matches.view(battle.userToken,'user').status).toBe('waiting');
    const agent=matches.view(battle.agentToken,'agent');expect(agent.status).toBe('decision');expect(agent.turn).toBe(0);
    advance(86400_000);expect(matches.view(battle.agentToken,'agent').status).toBe('decision');
    matches.submit(battle.agentToken,'agent',agent.decisionId,'team 1234','Preview');
    expect(matches.view(battle.userToken,'user').timers).toMatchObject({phase:45_000,player:420_000});
  });
  it('locks simultaneous commands, pauses while only agent thinks, and survives restoration',()=>{
    const {matches,advance}=setup(),battle=start(matches);preview(matches,battle);
    let user=matches.view(battle.userToken,'user');const agent=matches.view(battle.agentToken,'agent');
    advance(8_000);matches.submit(battle.userToken,'user',user.decisionId,user.legalCommands[0]!);
    advance(24*3600000);user=matches.view(battle.userToken,'user');
    expect(user.status).toBe('waiting');expect(user.timers).toMatchObject({player:412_000,battle:1_192_000});
    expect(matches.view(battle.agentToken,'agent')).toEqual(agent);
    matches.submit(battle.agentToken,'agent',agent.decisionId,agent.legalCommands[0]!,'Advance');
    expect(matches.view(battle.userToken,'user').decisionId).not.toBe(user.decisionId);
  });
  it('expires at exactly 45 seconds, charges only 45 seconds when a process was suspended',()=>{
    const {matches,advance}=setup(),battle=start(matches);preview(matches,battle);
    advance(3600000);matches.tick();const user=matches.view(battle.userToken,'user');
    expect(user.status).toBe('waiting');expect(user.timers).toMatchObject({phase:0,player:375000,battle:1155000});
    expect(user.observations.join('\n')).toContain('automatically');
  });
  it('rejects stale/illegal choices and makes committed retries idempotent',()=>{
    const {matches,advance}=setup(),battle=start(matches);begin(matches,battle);
    const a=matches.view(battle.agentToken,'agent');advance(1_000);
    expect(()=>matches.submit(battle.userToken,'user','stale','team 1234')).toThrow(/Stale/);
    expect(matches.view(battle.userToken,'user').timers!.phase).toBe(89_000);
    expect(()=>matches.submit(battle.agentToken,'agent',a.decisionId,'move 999')).toThrow(/legal/);
    matches.submit(battle.agentToken,'agent',a.decisionId,'team 1234','same');
    expect(matches.submit(battle.agentToken,'agent',a.decisionId,'team 1234','same')).toEqual({accepted:true});
    expect(()=>matches.submit(battle.agentToken,'agent',a.decisionId,'team 2134','same')).toThrow(/locked/);
  });
  it('does not persist plaintext capabilities, scopes roles and allows independent processes',()=>{
    const dir=mkdtempSync(join(tmpdir(),'vgc-human-'));cleanups.push(()=>rmSync(dir,{recursive:true,force:true}));
    const first=setup(join(dir,'battle.sqlite')),second=setup(join(dir,'battle.sqlite')),battle=start(first.matches);
    expect(second.matches.view(battle.agentToken,'agent').status).toBe('lobby');
    expect(()=>first.matches.view(battle.userToken,'agent')).toThrow(/credential/);
    expect(()=>first.matches.status(battle.agentToken)).toThrow(/credential/);
    const raw=JSON.stringify(first.context.repository.database.prepare('SELECT * FROM human_battles').all());
    for(const secret of [battle.adminToken,battle.agentToken,battle.userToken])expect(raw).not.toContain(secret);
    first.matches.ready(battle.userToken);const a=second.matches.view(battle.agentToken,'agent');
    second.matches.submit(battle.agentToken,'agent',a.decisionId,'team 1234','remote process');
    first.matches.submit(battle.userToken,'user',a.decisionId,'team 1234');
    expect(second.matches.view(battle.agentToken,'agent').turn).toBe(1);
  });
  it('completes an entire engine battle using both player menus including forced switches',()=>{
    const {matches}=setup(),battle=start(matches);preview(matches,battle);
    for(let i=0;i<250;i++){
      const user=matches.view(battle.userToken,'user'),agent=matches.view(battle.agentToken,'agent');
      if(user.ended)break;
      for(const [v,t,r] of [[user,battle.userToken,'user'],[agent,battle.agentToken,'agent']] as const){
        if(v.status!=='decision')continue;
        let accepted=false;
        for(const command of v.legalCommands){if(command.includes('switch') && !v.request.forceSwitch)continue;
          const result=matches.submit(t,r,v.decisionId,command,'test player');if(result.accepted){accepted=true;break;}}
        expect(accepted).toBe(true);
      }
    }
    expect(matches.view(battle.userToken,'user')).toMatchObject({ended:true,status:'completed'});
  },30000);
  it('forfeits without an agent response and supports cancellation',()=>{
    const {matches}=setup(),battle=start(matches);begin(matches,battle);matches.forfeit(battle.userToken);
    expect(matches.view(battle.agentToken,'agent')).toMatchObject({status:'completed',winner:'Agent'});
    const other=start(matches);matches.cancel(other.adminToken);expect(matches.view(other.userToken,'user').status).toBe('cancelled');
  });
  it('enforces the player bank independently of a slow agent or an invalid request',()=>{
    const {context,matches,advance}=setup(),battle=start(matches);preview(matches,battle);
    // Put the saved referee at the last second of its seven-minute bank.
    context.repository.database.prepare("UPDATE human_battles SET payload_json=json_set(payload_json,'$.remaining.player',1000) WHERE id=?").run(battle.matchId);
    const human=matches.view(battle.userToken,'user');advance(1000);
    expect(()=>matches.submit(battle.userToken,'user',human.decisionId,human.legalCommands[0]!)).toThrow(/Stale/);
    expect(matches.view(battle.agentToken,'agent')).toMatchObject({ended:true,status:'completed',winner:'Agent'});
    expect(matches.view(battle.userToken,'user').timers!.player).toBe(0);
  });
  it('defers the shared timer tiebreak until the unlimited agent finishes its current decision',()=>{
    const {context,matches,advance}=setup(),battle=start(matches);preview(matches,battle);
    context.repository.database.prepare("UPDATE human_battles SET payload_json=json_set(payload_json,'$.remaining.battle',1000) WHERE id=?").run(battle.matchId);
    advance(1000);matches.tick();expect(matches.view(battle.userToken,'user').status).toBe('waiting');
    advance(86400000);const agent=matches.view(battle.agentToken,'agent');expect(agent.status).toBe('decision');
    matches.submit(battle.agentToken,'agent',agent.decisionId,agent.legalCommands[0]!,'Finish turn');
    const result=matches.view(battle.userToken,'user');expect(result.ended).toBe(true);expect(result.observations.join('\n')).toContain('tiebreaker');
  });
  it('includes Mega choices, prevents two Megas and duplicates in simultaneous switch menus',()=>{
    const engine=HumanBattleEngine.create(paste,paste,'closed');engine.choose('p1','team 6123');engine.choose('p2','team 1234');engine.resolve();
    const view=engine.view('p1','closed');expect(view.legalCommands.some(c=>c.includes('mega'))).toBe(true);
    expect(view.legalCommands).not.toContain('switch 3, switch 3');
    const command=view.legalCommands.find(c=>c.includes('mega'))!;expect(engine.choose('p1',command)).toBeUndefined();
    expect(engine.choose('p2',engine.view('p2','closed').legalCommands[0]!)).toBeUndefined();engine.resolve();
    expect(engine.view('p1','closed').observations.join('\n')).toContain('|-mega|');
    expect(engine.view('p1','closed').legalCommands.some(c=>c.includes('mega'))).toBe(false);
  });
  it('uses the actual pinned Showdown engine for snapshots and the public timer tiebreak',()=>{
    const e=HumanBattleEngine.create(paste,paste,'closed');e.choose('p1','team 1234');e.choose('p2','team 1234');e.resolve();
    const restored=HumanBattleEngine.restore(e.snapshot());expect(restored.view('p1','closed')).toEqual(e.view('p1','closed'));
    restored.tiebreak();expect(restored.ended).toBe(true);
  });
});
describe('human browser and MCP boundary',()=>{
  it('resolves and launches from bundled rules offline, including unsupported and expired-format guidance',async()=>{
    const {context,matches,advance}=setup();
    const server=createMcpServer(context),client=new Client({name:'rules-test',version:'1'});
    const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
    const network=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('Network unavailable'));
    try{
      const response=await client.callTool({name:'vgc_battle_rules',arguments:{}});
      expect(response.isError).not.toBe(true);
      expect(response.structuredContent).toMatchObject({result:{source:'bundled-pinned-showdown',networkRequired:false,
        selection:{available:true,formatId:BATTLE_PROFILE.format},latestVerified:BATTLE_PROFILE.format,
        defaults:{user_timer:true,agent_timer:false,reasoning_effort:'medium'},
        supportedFormats:[{showdownName:'[Gen 9 Champions] VGC 2026 Reg M-C',teamRules:{requiredTeamSize:6,pickedTeamSize:4,adjustLevel:50,totalInvestmentLimit:66,speciesClause:true,itemClause:true}}],
        timers:{previewMs:90000,turnMs:45000,playerMs:420000,battleMs:1200000}}});
      expect(context.repository.database.prepare('SELECT COUNT(*) AS count FROM human_battles').get()).toEqual({count:0});
      const started=await client.callTool({name:'vgc_battle_start',arguments:{user_team:paste,agent_team:paste,team_sheet:'closed'}});
      expect(started.isError).not.toBe(true);
      expect(started.structuredContent).toMatchObject({result:{rules:matches.rules()}});
      advance(100*86400000);
      expect((await client.callTool({name:'vgc_battle_rules',arguments:{}})).structuredContent).toMatchObject({result:{latestVerified:null,selection:{available:false,reason:expect.stringContaining('not verified')}}});
      expect((await client.callTool({name:'vgc_battle_rules',arguments:{regulation:'M-C'}})).structuredContent).toMatchObject({result:{selection:{available:true},supportedFormats:[{currentInVerifiedWindow:false}]}});
      expect((await client.callTool({name:'vgc_battle_rules',arguments:{regulation:'M-D'}})).structuredContent).toMatchObject({result:{selection:{available:false,reason:expect.stringContaining('M-C only')}}});
      const rejected=await client.callTool({name:'vgc_battle_start',arguments:{user_team:'https://pokepast.es/0123456789abcdef',agent_team:paste,team_sheet:'closed',regulation:'M-D'}});
      expect(rejected.isError).toBe(true);
      expect(network).not.toHaveBeenCalled();
    }finally{network.mockRestore();await client.close();await server.close();}
  });
  it('hands off default and overridden settings through MCP and fulfills a browser rematch across connections',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'vgc-rematch-'));cleanups.push(()=>rmSync(dir,{recursive:true,force:true}));
    const {context,matches}=setup(join(dir,'battle.sqlite')),second=setup(join(dir,'battle.sqlite'));
    const server=createMcpServer(context),client=new Client({name:'test',version:'1'});
    const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
    try{
      const result=await client.callTool({name:'vgc_battle_start',arguments:{user_team:paste,agent_team:paste,team_sheet:'closed'}});
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({result:{settings:{userTimer:true,agentTimer:false,reasoningEffort:'medium'},agent:{codexSpawn:{fork_turns:'none',reasoning_effort:'medium'}}}});
      const custom=await client.callTool({name:'vgc_battle_start',arguments:{user_team:paste,agent_team:paste,team_sheet:'closed',user_timer:false,agent_timer:true,reasoning_effort:'high'}});
      expect(custom.structuredContent).toMatchObject({result:{settings:{userTimer:false,agentTimer:true,reasoningEffort:'high'},agent:{reasoningEffort:'high'}}});
      const battle=(result.structuredContent as {result:{url:string;adminToken:string;agent:{token:string}}}).result;
      const url=new URL(battle.url),userToken=url.hash.slice(1);
      second.matches.forfeit(userToken);
      const old=matches.status(battle.adminToken),user=second.matches.view(userToken,'user');
      const poll=client.callTool({name:'vgc_battle_get',arguments:{admin_token:battle.adminToken,after_state:old.stateId,wait_ms:1000}});
      const headers={Authorization:`Bearer ${userToken}`,Origin:url.origin,'Content-Type':'application/json'};
      const body=JSON.stringify({decisionId:user.decisionId,mode:'fresh'});
      expect((await fetch(url.origin+'/api/rematch',{method:'POST',headers:{...headers,Origin:'https://evil.example'},body})).status).toBe(403);
      expect((await fetch(url.origin+'/api/rematch',{method:'POST',headers:{...headers,Authorization:`Bearer ${battle.agent.token}`},body})).status).toBe(400);
      const response=await fetch(url.origin+'/api/rematch',{method:'POST',headers,body});
      expect(response.status).toBe(200);const request=await response.json() as {id:string;mode:string;game:number};
      expect(Object.keys(request).sort()).toEqual(['game','id','mode']);
      expect((await poll).structuredContent).toMatchObject({result:{rematch:request,results:[{game:1,winner:'Agent'}]}});
      expect(second.matches.status(battle.adminToken).rematch).toEqual(request);
      const args={admin_token:battle.adminToken,request_id:request.id};
      const next=await client.callTool({name:'vgc_battle_rematch',arguments:args});
      expect(next.isError).not.toBe(true);
      expect(next.structuredContent).toMatchObject({result:{game:2,mode:'fresh',agent:{reasoningEffort:'medium'}}});
      expect((await client.callTool({name:'vgc_battle_rematch',arguments:args})).structuredContent).toEqual(next.structuredContent);
      expect(second.matches.view(userToken,'user')).toMatchObject({game:2,status:'lobby'});
      expect(()=>second.matches.view(battle.agent.token,'agent')).toThrow(/credential/);
    }finally{await client.close();await server.close();}
  });
  it('downloads partial and completed replay HTML from only the authenticated human perspective',async()=>{
    const {context,matches}=setup(),battle=start(matches),url=new URL(await context.battleHttp.open(battle.userToken));
    const headers={Authorization:`Bearer ${battle.userToken}`};
    const partial=await fetch(url.origin+'/api/replay',{headers});
    expect(partial.status).toBe(200);
    const body=await partial.json() as {html:string;filename:string};
    expect(body.filename).toMatch(/^Gen9ChampionsVGC2026RegMC-sim-\d{4}(?:-\d{2}){5}\.html$/);
    expect(body.html).toContain('class="battle-log-data"');
    expect(body.html).toContain('https://play.pokemonshowdown.com/js/replay-embed.js');
    expect(body.html).toContain('Partial battle');
    expect(body.html).not.toContain('|showteam|');
    for(const token of [battle.userToken,battle.agentToken,battle.adminToken])expect(body.html).not.toContain(token);
    expect((await fetch(url.origin+'/api/replay',{headers:{Authorization:`Bearer ${battle.agentToken}`}})).status).toBe(400);
    expect((await fetch(url.origin+'/api/replay')).status).toBe(401);
    const textLog=await (await fetch(url.origin+'/api/log',{headers})).json() as {log:string;filename:string};
    // Separate downloads can cross a second boundary.
    expect(textLog.filename).toMatch(/^Gen9ChampionsVGC2026RegMC-sim-\d{4}(?:-\d{2}){5}\.log$/);
    expect(textLog.log).toBe(matches.view(battle.userToken,'user').observations.join('\n'));
    expect((await fetch(url.origin+'/api/log',{headers:{Authorization:`Bearer ${battle.agentToken}`}})).status).toBe(400);
    expect((await fetch(url.origin+'/api/log')).status).toBe(401);
    matches.forfeit(battle.userToken);
    const complete=await (await fetch(url.origin+'/api/replay',{headers})).json() as {html:string};
    expect(complete.html).toContain('|win|Agent');expect(complete.html).not.toContain('Partial battle:');
  });
  it('serves a private loopback UI and rejects cross-origin writes and agent credentials',async()=>{
    const {context,matches}=setup(),battle=start(matches),url=new URL(await context.battleHttp.open(battle.userToken));
    const html=await fetch(url.origin);expect(html.status).toBe(200);expect(await html.text()).toContain('Battlefield');
    expect(html.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    const headers={Authorization:`Bearer ${battle.userToken}`};
    const state=await fetch(url.origin+'/api/view',{headers});expect((await state.json() as {status:string}).status).toBe('lobby');
    expect((await fetch(url.origin+'/api/ready',{method:'POST',headers:{...headers,Origin:'https://evil.example','Content-Type':'application/json'},body:'{}'})).status).toBe(403);
    expect((await fetch(url.origin+'/api/view',{headers:{Authorization:`Bearer ${battle.agentToken}`}})).status).toBe(400);
    expect((await fetch(url.origin+'/api/ready',{method:'POST',headers:{...headers,Origin:url.origin,'Content-Type':'application/json'},body:'{}'})).status).toBe(200);
    expect((await fetch(url.origin+'/api/view',{headers:{...headers,Origin:'https://evil.example'}})).status).toBe(403);
  });
  it('binds isolated agents to exactly two tools and rejects a different token',async()=>{
    const {context,matches}=setup(),battle=start(matches);
    const server=createMcpServer(context,{battleAgentToken:battle.agentToken}),client=new Client({name:'test',version:'1'});
    const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
    try{
      expect((await client.listTools()).tools.map(t=>t.name).sort()).toEqual(['vgc_battle_agent_submit','vgc_battle_agent_view']);
      expect((await client.callTool({name:'vgc_battle_agent_view',arguments:{}})).isError).not.toBe(true);
      expect((await client.callTool({name:'vgc_battle_agent_view',arguments:{agent_token:battle.userToken}})).isError).toBe(true);
      expect((await client.callTool({name:'vgc_battle_start',arguments:{}})).isError).toBe(true);
    }finally{await client.close();await server.close();}
  });
  it('resolves bounded PokePaste raw URLs and blocks arbitrary network targets',async()=>{
    let called='';const fetcher=(async(input:unknown)=>{called=String(input);return new Response(paste);}) as typeof fetch;
    expect(await resolveBattlePaste('https://pokepast.es/0123456789abcdef',fetcher)).toBe(paste);
    expect(called).toBe('https://pokepast.es/0123456789abcdef/raw');
    expect(await resolveBattlePaste('https://pokepast.es/0123456789abcdef/raw',fetcher)).toBe(paste);
    expect(called).toBe('https://pokepast.es/0123456789abcdef/raw');
    await expect(resolveBattlePaste('http://127.0.0.1/private',fetcher)).rejects.toThrow(/Poke|pokepast/);
    expect(await resolveBattlePaste(paste,fetcher)).toBe(paste);
  });
});
