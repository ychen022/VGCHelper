import type {NormalizedEvent} from '../domain/contracts.js';
import {loadReplay,parseReplay} from '../replay/index.js';
import {sha256} from '../util/hash.js';
import {speciesIdentity} from './identity.js';
import {sampleBeliefTeam,type TeamBelief} from './beliefs.js';
import {EngineSession,type EngineSeed,type PlayerSide,type PlayerView,type ChoiceRequest} from './engine.js';
import {assertPreviewMatches,constrainReplayTeam,reconstructReplayStart,UnsupportedReplayError,type ReplayReconstructionOptions} from './replay.js';

const species=speciesIdentity;
const fail=(message:string):never=>{throw new UnsupportedReplayError([message]);};
function stable(value:unknown):string {
  if(Array.isArray(value))return '['+value.map(stable).join(',')+']';
  if(value && typeof value==='object')return '{'+Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+stable(v)).join(',')+'}';
  return JSON.stringify(value)??'null';
}
/** Names are display labels. Every own mechanical request field remains checked. */
function requestKey(request:ChoiceRequest):string {
  const copy=structuredClone(request);copy.side.name=copy.side.id;
  for(const pokemon of copy.side.pokemon)pokemon.ident=pokemon.ident.replace(/: .*/,':');
  return stable(copy);
}
/** Undo the engine's public active/reserve swaps to recover the known initial order. */
function initialSelection(view:PlayerView,events:NormalizedEvent[]):string[] {
  const selected=view.request.side.pokemon.map(p=>species(p.details));
  if(selected.length!==4 || new Set(selected).size!==4)fail('Own selected four are missing or have unsupported ambiguous identities');
  const active:Array<string|undefined>=[];
  const swaps:Array<{slot:number;outgoing:string}>=[];
  for(const event of events) {
    const match=event.args[0]?.match(/^(p[12])([ab]):/);
    if(event.type!=='switch' || match?.[1]!==view.side)continue;
    const slot=match[2]==='a'?0:1;
    if(active[slot])swaps.push({slot,outgoing:active[slot]!});
    active[slot]=species(event.args[1]!);
  }
  for(const {slot,outgoing} of swaps.reverse()) {
    const index=selected.indexOf(outgoing);
    if(index<0)fail('Cannot recover own selection through the observed switches');
    [selected[slot],selected[index]]=[selected[index]!,selected[slot]!];
  }
  return selected;
}
/** A new imaginary world accepts only actor-visible inputs and public prior data.
 * No checkpoint, real RNG, or opposing private state can enter through this API. */
export function sampleActorWorld(view:PlayerView,belief:TeamBelief,seed:string,options:ReplayReconstructionOptions={}):Pick<EngineSession,'view'|'step'> {
  if(Date.now()>=(options.deadline??Infinity))fail('Actor-world reconstruction deadline exhausted');
  if(view.ended || view.request.wait)fail('Actor has no supported decision to reconstruct');
  const replay=parseReplay(loadReplay({content:view.observations.join('\n')}));
  const own=constrainReplayTeam(view.ownTeam,view.side,replay.events),opponent=constrainReplayTeam(sampleBeliefTeam(belief,seed),view.side==='p1'?'p2':'p1',replay.events);
  const hash=sha256(seed),engineSeed=[0,1,2,3].map(i=>parseInt(hash.slice(i*4,i*4+4),16)) as EngineSeed;
  const teams=view.side==='p1'?{p1:own,p2:opponent}:{p1:opponent,p2:own};
  let session:EngineSession;
  if(view.request.teamPreview){
    session=EngineSession.create({teams,seed:engineSeed,informationMode:view.informationMode});
    assertPreviewMatches(replay.events,parseReplay(loadReplay({content:session.view(view.side).observations.join('\n')})).events);
  }
  else {
    if(view.request.forceSwitch)fail('Partial-turn forced-switch actor roots are unsupported; a complete turn boundary is required');
    const last=replay.events[replay.events.length-1];
    if(last?.type!=='turn' || Number(last.args[0])!==view.turn)fail('Actor prefix is not a complete pre-action turn boundary');
    const selection=initialSelection(view,replay.events);
    session=EngineSession.restore(reconstructReplayStart(replay,own,view.side,view.turn,opponent,engineSeed,{...options,ownSelectedFour:selection}));
  }
  const reconstructed=session.view(view.side);
  if(requestKey(reconstructed.request)!==requestKey(view.request) || stable(reconstructed.legalCommands)!==stable(view.legalCommands) || reconstructed.turn!==view.turn || reconstructed.ended!==view.ended)fail('No consistent sampled world matches the exact own request and legal commands');
  if(Date.now()>=(options.deadline??Infinity))fail('Actor-world reconstruction deadline exhausted');
  const original:PlayerView=structuredClone({side:view.side,turn:view.turn,ownTeam:view.ownTeam,request:view.request,observations:view.observations,legalCommands:view.legalCommands,ended:view.ended,informationMode:view.informationMode,...(view.winner?{winner:view.winner}:{})});
  const offset=reconstructed.observations.length;
  let stepped=false;
  return {
    view(side:PlayerSide):PlayerView {
      if(side===original.side && !stepped)return structuredClone(original);
      const next=session.view(side);
      if(side!==original.side)return {...next,informationMode:original.informationMode};
      return {...next,ownTeam:structuredClone(original.ownTeam),informationMode:original.informationMode,
        observations:[...original.observations,...next.observations.slice(offset)]};
    },
    step(commands){session.step(commands);stepped=true;},
  };
}
