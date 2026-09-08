import type {EngineSession,PlayerSide,PlayerView} from './engine.js';
import type {TeamBelief} from './beliefs.js';
import {updateBeliefFromView} from './observe.js';
import {actionDistribution,chooseAction,planningActions,publicBattleState,type ActionSelectionOptions} from './policy.js';
import {sha256} from '../util/hash.js';

export const SEARCH_VERSION='information-set-uct-v3';
export type SearchWorld=Pick<EngineSession,'view'|'step'>;
export interface SearchOptions {
  actionSelection?:ActionSelectionOptions;
  seed:string;iterations:number;budgetMs:number;maxTurns:number;maxDepth:number;candidateCap:number;
  /** Construct a NEW private sampled world from these inputs only; no real checkpoint closure. */
  sampleWorld:(view:PlayerView,belief:TeamBelief,seed:string,deadline:number)=>SearchWorld;
  /** Build this actor's public prior, without the searching actor's private team. */
  opponentBelief:(view:PlayerView)=>TeamBelief;
  exploration?:number;confirmationSamples?:number;confirmationMaxTurns?:number;confirmationMaxDepth?:number;
}
export interface SearchActionStatistics {
  command:string;prior:number;visits:number;valueSum:number;meanValue:number|null;
  terminal:number;capped:number;invalid:number;
}
export interface SearchNodeStatistics {key:string;visits:number;actions:SearchActionStatistics[]}
export interface SearchResult {
  version:typeof SEARCH_VERSION;command:string;rootActions:SearchActionStatistics[];nodes:SearchNodeStatistics[];
  iterations:number;incompleteRollouts:number;invalidRollouts:number;status:'completed'|'budget_exhausted';
  confirmation:{samples:number;wins:number;losses:number;draws:number;capped:number;invalid:number;winRate:number|null};
  assumptions:string[];warnings:string[];
}
/** Explicit allowlist prevents accidental engine/RNG extensions becoming keys or factory inputs. */
function actorInput(view:PlayerView):PlayerView {
  return structuredClone({side:view.side,turn:view.turn,ownTeam:view.ownTeam,request:view.request,
    observations:view.observations,legalCommands:view.legalCommands,ended:view.ended,
    informationMode:view.informationMode,...(view.winner?{winner:view.winner}:{})});
}
function stable(value:unknown):string {
  if(Array.isArray(value))return `[${value.map(stable).join(',')}]`;
  if(value&&typeof value==='object'){
    const fields=Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b));
    return '{'+fields.map(([k,v])=>`${JSON.stringify(k)}:${stable(v)}`).join(',')+'}';
  }
  return JSON.stringify(value)??'null';
}
export function informationSetKey(view:PlayerView):string {return sha256(stable(actorInput(view)));}
function action(command:string,prior:number):SearchActionStatistics {
  return {command,prior,visits:0,valueSum:0,meanValue:null,terminal:0,capped:0,invalid:0};
}
/** Bounded public HP heuristic; these values are selection utilities, never win probabilities. */
function heuristic(view:PlayerView):number {
  const state=publicBattleState(view),foe=view.side==='p1'?'p2':'p1';
  const health=(side:PlayerSide)=>Object.values(state.sides[side].pokemon).map(p=>p.fainted?0:(p.hpPercent??100)/100);
  const own=health(view.side),enemy=health(foe);
  if(!own.length||!enemy.length)return 0.5;
  return 0.5+0.25*(own.reduce((a,b)=>a+b,0)/own.length-enemy.reduce((a,b)=>a+b,0)/enemy.length);
}
function best(actions:SearchActionStatistics[]):SearchActionStatistics {
  return [...actions].sort((a,b)=>(b.meanValue??-1)-(a.meanValue??-1)||b.visits-a.visits||b.prior-a.prior||a.command.localeCompare(b.command))[0]!;
}

