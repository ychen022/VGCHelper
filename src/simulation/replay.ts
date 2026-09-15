import type {NormalizedEvent,ParsedReplay,PokemonTeam} from '../domain/contracts.js';
import {normalizeEvents} from '../replay/parser.js';
import {readOpenSheet} from '../replay/sheets.js';
import {sha256} from '../util/hash.js';
import {speciesIdentity} from './identity.js';
import {ENGINE_PROFILE,EngineSession,validateEngineTeam,type EngineCheckpoint,type EngineSeed,type PlayerSide} from './engine.js';

export class UnsupportedReplayError extends Error {
  readonly code='UNSUPPORTED_REPLAY_STATE';
  constructor(readonly reasons:string[]) {super(reasons.join('; '));this.name='UnsupportedReplayError';}
}
export interface ReplayStartCheckpoint extends EngineCheckpoint {
  reconstruction:{kind:'public-prefix-sampled';decisionTurn:number;publicPrefixHash:string;conditioningAttempts:number;transitionAcceptances:number;retainedParticles:number;weighting:'uniform-legal-command-prior-with-transition-rejection';warnings:string[]};
}
const id=(value:string)=>value.toLowerCase().replace(/[^a-z0-9]/g,'');
const speciesId=speciesIdentity;
const unsupported=(reason:string):never=>{throw new UnsupportedReplayError([reason]);};
function derivedSeed(seed:EngineSeed,label:string):EngineSeed {
  const hash=sha256(`${seed.join(',')}:${label}`);
  return [0,1,2,3].map(i=>parseInt(hash.slice(i*4,i*4+4),16)) as EngineSeed;
}
const ignored=new Set(['t:','message','hint','raw','html','uhtml','uhtmlchange','debug','inactive','inactiveoff','j','join','l','leave','c','c:','chat','player']);
function mechanics(events:NormalizedEvent[]):NormalizedEvent[] {
  return events.filter(event=>!ignored.has(event.type));
}
function token(value:string):string {
  return value.replace(/(p[12][a-d]?): [^|]+/g,'$1');
}
function hpMatches(observed:string,predicted:string):boolean {
  if(observed===predicted)return true;
  const a=observed.match(/^(\d+)\/(\d+)(.*)$/),b=predicted.match(/^(\d+)\/(\d+)(.*)$/);
  if(!a||!b||a[3]!==b[3])return false;
  const current=Number(a[1]),max=Number(a[2]),actual=Number(b[1]),actualMax=Number(b[2]);
  // Modern public Showdown logs round positive HP upwards to a percentage.
  // Exact fractions are accepted only as exact values, never reverse engineered.
  return max===100 ? current===Math.ceil(actual*100/actualMax) : max===actualMax && current===actual;
}
function projectionsMatch(expected:NormalizedEvent[],actual:NormalizedEvent[]):boolean {
  const a=mechanics(expected),b=mechanics(actual);
  if(a.length!==b.length)return false;
  return a.every((event,i)=>{
    const other=b[i]!;
    if(event.type!==other.type || event.args.length!==other.args.length)return false;
    if(!event.args.every((arg,j)=>{
      const candidate=other.args[j]!;
      if((event.type==='switch' && j===2) || (['-damage','-heal','-sethp'].includes(event.type) && j===1))return hpMatches(arg,candidate);
      if(event.type==='switch' && j===1) {
        // Omitted level/gender means unobserved, not evidence of a different value.
        const fields=arg.split(',').map(s=>s.trim());
        const candidateFields=candidate.split(',').map(s=>s.trim());
        const form=(name:string)=>id(name).replace(/^aegislashshield$/,'aegislash').replace(/^floetteeternalflower$/,'floetteeternal').replace(/^floetteeternalmega$/,'floettemega');
        return form(fields[0]!)===form(candidateFields[0]!) && fields.slice(1).every(field=>candidateFields.includes(field));
      }
      return token(arg)===token(candidate);
    }))return false;
    const tags=(e:NormalizedEvent)=>Object.entries(e.tags).map(([key,value])=>[key,typeof value==='string'?token(value):value]).sort();
    return JSON.stringify(tags(event))===JSON.stringify(tags(other));
  });
}
export function assertPreviewMatches(expected:NormalizedEvent[],actual:NormalizedEvent[]):void {
  const normalize=(events:NormalizedEvent[])=>events.filter(e=>e.type!=='showteam').map(e=>e.type==='tier'?{...e,args:e.args.map(arg=>arg.replace(/ \(Bo3\)$/,''))}:e);
  const tiers=expected.filter(e=>e.type==='tier').map(e=>id(e.args[0]??''));
  if(!tiers.length||new Set(tiers).size!==1||tiers.some(t=>![ENGINE_PROFILE.format,ENGINE_PROFILE.format+'bo3'].includes(t)))unsupported('Preview format must be explicit, consistent Champions M-C');
  if(!projectionsMatch(normalize(expected),normalize(actual)))unsupported('Preview mechanical history conflicts with a fresh sampled world');
}
export function constrainReplayTeam(team:PokemonTeam,side:PlayerSide,prefix:NormalizedEvent[]):PokemonTeam {
  const result=structuredClone(team);
  const previews=prefix.filter(event=>event.type==='poke' && event.args[0]===side);
  if(previews.length!==6)unsupported(`A full six-species ${side} public preview is required`);
  const expected=previews.map(event=>speciesId(event.args[1]!)).sort();
  if(JSON.stringify(expected)!==JSON.stringify(result.pokemon.map(p=>speciesId(p.species)).sort()))unsupported(`${side} supplied candidate conflicts with the public preview`);
  for(const preview of previews) {
    const pokemon=result.pokemon.find(p=>speciesId(p.species)===speciesId(preview.args[1]!))!;
    const gender=preview.args[1]!.split(',').map(value=>value.trim()).find(value=>value==='M'||value==='F');
    if(gender&&pokemon.gender&&pokemon.gender!==gender)unsupported(`${side} candidate gender conflicts with the public preview`);
    if(gender)pokemon.gender=gender;
  }
  // Retain publicly revealed identities when original history is joined to future logs.
  for(const event of prefix.filter(e=>e.type==='switch'&&e.args[0]?.startsWith(side))){
    const set=result.pokemon.find(p=>speciesId(p.species)===speciesId(event.args[1]!));
    const nickname=event.args[0]!.split(': ').slice(1).join(': ');
    if(set&&nickname)set.nickname=nickname;
  }
  for(const event of prefix.filter(e=>e.type==='showteam' && e.args[0]===side)) {
    for(const sheet of readOpenSheet(event.args[1]!)) {
      const set=result.pokemon.find(p=>speciesId(p.species)===speciesId(sheet.species));
      if(!set || ['item','ability','nature'].some(field=>{
        const key=field as 'item'|'ability'|'nature';return sheet[key]!==undefined && id(sheet[key]!)!==id(set[key] || '');
      }) || JSON.stringify(sheet.moves.map(id).sort())!==JSON.stringify(set.moves.map(id).sort()))unsupported(`${side} candidate conflicts with a sheet disclosed before the decision`);
    }
  }
  return result;
}
function selectedCommand(team:PokemonTeam,side:PlayerSide,initial:NormalizedEvent[],seed:EngineSeed,prefix:NormalizedEvent[],selected?:string[]):string {
  const leads=['a','b'].map(slot=>{
    const event=initial.find(e=>e.type==='switch' && e.args[0]?.startsWith(`${side}${slot}:`));
    if(!event)unsupported(`Missing initial lead ${side}${slot}`);
    const index=team.pokemon.findIndex(p=>speciesId(p.species)===speciesId(event!.args[1]!));
    if(index<0)unsupported(`Observed lead ${side}${slot} is absent from the candidate`);
    return index+1;
  });
  if(new Set(leads).size!==2)unsupported(`Ambiguous initial ${side} leads`);
  const reserves=team.pokemon.map((_,i)=>i+1).filter(i=>!leads.includes(i));
  const revealed=new Set((selected ?? prefix.filter(e=>e.type==='switch' && e.args[0]?.startsWith(side)).map(e=>e.args[1]!)).map(speciesId));
  if(selected && (selected.length!==4 || new Set(selected.map(speciesId)).size!==4 || selected.some(name=>!team.pokemon.some(p=>speciesId(p.species)===speciesId(name))) || leads.some(i=>!revealed.has(speciesId(team.pokemon[i-1]!.species)))))unsupported('Own selected four conflict with the opening');
  if(revealed.size>4)unsupported('More than four distinct selected species are unsupported');
  reserves.sort((a,b)=>Number(revealed.has(speciesId(team.pokemon[b-1]!.species)))-Number(revealed.has(speciesId(team.pokemon[a-1]!.species))) || sha256(`${seed.join(',')}:${side}:${a}`).localeCompare(sha256(`${seed.join(',')}:${side}:${b}`)));
  if(selected){const rank=(i:number)=>{const at=selected.map(speciesId).indexOf(speciesId(team.pokemon[i-1]!.species));return at<0?99:at;};reserves.sort((a,b)=>rank(a)-rank(b));}
  return `team ${[...leads,...reserves.slice(0,2)].join('')}`;
}
export interface ReplayReconstructionOptions {
  /** Absolute wall-clock deadline shared with the enclosing search. */
  deadline?:number;
  maxAttempts?:number;
  particleCap?:number;
  /** Exact known own selection; species order need not be the initial order. */
  ownSelectedFour?:string[];
}
/** Event constraints narrow the legal action prior, but censored actions and targets
 * remain latent. Complete engine transitions, not guessed HP/PP, accept hypotheses. */
