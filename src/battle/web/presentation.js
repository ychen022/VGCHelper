'use strict';
// Reconstruct display state exclusively from the player's sheets and protocol channel.
globalThis.BattleDisplay=(()=>{
  const id=value=>(value||'').toLowerCase().replace(/[^a-z0-9]/g,'');
  const clean=value=>(value||'').replace(/^(move|ability): /,'');
  const durations={tailwind:4,reflect:5,lightscreen:5,auroraveil:5,safeguard:5,mist:5,
    firepledge:4,waterpledge:4,grasspledge:4,trickroom:5,magicroom:5,wonderroom:5,gravity:5,fairylock:2,
    electricterrain:5,grassyterrain:5,mistyterrain:5,psychicterrain:5,
    raindance:5,sunnyday:5,sandstorm:5,snowscape:5,hail:5,wideguard:1,quickguard:1,craftyshield:1,matblock:1};
  const permanent=new Set(['spikes','toxicspikes','stealthrock','stickyweb','primordialsea','desolateland','deltastream']);
  const extenders={reflect:'lightclay',lightscreen:'lightclay',auroraveil:'lightclay',
    raindance:'damprock',sunnyday:'heatrock',sandstorm:'smoothrock',snowscape:'icyrock',hail:'icyrock',
    electricterrain:'terrainextender',grassyterrain:'terrainextender',mistyterrain:'terrainextender',psychicterrain:'terrainextender'};
  const names={raindance:'Rain',sunnyday:'Sun',snowscape:'Snow',firepledge:'Sea of Fire',waterpledge:'Rainbow',grasspledge:'Swamp'};
  function hpPercent(condition){const [current,max]=(condition||'0').split(' ')[0].split('/').map(Number);return max?Math.min(100,current/max*100):current;}
  function hpText(condition,opponent){if(!opponent)return condition;const status=(condition||'').split(' ').slice(1).join(' ');return `${Number(hpPercent(condition).toFixed(1))}%${status?' '+status:''}`;}
  function conditions(view){
    const field=new Map(),sides={p1:new Map(),p2:new Map()},items=new Map(),abilities=new Map(),embargo=new Set();
    const teams={p1:view.ownTeam,p2:view.opponentSheet};let lastMover='';
    const identity=ident=>ident.replace(/^p([12])[a-z]: /,'p$1: ');
    const setCondition=(map,key,label,source)=>{
      const effect=id(clean(label)),duration=durations[effect],item=items.get(identity(source)),extender=extenders[effect];
      const suppressed=field.has('magicroom')||embargo.has(identity(source))||abilities.get(identity(source))==='klutz';
      const maximum=extender&&!suppressed?(item===undefined?[duration,8]:[item===extender?8:duration]):[duration];
      // Extra hazard layers do not restart a timer.
      if(permanent.has(effect)&&map.has(key))return;
      map.set(key,{name:names[effect]||clean(label),maximum,elapsed:0,permanent:permanent.has(effect)});
    };
    for(const line of view.observations){
      const p=line.split('|'),event=p[1],actor=p[2]||'',effect=id(clean(p[3])),source=p.find(v=>v.startsWith('[of] '))?.slice(5)||lastMover;
      if(['switch','drag','replace'].includes(event)){
        const mon=teams[actor.slice(0,2)]?.find(mon=>id(mon.species)===id(p[3].split(',')[0]));
        const key=identity(actor);if(!items.has(key)&&mon?.item!==undefined)items.set(key,id(mon.item));
        if(!abilities.has(key)&&mon?.ability!==undefined)abilities.set(key,id(mon.ability));
        embargo.delete(key);
      }
      if(event==='move')lastMover=actor;
      if(event==='-item')items.set(identity(actor),id(p[3]));
      if(event==='-enditem')items.set(identity(actor),'');
      if(event==='-ability')abilities.set(identity(actor),id(p[3]));
      if(event==='-start'&&effect==='embargo')embargo.add(identity(actor));
      if(event==='-end'&&effect==='embargo')embargo.delete(identity(actor));
      if(event==='-weather'&&!p.includes('[upkeep]')){if(actor==='none')field.delete('weather');else setCondition(field,'weather',actor,source);}
      if(event==='-fieldstart')setCondition(field,id(clean(actor)),actor,source);
      if(event==='-fieldend')field.delete(id(clean(actor)));
      if(event==='-sidestart'&&sides[actor.slice(0,2)])setCondition(sides[actor.slice(0,2)],effect,p[3],source);
      if(event==='-singleturn'&&durations[effect]===1&&sides[actor.slice(0,2)])setCondition(sides[actor.slice(0,2)],effect,p[3],actor);
      if(event==='-sideend')sides[actor.slice(0,2)]?.delete(effect);
      if(event==='-swapsideconditions'){
        for(const key of new Set([...sides.p1.keys(),...sides.p2.keys()])){
          if(['wideguard','quickguard','craftyshield','matblock'].includes(key))continue;
          const a=sides.p1.get(key),b=sides.p2.get(key);sides.p1.delete(key);sides.p2.delete(key);
          if(a)sides.p2.set(key,a);if(b)sides.p1.set(key,b);
        }
      }
      // Upkeep marks a completed round; turn 1 and mid-turn replacements consume no turns.
      if(event==='upkeep'){
        lastMover='';for(const map of [field,sides.p1,sides.p2])for(const [key,value] of map){
          value.elapsed++;
          if(value.maximum[0]!==undefined&&value.maximum.every(max=>max<=value.elapsed))map.delete(key);
        }
      }
    }
    const format=map=>[...map.values()].map(value=>{
      if(value.permanent)return `${value.name} (∞/∞ turns)`;
      if(value.maximum[0]===undefined)return `${value.name} (?/? turns)`;
      const max=value.maximum.filter(max=>max>value.elapsed);
      return `${value.name} (${max.map(max=>max-value.elapsed).join('–')}/${max.join('–')} turns)`;
    });
    return {field:format(field),p1:format(sides.p1),p2:format(sides.p2)};
  }
  function rosters(view){
    const teams={p1:view.ownTeam.map(mon=>({species:mon.species,form:mon.species,state:'unknown',condition:null,active:false})),
      p2:view.opponentSheet.map(mon=>({species:mon.species,form:mon.species,state:'unknown',condition:null,active:false}))};
    const slots=new Map();
    const find=(ident,details='')=>{
      const team=teams[ident.slice(0,2)]||[],name=ident.split(': ').slice(1).join(': ');
      return team.find(mon=>id(mon.species)===id(name))||team.find(mon=>id(mon.species)===id(details.split(',')[0]));
    };
    const get=ident=>slots.get(ident.slice(0,3))?.mon||find(ident);
    const health=(mon,condition)=>{if(!mon||!condition)return;mon.condition=condition;mon.state=condition.includes('fnt')?'fainted':'alive';if(mon.state==='fainted')mon.active=false;};
    for(const line of view.observations){
      const p=line.split('|'),event=p[1],actor=p[2]||'',slot=actor.slice(0,3);
      if(['switch','drag','replace'].includes(event)){
        const old=slots.get(slot),mon=find(actor,p[3]),previousHealth=old?.mon.condition;
        if(old)old.mon.active=false;
        // Illusion's replace reveals the real entrant; undo the impersonated roster entry.
        if(event==='replace'&&old&&old.mon!==mon)Object.assign(old.mon,old.before);
        if(mon){const before={...mon};health(mon,p[4]||previousHealth);mon.active=mon.state!=='fainted';mon.form=p[3].split(',')[0];slots.set(slot,{mon,before});}
        else slots.delete(slot);
        continue;
      }
      if(event==='swap'){
        const other=slot.slice(0,2)+(Number(p[3])?'b':'a'),a=slots.get(slot),b=slots.get(other);
        slots.delete(slot);slots.delete(other);if(a)slots.set(other,a);if(b)slots.set(slot,b);continue;
      }
      const mon=get(actor);
      if(['-damage','-heal','-sethp'].includes(event))health(mon,p[3]);
      if(event==='-sethp')health(get(p[4]||''),p[5]);
      if(event==='faint')health(mon,'0 fnt');
      if(event==='-status'&&mon?.condition)mon.condition=mon.condition.split(' ')[0]+' '+p[3];
      if(event==='-curestatus'&&mon?.condition)mon.condition=mon.condition.split(' ')[0];
      if(event==='-cureteam')for(const member of teams[actor.slice(0,2)]||[])if(member.condition&&member.state!=='fainted')member.condition=member.condition.split(' ')[0];
      if(['detailschange','-formechange'].includes(event)&&mon)mon.form=p[3].split(',')[0];
    }
    // The human knows its selected reserves and exact current HP, including off-field healing.
    if(view.turn>0){
      for(const mon of teams.p1){mon.state='not-selected';mon.condition=null;mon.active=false;}
      for(const member of view.request.side.pokemon){const mon=find(member.ident,member.details);if(mon){health(mon,member.condition);mon.active=!!member.active&&mon.state!=='fainted';}}
    }
    return teams;
  }
  function fieldEvent(line){
    const p=line.split('|'),event=p[1];
    if(!['-fieldstart','-fieldend','-weather'].includes(event))return null;
    const condition=names[id(clean(p[2]))]||clean(p[2]);
    if(event==='-fieldend')return ['p',`${condition} ended.`,'muted'];
    if(event==='-weather'&&p[2]==='none')return ['p','The weather cleared.','muted'];
    if(p.includes('[upkeep]'))return ['p',`${condition} continues.`,'muted'];
    const ability=p.find(part=>part.startsWith('[from] ability: '))?.slice('[from] ability: '.length);
    const source=p.find(part=>part.startsWith('[of] '))?.slice('[of] '.length);
    const pokemon=source?.split(': ').slice(1).join(': ');
    const actor=pokemon?`${source.startsWith('p1')?'Your ':source.startsWith('p2')?'Opposing ':''}${pokemon}`:'';
    if(ability)return ['p',`${actor?actor+"'s ":''}${ability} started ${condition}!`,'muted'];
    return ['p',actor?`${actor} started ${condition}.`:`${condition} began.`,'muted'];
  }
  function moveOutcome(line){
    const p=line.split('|'),event=p[1],actor=(p[2]?.startsWith('p2')?'Opposing ':'')+(p[2]?.split(': ').slice(1).join(': ')||'The Pokémon'),effect=clean(p[3]);
    if(event==='-fail'){
      const reasons={heal:'its HP is already full',brn:'the target is already burned',par:'the target is already paralyzed',slp:'the target is already asleep',psn:'the target is already poisoned',tox:'the target is already poisoned',unboost:'the stat cannot go any lower',boost:'the stat cannot go any higher',substitute:'a substitute is already present'};
      return ['p',`${actor}'s ${p[3]?.startsWith('move: ')?effect:'move'} failed!${reasons[p[3]]?' '+reasons[p[3]][0].toUpperCase()+reasons[p[3]].slice(1)+'.':''}`,'failed'];
    }
    if(event==='-notarget')return ['p','But there was no target!','failed'];
    if(event==='cant'){
      const reasons={flinch:'flinched and could not move',par:'is fully paralyzed and could not move',slp:'is asleep and could not move',frz:'is frozen and could not move',recharge:'must recharge',truant:'is loafing around',nopp:'has no PP left for this move',taunt:'cannot use this status move because of Taunt',Disable:'cannot use its disabled move',Imprison:'cannot use this move because of Imprison'};
      return ['p',`${actor} ${reasons[p[3]]||`could not move (${effect||'unable to act'})`}.`,'failed'];
    }
    if(event==='-singleturn'&&['Protect','Detect','Spiky Shield','Baneful Bunker','Burning Bulwark','Silk Trap','Obstruct','King’s Shield',"King's Shield"].includes(effect))return ['p',`${actor} protected itself with ${effect}!`,'muted'];
    if(event==='-singleturn'&&effect==='Endure')return ['p',`${actor} braced itself with Endure!`,'muted'];
    if(event==='-activate'&&['Protect','Detect','Spiky Shield','Baneful Bunker','Burning Bulwark','Silk Trap','Obstruct',"King's Shield"].includes(effect))return ['p',`${actor} blocked the attack with ${effect}!`,'muted'];
    if(event==='-block')return ['p',`${actor} blocked the move${effect?' with '+effect:''}!`,'muted'];
    return null;
  }
  return {hpPercent,hpText,conditions,rosters,fieldEvent,moveOutcome};
})();