/** Re-determinize at each root iteration; share decisions only by actor-visible information. */
export function searchDecision(input:PlayerView,inputBelief:TeamBelief,options:SearchOptions):SearchResult {
  const started=Date.now(),deadline=started+options.budgetMs;
  for(const [name,value,max] of [['iterations',options.iterations,10000],['maxTurns',options.maxTurns,200],['maxDepth',options.maxDepth,1000],['candidateCap',options.candidateCap,4096]] as const)
    if(!Number.isInteger(value)||value<1||value>max)throw new Error(`${name} must be an integer between 1 and ${max}`);
  if(!Number.isFinite(options.budgetMs)||options.budgetMs<0)throw new Error('budgetMs must be finite and nonnegative');
  if(options.exploration!==undefined&&(!Number.isFinite(options.exploration)||options.exploration<0))throw new Error('exploration must be finite and nonnegative');
  const confirmationCount=options.confirmationSamples??0;
  if(!Number.isInteger(confirmationCount)||confirmationCount<0||confirmationCount>10000)throw new Error('confirmationSamples must be 0–10000');
  const confirmationTurns=options.confirmationMaxTurns??options.maxTurns,confirmationDepth=options.confirmationMaxDepth??options.maxDepth;
  if(!Number.isInteger(confirmationTurns)||confirmationTurns<1||confirmationTurns>200||!Number.isInteger(confirmationDepth)||confirmationDepth<1||confirmationDepth>1000)throw new Error('Invalid confirmation horizon');
  const selectionDeadline=confirmationCount?started+Math.floor(options.budgetMs*0.7):deadline;
  const rootView=actorInput(input),rootKey=informationSetKey(rootView),belief=structuredClone(inputBelief);
  if(rootView.ended||rootView.request.wait||!rootView.legalCommands.length)throw new Error('Actor has no legal decision at the search root');
  const nodes=new Map<string,SearchNodeStatistics>(),warnings=new Set<string>();
  const getNode=(view:PlayerView,prior:TeamBelief):SearchNodeStatistics=>{
    const key=informationSetKey(view);let node=nodes.get(key);
    if(!node){
      node={key,visits:0,actions:planningActions(view,prior,options.candidateCap).map(a=>action(a.command,a.probability))};
      if(!node.actions.length)throw new Error('No policy candidates at decision');
      nodes.set(key,node);
    }
    return node;
  };
  const root=getNode(rootView,belief),opponent:PlayerSide=rootView.side==='p1'?'p2':'p1';
  const select=(node:SearchNodeStatistics):SearchActionStatistics=>{
    // Root gets one trial of every retained candidate before exploitation.
    if(node.key===rootKey){const unvisited=node.actions.find(a=>!a.visits);if(unvisited)return unvisited;}
    const width=node.key===rootKey?node.actions.length:Math.min(node.actions.length,1+Math.floor(Math.sqrt(node.visits)));
    const expanded=node.actions.slice(0,width),unvisited=expanded.find(a=>!a.visits);
    if(unvisited)return unvisited;
    const score=(a:SearchActionStatistics)=>(a.meanValue??0.5)+(options.exploration??Math.SQRT2)*Math.sqrt(Math.log(node.visits+1)/a.visits)+a.prior*Math.sqrt(node.visits+1)/(1+a.visits);
    return [...expanded].sort((a,b)=>score(b)-score(a)||a.command.localeCompare(b.command))[0]!;
  };
  type Outcome={kind:'terminal';winner:PlayerSide|'draw';value:number}|{kind:'capped';value:number}|{kind:'invalid';value:0};
  const rollout=(index:number,confirmationCommand?:string):Outcome=>{
    const path:Array<{node:SearchNodeStatistics;edge:SearchActionStatistics}>=[];
    const prefix=`${options.seed}:${confirmationCommand===undefined?'selection':'confirmation'}:${index}`;
    const phaseDeadline=confirmationCommand===undefined?selectionDeadline:deadline;
    let outcome:Outcome;
    try {
      const world=options.sampleWorld(actorInput(rootView),structuredClone(belief),`${prefix}:world`,phaseDeadline);
      if(informationSetKey(world.view(rootView.side))!==rootKey)throw new Error('Sampled root changed actor-visible party, request or history');
      let ownBelief=structuredClone(belief),otherBelief=options.opponentBelief(actorInput(world.view(opponent)));
      let depth=0;
      while(true){
        const own=world.view(rootView.side);
        if(own.ended){const winner=own.winner??'draw';outcome={kind:'terminal',winner,value:winner==='draw'?0.5:winner===rootView.side?1:0};break;}
        if(Date.now()>=phaseDeadline||depth>=(confirmationCommand===undefined?options.maxDepth:confirmationDepth)||own.turn-rootView.turn>=(confirmationCommand===undefined?options.maxTurns:confirmationTurns)){outcome={kind:'capped',value:heuristic(own)};break;}
        const other=world.view(opponent);
        ownBelief=updateBeliefFromView(ownBelief,own);otherBelief=updateBeliefFromView(otherBelief,other);
        const commands:{p1?:string;p2?:string}={};
        // Both policies see pre-resolution views. Opponent never receives the own action.
        if(!other.request.wait){
          const command=chooseAction(actionDistribution(other,otherBelief,'tactical',options.actionSelection),`${prefix}:opponent:${depth}`);
          if(!command)throw new Error('Opponent has no policy action');commands[opponent]=command;
        }
        if(!own.request.wait){
          let command:string;
          if(confirmationCommand!==undefined){
            const existing=nodes.get(informationSetKey(own));
            command=depth===0?confirmationCommand:existing?best(existing.actions).command:chooseAction(actionDistribution(own,ownBelief,'tactical',options.actionSelection),`${prefix}:own:${depth}`)!;
          } else {const node=getNode(own,ownBelief),edge=select(node);path.push({node,edge});command=edge.command;}
          if(!own.legalCommands.includes(command))throw new Error('Selected command is not legal for actor');commands[rootView.side]=command;
        }
        if(!commands.p1&&!commands.p2)throw new Error('Sampled world has no pending decision');
        world.step(commands);depth++;
      }
    }catch(error){warnings.add(error instanceof Error?error.message:String(error));outcome={kind:'invalid',value:0};}
    for(const {node,edge} of path){
      node.visits++;edge.visits++;
      if(outcome.kind==='invalid')edge.invalid++;
      else {edge.valueSum+=outcome.value;edge[outcome.kind]++;edge.meanValue=edge.valueSum/(edge.visits-edge.invalid);}
    }
    return outcome;
  };
  let iterations=0,incompleteRollouts=0,invalidRollouts=0;
  while(iterations<options.iterations&&Date.now()<selectionDeadline){
    const outcome=rollout(iterations++);
    if(outcome.kind==='capped')incompleteRollouts++;
    if(outcome.kind==='invalid')invalidRollouts++;
  }
  const command=best(root.actions).command;
  const confirmation:SearchResult['confirmation']={samples:0,wins:0,losses:0,draws:0,capped:0,invalid:0,winRate:null};
  while(confirmation.samples<confirmationCount&&Date.now()<deadline){
    const outcome=rollout(confirmation.samples++,command);
    if(outcome.kind==='terminal')confirmation[outcome.winner==='draw'?'draws':outcome.winner===rootView.side?'wins':'losses']++;
    else confirmation[outcome.kind]++;
  }
  if(confirmation.samples>0&&confirmation.samples===confirmationCount&&!confirmation.capped&&!confirmation.invalid)confirmation.winRate=confirmation.wins/confirmation.samples;
  return {version:SEARCH_VERSION,command,rootActions:structuredClone(root.actions),nodes:structuredClone([...nodes.values()]),iterations,incompleteRollouts,invalidRollouts,
    status:iterations<options.iterations||confirmation.samples<confirmationCount?'budget_exhausted':'completed',confirmation,
    assumptions:[
      'Information-set UCT re-samples a belief world at every root iteration; only actor-visible information keys tree statistics.',
      'Root candidate exploration and tactical priors are bounded by candidateCap; omitted actions are unsearched.',
      'Selection meanValue combines terminal rewards and capped public-HP heuristic utilities; it is not a win rate.',
      'Confirmation uses independent seeds, the frozen selected root command and frozen future tree policy; its outcomes are separate from adaptive selection values.',
      'Factory and opponent-prior callbacks must use only their provided actor inputs and public prior data; synchronous callback cost cannot be preempted by the deadline.',
    ],warnings:[...warnings]};
}