function commandCandidates(session:EngineSession,side:PlayerSide,events:NormalizedEvent[]):Array<string|undefined> {
  const view=session.view(side);
  if(view.request.wait)return [undefined];
  const choices=view.legalCommands.filter(command=>command.split(', ').every((part,slot)=>{
    if(view.request.forceSwitch && !view.request.forceSwitch[slot])return part==='pass';
    const actor=`${side}${slot===0?'a':'b'}:`;
    const event=events.find(e=>['move','switch','cant','faint'].includes(e.type) && e.args[0]?.startsWith(actor) && !(e.type==='move' && e.tags.from));
    if(!event)return true; // Fainted/flinched/prevented actions can consume different PP/counters.
    if(event.type==='cant' || event.type==='faint')return !part.startsWith('switch ');
    if(event.type==='switch') {
      // A move can cause a later pivot; the first direct move above disambiguates it.
      const index=Number(part.match(/^switch (\d+)$/)?.[1]);
      return !!index && speciesId(view.request.side.pokemon[index-1]!.details)===speciesId(event.args[1]!);
    }
    if(view.request.forceSwitch)return false;
    const index=Number(part.match(/^move (\d+)/)?.[1]);
    return !!index && id(view.request.active?.[slot]?.moves[index-1]?.id || '')===id(event.args[1]!);
  }));
  // Prefer visible targets to improve bounded coverage; alternative original targets
  // remain in the candidate set for redirection and automatic retargeting.
  const score=(command:string)=>command.split(', ').reduce((sum,part,slot)=>{
    const event=events.find(e=>e.type==='move' && e.args[0]?.startsWith(`${side}${slot===0?'a':'b'}:`) && !e.tags.from);
    const target=event?.args[2]?.match(/^(p[12])([ab]):/);
    const selected=Number(part.match(/^move \d+ (-?\d+)/)?.[1]);
    return sum+(target && selected===(target[1]===side?-1:1)*(target[2]==='a'?1:2)?1:0);
  },0);
  return choices.sort((a,b)=>score(b)-score(a));
}
/** Samples one mechanically consistent state from a strictly bounded public prefix.
 * This is a conditional state sample, never a recovered exact historical checkpoint.
 */
