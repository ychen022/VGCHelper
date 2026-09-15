'use strict';
const $=id=>document.getElementById(id);
let credential=location.hash.slice(1);
if(credential){sessionStorage.setItem('vgc-human-token',credential);history.replaceState(null,'','/');}
else credential=sessionStorage.getItem('vgc-human-token');
let view,previousDecision='',previousLog='',selected=[],preview=[],mega='',busy=false,receivedAt=0,board={},pollId=0,appliedPoll=0;
const el=(tag,text,className)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(className)n.className=className;return n;};
const button=(text,action,className)=>{const n=el('button',text,className);n.addEventListener('click',action);return n;};
const name=ident=>(ident||'').split(': ').slice(1).join(': ')||ident||'Pokémon';
const species=details=>(details||'').split(',')[0];
const id=text=>(text||'').toLowerCase().replace(/[^a-z0-9]/g,'');
const spriteId=text=>(text||'').toLowerCase().replace(/[^a-z0-9-]/g,'');
const time=ms=>{const s=Math.ceil(Math.max(0,ms)/1000);return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;};
const showError=message=>{$('error').hidden=!message;$('error').textContent=message||'';};
async function api(path,data){
  const response=await fetch(`/api/${path}`,{method:data===undefined?'GET':'POST',headers:{Authorization:`Bearer ${credential}`,...(data===undefined?{}:{'Content-Type':'application/json'})},...(data===undefined?{}:{body:JSON.stringify(data)})});
  const result=await response.json();if(!response.ok||result.error)throw new Error(result.error||'Request failed');return result;
}
function readBoard(lines){
  const result={};
  for(const line of lines){
    const p=line.split('|'),type=p[1],slot=(p[2]||'').slice(0,3);
    if(type==='-clearallboost'){for(const m of Object.values(result))m.boosts={};continue;}
    if(['switch','drag','replace'].includes(type))result[slot]={name:name(p[2]),species:species(p[3]),condition:p[4]||result[slot]?.condition||'100/100',boosts:{}};
    const mon=result[slot];if(!mon)continue;
    if(['-damage','-heal'].includes(type))mon.condition=p[3];
    if(type==='-sethp'){mon.condition=p[3];const other=result[(p[4]||'').slice(0,3)];if(other)other.condition=p[5];}
    if(type==='faint')mon.condition='0 fnt';
    if(type==='-status')mon.condition=mon.condition.split(' ')[0]+' '+p[3];
    if(type==='-curestatus')mon.condition=mon.condition.split(' ')[0];
    if(['detailschange','-formechange'].includes(type))mon.species=species(p[3]);
    if(type==='-boost')mon.boosts[p[3]]=(mon.boosts[p[3]]||0)+Number(p[4]);
    if(type==='-unboost')mon.boosts[p[3]]=(mon.boosts[p[3]]||0)-Number(p[4]);
    if(type==='-setboost')mon.boosts[p[3]]=Number(p[4]);
    if(type==='-clearboost')mon.boosts={};
    if(type==='-clearnegativeboost')for(const stat of Object.keys(mon.boosts))if(mon.boosts[stat]<0)delete mon.boosts[stat];
    if(type==='-clearpositiveboost')for(const stat of Object.keys(mon.boosts))if(mon.boosts[stat]>0)delete mon.boosts[stat];
    if(type==='-invertboost')for(const stat of Object.keys(mon.boosts))mon.boosts[stat]*=-1;
    if(type==='-copyboost'){const source=result[(p[3]||'').slice(0,3)];if(source)mon.boosts={...source.boosts};}
    if(type==='swap'){const target=slot.slice(0,2)+(Number(p[3])?'b':'a');[result[slot],result[target]]=[result[target],result[slot]];}
  }
  return result;
}
const hp=BattleDisplay.hpPercent;
function monCard(mon,back){
  const node=el('div',undefined,'pokemon'+(mon.condition.includes('fnt')?' fainted':''));
  const bar=el('div',undefined,'statbar');bar.append(el('strong',mon.species),el('span',BattleDisplay.hpText(mon.condition,!back),'condition'));
  const track=el('div',undefined,'hp'),fill=el('i');fill.style.width=`${hp(mon.condition)}%`;fill.className=hp(mon.condition)<=20?'critical':hp(mon.condition)<=50?'low':'';track.append(fill);bar.append(track);
  bar.append(el('div',Object.entries(mon.boosts||{}).filter(([,v])=>v).map(([k,v])=>`${v>0?'+':''}${v} ${k}`).join(' · '),'boosts'));
  const image=el('img');image.alt=mon.species;image.src=`https://play.pokemonshowdown.com/sprites/${back?'gen5-back':'gen5'}/${spriteId(mon.species)}.png`;image.addEventListener('error',()=>image.remove());
  node.append(bar,image);return node;
}
function renderField(){
  board=readBoard(view.observations);
  // The human's own request is the authority for its exact current HP.
  if(!view.request.teamPreview)for(const [i,mon] of view.request.side.pokemon.entries())if(mon.active && i<2){const slot=`p1${i?'b':'a'}`;board[slot]={...board[slot],name:name(mon.ident),species:species(mon.details),condition:mon.condition};}
  $('foes').replaceChildren();$('allies').replaceChildren();
  $('field').classList.toggle('preview',view.turn===0);
  if(view.turn===0){
    const own=view.request.side.pokemon,foe=view.opponentSheet;
    for(const mon of own)$('allies').append(monCard({species:species(mon.details),condition:'100/100'},true));
    for(const mon of foe)$('foes').append(monCard({species:mon.species,condition:'100/100'},false));
  }else for(const slot of ['p2a','p2b','p1a','p1b'])if(board[slot])$(slot.startsWith('p1')?'allies':'foes').append(monCard(board[slot],slot.startsWith('p1')));
  const effects=BattleDisplay.conditions(view);
  $('field-effects').textContent=effects.field.join(' · ');
  for(const [side,element] of [['p1','ally-effects'],['p2','foe-effects']]){
    $(element).replaceChildren(...effects[side].map(text=>el('div',text,'side-effect')));
  }
  renderRosters();
}
function renderRosters(){
  const rosters=BattleDisplay.rosters(view);
  for(const [side,element] of [['p1','user-roster'],['p2','agent-roster']]){
    $(element).replaceChildren(...rosters[side].map(mon=>{
      const status=mon.state==='unknown'?'Selection unconfirmed':mon.state==='not-selected'?'Not selected':mon.state==='fainted'?'Fainted':mon.active?'Active':'Benched';
      const health=mon.condition?BattleDisplay.hpText(mon.condition,side==='p2')+(side==='p2'&&!mon.active?' (last observed)':''):'HP unknown';
      const label=`${mon.species}: ${status}. ${health}.`;
      const card=el('div',undefined,`roster-mon ${mon.state}${mon.active?' active':''}`);card.title=label;card.setAttribute('aria-label',label);card.tabIndex=0;
      const icon=el('img');icon.alt='';icon.src=`https://play.pokemonshowdown.com/sprites/gen5/${spriteId(mon.form)}.png`;icon.addEventListener('error',()=>icon.remove());
      const track=el('div',undefined,'hp'+(mon.condition?'':' unknown-hp')),fill=el('i');
      const percent=mon.condition?hp(mon.condition):0;fill.style.width=`${percent}%`;fill.className=percent<=20?'critical':percent<=50?'low':'';track.append(fill);
      card.append(icon,el('span',mon.species,'roster-name'),track);
      if(mon.state==='unknown')card.append(el('span','?','roster-marker'));
      if(mon.state==='fainted')card.append(el('span','×','roster-marker'));
      if(mon.state==='not-selected')card.append(el('span','–','roster-marker'));
      return card;
    }));
  }
}
function readable(line){
  const fieldEvent=BattleDisplay.fieldEvent(line);if(fieldEvent)return fieldEvent;
  const outcome=BattleDisplay.moveOutcome(line);if(outcome)return outcome;
  const p=line.split('|'),a=(p[2]?.startsWith('p2')?'Opposing ':'')+name(p[2]),b=(p[4]?.startsWith('p2')?'opposing ':'')+name(p[4]);
  switch(p[1]){
    case 'turn':return ['h3',`Turn ${p[2]}`];
    case 'start':return ['h3','The battle begins!'];
    case 'switch':case 'drag':return ['p',`${p[2].startsWith('p1')?'You':'Agent'} sent out ${species(p[3])}!`];
    case 'move':return ['p',`${a} used ${p[3]}${p[4]&&p[4]!==p[2]&&!p[4].startsWith('[')?' → '+b:''}.`];
    case 'faint':return ['p',`${a} fainted!`];
    case '-damage':return ['p',`${a}: ${BattleDisplay.hpText(p[3],p[2].startsWith('p2'))} HP remaining.`,'muted'];
    case '-heal':return ['p',`${a} recovered HP (${BattleDisplay.hpText(p[3],p[2].startsWith('p2'))}).`,'muted'];
    case '-sethp':return ['p',[2,4].filter(i=>p[i]).map(i=>`${p[i].startsWith('p2')?'Opposing ':''}${name(p[i])}: ${BattleDisplay.hpText(p[i+1],p[i].startsWith('p2'))} HP remaining.`).join(' '),'muted'];
    case '-supereffective':return ['p',"It's super effective!",'muted'];
    case '-resisted':return ['p',"It's not very effective…",'muted'];
    case '-crit':return ['p','A critical hit!','muted'];
    case '-miss':return ['p',`${a}'s attack missed.`,'muted'];
    case '-immune':return ['p',`${a} is immune.`,'muted'];
    case '-mega':return ['p',`${a} Mega Evolved!`];
    case '-status':return ['p',`${a}: ${p[3]}`];
    case '-boost':case '-unboost':return ['p',`${a}'s ${p[3]} ${p[1]==='-boost'?'rose':'fell'} (${p[4]}).`,'muted'];
    case '-sidestart':case '-sideend':return ['p',`${a}: ${p[3]} ${p[1]==='-sidestart'?'began':'ended'}.`];
    case '-start':case '-end':case '-activate':case '-ability':case '-item':case '-enditem':case '-singleturn':case '-singlemove':return ['p',[a,...p.slice(3)].join(' · '),'muted'];
    case 'win':return ['h3',`${p[2]} won the battle!`];
    case 'tie':return ['h3','The battle ended in a tie.'];
    case 'message':case '-message':return ['p',p[2]];
    default:return null;
  }
}
function renderLog(){
  const log=view.observations.join('\n');if(log===previousLog)return;
  const lines=previousLog && log.startsWith(previousLog+'\n')?log.slice(previousLog.length+1).split('\n'):view.observations;
  if(lines===view.observations)$('log').replaceChildren();
  const stick=$('log').scrollHeight-$('log').scrollTop-$('log').clientHeight<70;
  for(const line of lines){const text=readable(line);if(text)$('log').append(el(...text));}
  $('raw-log').textContent=log;if(stick)$('log').scrollTop=$('log').scrollHeight;
  previousLog=log;renderField();
}
function renderSheets(){
  $('sheet-note').textContent=view.mode==='closed'?'Closed team sheet: the opponent’s starting sheet contains species only. Other information is learned during play.':'Open team sheet: species, moves, items, abilities and natures. Opposing stats and investments stay hidden.';
  const columns=[];
  for(const [title,team] of [['Your team',view.ownTeam],['Agent’s team',view.opponentSheet]]){
    const col=el('div');col.append(el('h3',title));
    for(const mon of team){const card=el('div',undefined,'sheet-card');card.append(el('strong',mon.species));
      if(mon.moves){card.append(el('p',`${mon.item||'No item'} · ${mon.ability} · ${mon.nature}`),el('p',mon.moves.join(' / ')));}
      if(mon.evs)card.append(el('p','Your investments: '+Object.entries(mon.evs).filter(([,v])=>v).map(([k,v])=>`${k} ${v}`).join(' / ')));
      col.append(card);
    }columns.push(col);
  }$('sheet-content').replaceChildren(...columns);
}
function choicesWithPrefix(){return view.legalCommands.map(c=>c.split(', ')).filter(parts=>selected.every((v,i)=>parts[i]===v));}
function pick(choice){selected.push(choice);mega='';renderControls();}
function targetName(target){const n=Number(target);return (n>0?'Opponent: ':'Ally: ')+(board[`${n>0?'p2':'p1'}${Math.abs(n)===1?'a':'b'}`]?.species||`slot ${Math.abs(n)}`);}
async function submit(){
  const command=view.request.teamPreview?'team '+preview.join(''):selected.join(', ');
  if(!view.legalCommands.includes(command))return showError('Complete both choices before submitting.');
  busy=true;renderControls();
  try{await api('choose',{decisionId:view.decisionId,command});showError('');await poll();}catch(error){showError(error.message);await poll();}
  finally{busy=false;renderControls();}
}
function renderControls(){
  const root=$('controls');root.replaceChildren();
  if(view.status==='lobby'){
    root.append(el('h2',view.ready.agent?'Your opponent is ready.':'Waiting for the agent to connect…'),el('p',`Choose four Pokémon when preview begins. The first two lead. ${view.settings.userTimer?'Your 90-second preview starts':'Your preview has no time limit and begins'} only after you press Begin and the agent connects.`,'selection-help'));
    const begin=button(view.ready.user?'Ready — waiting for agent':'Begin team preview',async()=>{try{await api('ready',{});await poll();}catch(error){showError(error.message);}},'primary');begin.disabled=view.ready.user;root.append(begin);return;
  }
  if(view.status!=='decision') {
    root.append(el('h2',view.status==='waiting'?'Waiting for the agent…':view.status==='cancelled'?'Battle cancelled':view.winner==='draw'?'A draw.':`${view.winner} won!`),el('p',view.status==='waiting'?`Your choice is locked. ${view.settings.agentTimer?'The agent’s timer is running.':'The agent can think for as long as needed.'}`:'Download the replay to review this game.','selection-help'));
    if(view.status==='completed'){
      if(view.rematch)root.append(el('p',`Rematch requested: ${view.rematch.mode==='remember'?'keep memory':'fresh agent'}. Waiting for your conversation agent to prepare game ${view.rematch.game}…`,'selection-help'));
      else {
        root.append(el('p','Play again with the same teams and settings. Keep memory lets the agent learn from earlier games; fresh agent starts without that history.','selection-help'));
        const actions=el('div',undefined,'targets');
        for(const [mode,label] of [['remember','Rematch · keep memory'],['fresh','Rematch · fresh agent']]){
          const next=button(label,async()=>{
            busy=true;renderControls();
            try{await api('rematch',{decisionId:view.decisionId,mode});showError('');await poll();}catch(error){showError(error.message);}
            finally{busy=false;renderControls();}
          });next.disabled=busy;actions.append(next);
        }root.append(actions);
      }
    }return;
  }
  if(view.request.teamPreview){
    root.append(el('h2',`Choose your four · ${preview.length}/4`,'selection-title'),el('p','Select in order: lead 1, lead 2, reserve 1, reserve 2. Click a selected Pokémon to remove it.','selection-help'));
    const grid=el('div',undefined,'choices');
    view.request.side.pokemon.forEach((mon,i)=>{const order=preview.indexOf(i+1);const b=button('',()=>{if(order>=0)preview.splice(order,1);else if(preview.length<4)preview.push(i+1);renderControls();},'choice'+(order>=0?' selected':''));b.append(el('strong',species(mon.details)),el('small',view.ownTeam[i].moves.join(' · ')));if(order>=0)b.append(el('span',String(order+1),'order'));grid.append(b);});root.append(grid);
    const go=button('Confirm team',submit,'primary');go.disabled=busy||preview.length!==4;root.append(go);return;
  }
  let candidates=choicesWithPrefix();
  while(candidates.length && selected.length<candidates[0].length && candidates.every(c=>c[selected.length]==='pass')){selected.push('pass');candidates=choicesWithPrefix();}
  const slot=selected.length,complete=candidates.length && slot===candidates[0].length;
  const mon=view.request.side.pokemon[slot];
  root.append(el('h2',complete?'Ready to submit':`${view.request.forceSwitch?'Replace':'What will'} ${name(mon?.ident)}${view.request.forceSwitch?'':' do?'}`,'selection-title'));
  if(!complete){
    const options=[...new Set(candidates.map(c=>c[slot]))];
    const megaSuffix=command=>command.match(/ (mega[xy]?)$/)?.[1]||'';
    const megaOptions=[...new Set(options.map(megaSuffix).filter(Boolean))];
    if(!megaOptions.includes(mega))mega='';
    if(megaOptions.length){
      const toggles=el('div',undefined,'mega');
      for(const variant of megaOptions){
        const label=variant==='megax'?'Mega Evolve X':variant==='megay'?'Mega Evolve Y':'Mega Evolve';
        const toggle=button(label,()=>{mega=mega===variant?'':variant;renderControls();},'mega-toggle');
        toggle.setAttribute('aria-pressed',String(mega===variant));
        toggle.title='Mega Evolve with this Pokémon’s move this turn. Switching does not use Mega Evolution.';
        toggles.append(toggle);
      }
      root.append(toggles);
    }
    const moves=options.filter(c=>c.startsWith('move ')&&megaSuffix(c)===mega),grid=el('div',undefined,'choices');
    const active=view.request.active?.[slot];
    for(const moveIndex of [...new Set(moves.map(c=>c.split(' ')[1]))]){
      const move=active.moves[Number(moveIndex)-1],info=view.moveInfo[id(move.id)]||{};
      const b=button('',()=>{
        const targets=el('div',undefined,'targets');
        for(const command of moves.filter(c=>c.split(' ')[1]===moveIndex)){
          const words=command.split(' '),target=words.find((word,i)=>i>1&&/^-?\d+$/.test(word));
          targets.append(button(target?targetName(target):'Use '+move.move,()=>pick(command)));
        }
        if(targets.childNodes.length===1){pick(moves.find(c=>c.split(' ')[1]===moveIndex));return;}
        const old=root.querySelector('.targets');if(old)old.remove();grid.after(targets);
      },'choice');
      b.title=info.description||'';b.append(el('strong',move.move),el('small',`${info.type||''} · ${move.pp??'—'}/${move.maxpp??'—'} PP · ${info.category||''}${info.power?' · '+info.power+' power':''}`));grid.append(b);
    }root.append(grid);
    const switches=el('div',undefined,'switches');
    for(const command of options.filter(c=>c.startsWith('switch '))){const replacement=view.request.side.pokemon[Number(command.split(' ')[1])-1];switches.append(button('Switch: '+name(replacement.ident)+' · '+replacement.condition,()=>pick(command)));}
    if(options.includes('pass'))switches.append(button('Pass this slot',()=>pick('pass')));
    root.append(switches);
  }
  const bar=el('div',undefined,'actionbar');bar.append(el('div',selected.length?selected.map((c,i)=>`${i+1}. ${describe(c,i)}`).join(' / '):'Choose an action, then a target.','summary'));
  if(selected.length)bar.append(button('Reset choices',()=>{selected=[];mega='';renderControls();}));
  if(complete){const go=button('Confirm turn',submit,'primary');go.disabled=busy;bar.append(go);}root.append(bar);
}
function describe(command,slot){const p=command.split(' ');if(p[0]==='move')return (view.request.active?.[slot]?.moves[Number(p[1])-1]?.move||command)+(p[2]&&/^-?\d+$/.test(p[2])?' → '+targetName(p[2]):'')+(command.includes('mega')?' (Mega)':'');if(p[0]==='switch')return 'Switch '+name(view.request.side.pokemon[Number(p[1])-1].ident);return command;}
async function poll(){
  if(!credential){showError('Open the private battle link supplied in your conversation.');return;}
  try{
    const currentPoll=++pollId,next=await api('view');if(currentPoll<appliedPoll)return;appliedPoll=currentPoll;
    const key=next.decisionId+':'+next.status+':'+JSON.stringify(next.legalCommands)+':'+JSON.stringify(next.ready)+':'+next.rematch?.id;
    view=next;receivedAt=performance.now();$('connection').textContent='● Local';$('mode').textContent=view.mode==='open_sheet'?'Open team sheet':'Closed team sheet';$('turn').textContent=`Game ${view.game} · ${view.turn?'Turn '+view.turn:'Team preview'}`;
    $('timer-note').textContent=view.timers.policy+((view.settings.userTimer||view.settings.agentTimer)?' Enabled timers: 90-second preview, 45-second selections, 7-minute player bank. Selection expiry chooses automatically; an empty player bank loses.':' Both players have unlimited time.');
    $('status').textContent=view.status==='decision'?(view.request.teamPreview?'Team preview — select your four':'Your move — choose both actions'):view.status==='waiting'?'Agent thinking · your clocks are paused':view.status==='lobby'?'Battle lobby · timers have not started':view.status==='cancelled'?'Battle cancelled':'Battle complete';
    if(key!==previousDecision){selected=[];preview=[];mega='';previousDecision=key;renderControls();renderSheets();}
    renderLog();$('forfeit').disabled=['completed','cancelled'].includes(view.status);renderClocks();
  }catch(error){$('connection').textContent='● Disconnected';showError(error.message+' Reconnecting…');}
}
function renderClocks(){
  if(!view)return;const t=view.timers,elapsed=performance.now()-receivedAt;
  const clocks=[
    ['player-clock',t.player,view.settings.userTimer,t.running&&!t.preview],
    ['phase-clock',t.phase,view.settings.userTimer,t.running],
    ['battle-clock',t.battle,view.settings.userTimer||view.settings.agentTimer,t.battleRunning&&!t.preview],
    ['agent-clock',t.agent.player,view.settings.agentTimer,t.agent.running&&!t.preview],
    ['agent-phase-clock',t.agent.phase,view.settings.agentTimer,t.agent.running],
  ];
  for(const [element,remaining,enabled,running] of clocks){const left=remaining-(running?elapsed:0);$(element).textContent=enabled?time(left):'∞';$(element).classList.toggle('urgent',enabled&&running&&left<=15000);}
}
$('sheet-toggle').addEventListener('click',()=>{$('sheets').hidden=!$('sheets').hidden;});
function download(content,type,filename){const url=URL.createObjectURL(new Blob([content],{type}));const a=el('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
$('download').addEventListener('click',async()=>{if(!view)return;$('download').disabled=true;try{const replay=await api('replay');download(replay.html,'text/html',replay.filename);}catch(error){showError(error.message);}finally{$('download').disabled=false;}});
$('download-text').addEventListener('click',async()=>{if(!view)return;$('download-text').disabled=true;try{const log=await api('log');download(log.log,'text/plain',log.filename);}catch(error){showError(error.message);}finally{$('download-text').disabled=false;}});
$('forfeit').addEventListener('click',async()=>{if(!confirm('Forfeit this battle?'))return;try{await api('forfeit',{});await poll();}catch(error){showError(error.message);}});
async function loop(){await poll();setTimeout(loop,800);}loop();setInterval(renderClocks,150);