export function reconstructReplayStart(replay:ParsedReplay,userTeam:PokemonTeam,playerSide:PlayerSide,turn:number,opponentTeam:PokemonTeam,seed:EngineSeed,options:ReplayReconstructionOptions={}):ReplayStartCheckpoint {
  if(!Number.isInteger(turn)||turn<1||turn>200)unsupported('Decision turn must be between 1 and 200');
  const maxAttempts=options.maxAttempts??2048,particleCap=options.particleCap??4;
  if(!Number.isInteger(maxAttempts)||maxAttempts<1||maxAttempts>100000)unsupported('Invalid reconstruction attempt budget');
  if(!Number.isInteger(particleCap)||particleCap<1||particleCap>64)unsupported('Invalid reconstruction particle cap');
  const checkDeadline=()=>{if(Date.now()>=(options.deadline??Infinity))unsupported('Reconstruction deadline exhausted');};
  checkDeadline();
  const boundary=replay.events.findIndex(e=>e.type==='turn' && Number(e.args[0])===turn);
  if(boundary<0)unsupported(`Replay has no pre-action decision boundary for turn ${turn}`);
  // Do not use initialState/finalState, cached turn summaries or any future event.
  const prefix=replay.events.slice(0,boundary+1);
  const tiers=prefix.filter(e=>e.type==='tier').map(e=>id(e.args[0] || ''));
  if(replay.document.metadata.formatId)tiers.push(id(replay.document.metadata.formatId));
  if(!tiers.length || tiers.some(tier=>![ENGINE_PROFILE.format,ENGINE_PROFILE.format+'bo3'].includes(tier)))unsupported('An explicit Champions VGC 2026 Reg M-C format is required; conflicting tiers are unsupported');
  const bo3=tiers.includes(ENGINE_PROFILE.format+'bo3');
  const teams={p1:constrainReplayTeam(playerSide==='p1'?userTeam:opponentTeam,'p1',prefix),p2:constrainReplayTeam(playerSide==='p2'?userTeam:opponentTeam,'p2',prefix)};
  for(const team of Object.values(teams)) {const errors=validateEngineTeam(team);if(errors.length)unsupported('Candidate is illegal under the pinned engine: '+errors.join('; '));}
  const firstBoundary=prefix.findIndex(e=>e.type==='turn' && e.args[0]==='1');
  const start=prefix.findIndex(e=>e.type==='start');
  if(start<0||firstBoundary<0)unsupported('The full battle opening through turn 1 is required');
  const initial=prefix.slice(start,firstBoundary+1);
  const sheets=prefix.filter(e=>e.type==='showteam');
  if(sheets.length && (sheets.length!==2 || new Set(sheets.map(e=>e.args[0])).size!==2 || sheets.some(e=>!['p1','p2'].includes(e.args[0]??'')||e.index>prefix[start]!.index)))unsupported('Partial or late sheet exchange is unsupported; it cannot grant both players full opening sheets');
  for(const sheet of sheets){
    const disclosed=readOpenSheet(sheet.args[1]!).map(set=>speciesId(set.species)).sort();
    const preview=prefix.filter(e=>e.type==='poke'&&e.args[0]===sheet.args[0]).map(e=>speciesId(e.args[1]!)).sort();
    if(disclosed.length!==6||new Set(disclosed).size!==6||JSON.stringify(disclosed)!==JSON.stringify(preview))unsupported('Opening sheets must each disclose six distinct species matching that side\'s public preview');
  }
  if(Object.values(teams).some(team=>team.pokemon.some(p=>id(p.ability || '')==='illusion')))unsupported('Illusion creates ambiguous initial lead identities and is not yet supported');
  const informationMode=sheets.length?'open_sheet':'replay_observed';
  let attempts=0,acceptances=0;
  type Particle={session:EngineSession;weight:number};
  let particles:Particle[]=[];
  for(let attempt=0;attempt<64 && attempts<maxAttempts && particles.length<particleCap;attempt++) {
    checkDeadline();
    const sample=EngineSession.create({teams,seed:derivedSeed(seed,`initial:${attempt}`),informationMode});
    sample.step({p1:selectedCommand(teams.p1,'p1',initial,derivedSeed(seed,`selection:${attempt}`),prefix,playerSide==='p1'?options.ownSelectedFour:undefined),p2:selectedCommand(teams.p2,'p2',initial,derivedSeed(seed,`selection:${attempt}`),prefix,playerSide==='p2'?options.ownSelectedFour:undefined)});attempts++;
    const generated=normalizeEvents(sample.view(playerSide).observations.join('\n'));
    const generatedStart=generated.findIndex(e=>e.type==='start');
    if(projectionsMatch(initial,generated.slice(generatedStart)))particles.push({session:sample,weight:1});
  }
  if(!particles.length)unsupported('No candidate opening matches the public lead, HP and entry-event projection within the attempt budget');
  for(let current=1;current<turn;current++) {
    const from=prefix.findIndex(e=>e.type==='turn' && Number(e.args[0])===current);
    const to=prefix.findIndex(e=>e.type==='turn' && Number(e.args[0])===current+1);
    const expected=mechanics(prefix.slice(from+1,to+1));
    let frontier=particles.map(p=>({...p,offset:0}));
    const accepted:Particle[]=[];
    // A turn may pause for pivot selection or faint replacements before its next
    // turn marker. Each pause is another legal decision against the remaining prefix.
    for(let phase=0;phase<16 && frontier.length && accepted.length<particleCap;phase++) {
      const next:typeof frontier=[];
      for(const particle of frontier) {
        checkDeadline();
        const remaining=expected.slice(particle.offset);
        const one=commandCandidates(particle.session,'p1',remaining),two=commandCandidates(particle.session,'p2',remaining);
        if(!one.length||!two.length)continue;
        const checkpoint=particle.session.snapshot();
        const pairs:Array<{p1:string|undefined;p2:string|undefined}>=[];
        // Diagonal enumeration gives each actor's hypotheses bounded exposure.
        for(let diagonal=0;diagonal<one.length+two.length-1 && pairs.length<128;diagonal++)for(let i=0;i<=diagonal && i<one.length && pairs.length<128;i++){
          const j=diagonal-i;if(j<two.length)pairs.push({p1:one[i],p2:two[j]});
        }
        const limit=Math.max(64,Math.min(256,pairs.length*8));
        for(let trial=0;trial<limit && attempts<maxAttempts;trial++) {
          checkDeadline();
          const candidate=EngineSession.restore(checkpoint);candidate.reseed(derivedSeed(seed,`turn:${current}:phase:${phase}:attempt:${attempts}`));
          const before=candidate.view(playerSide).observations.length;
          attempts++;
          try {candidate.step(pairs[trial%pairs.length]!);} catch {continue;}
          const observed=mechanics(normalizeEvents(candidate.view(playerSide).observations.slice(before).join('\n')));
          if(!observed.length || observed.length>remaining.length || !projectionsMatch(remaining.slice(0,observed.length),observed))continue;
          acceptances++;
          const result={session:candidate,weight:particle.weight/(one.length*two.length),offset:particle.offset+observed.length};
          if(result.offset===expected.length)accepted.push(result);else next.push(result);
          if(accepted.length>=particleCap || next.length>=particleCap)break;
        }
        if(accepted.length>=particleCap || next.length>=particleCap)break;
      }
      frontier=next;
    }
    if(!accepted.length)unsupported(`No conditional transition matches turn ${current}'s public projection within the bounded attempt budget (${attempts}/${maxAttempts}); no numerical continuation is available`);
    particles=accepted.slice(0,particleCap);
  }
  checkDeadline();
  // Explicit heuristic particle weights: legal-command prior times sampled transition
  // acceptance multiplicity. Bounded/truncated enumeration is not exact Bayes.
  const total=particles.reduce((sum,p)=>sum+p.weight,0);
  let draw=parseInt(sha256(`${seed.join(',')}:particle`).slice(0,8),16)/0x100000000*total;
  const chosen=particles.find(p=>{draw-=p.weight;return draw<=0;})??particles[particles.length-1]!;
  return {...chosen.session.snapshot(),reconstruction:{kind:'public-prefix-sampled',decisionTurn:turn,publicPrefixHash:sha256(prefix.map(e=>e.raw).join('\n')),conditioningAttempts:attempts,transitionAcceptances:acceptances,retainedParticles:particles.length,weighting:'uniform-legal-command-prior-with-transition-rejection',warnings:[
    ...(bo3?['M-C Bo3 is normalized to equivalent single-game battle rules; disclosures from prior games are unavailable in this isolated public prefix.']:[]),
    'Unrevealed selected reserves are sampled from the six-species preview; known own selection and prefix switches constrain them, never future switches.',
    'Bounded event-constrained legal-command prior and transition acceptance particles are heuristic weights, not a calibrated replay posterior.',
    'HP, PP and hidden counters belong to a prefix-consistent sampled world; this is not the exact historical state.',
    'Coverage is bounded by legal hypotheses, particles and engine transition attempts; unmatched mechanics are explicitly unsupported.',
  ]}};
}
