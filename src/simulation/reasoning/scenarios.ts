import {type PlayerView,type PlayerSide,validateEngineTeam} from '../engine.js';
import type {TeamBelief} from '../beliefs.js';
import type {MetaTeam,MetaUsageRow} from '../../domain/contracts.js';
import {sampleActorWorld} from '../worlds.js';
import {actorPriorFactory} from '../runner.js';
import {updateBeliefFromView} from '../observe.js';
import {actionDistribution,chooseAction,planningActions,publicBattleState,seededRandom,type ActionProbability} from '../policy.js';
import {planningFamilies} from '../action-support.js';
import {UnsupportedReplayError} from '../replay.js';

export interface PlayerPlanOptions {
  plans:Array<{label:string;command:string}>;samples:number;maxTurns:number;budgetMs:number;seed:string;
}
export interface PlayerPlanSources {regulationId:string;metaTeams:MetaTeam[];usageRows:MetaUsageRow[]}
interface Response {
  command:string;families:string[];choices:string[];modelWeight:number;
  category:'tactical'|'protect'|'switch';
}
export interface Counts {attempted:number;terminal:number;capped:number;invalid:number;unsupported:number;notRun:number}
export interface OutcomeSummary {samples:number;horizonUtility:Range;ownRemaining:Range;ownHpPercentTotal:Range;opponentSeenRemaining:Range;opponentSeenHpPercentTotal:Range}
interface ResponseCoverage {
  interpretation:string;unassigned:number;
  categories:Array<{category:Response['category'];selected:number;rootExecuted:number;terminal:number;capped:number;invalid:number;unsupported:number;summary:OutcomeSummary|null}>;
}
interface Evaluation {
  label:string;command:string;legality:'legal'|'illegal';counts:Counts;reasons:string[];
  terminalOutcomes:{wins:number;losses:number;draws:number};
  consequences:Consequence[];omittedConsequences:number;
  summary:OutcomeSummary|null;responseCoverage:ResponseCoverage;
}
export interface Range {mean:number;minimum:number;maximum:number}
type Consequence=ReturnType<typeof consequence>;
const responseCategories=['tactical','protect','switch'] as const;

/** Top-level allowlist: extensions such as live checkpoints or pending choices never enter planning. */
function actorInput(view:PlayerView):PlayerView {
  return structuredClone({side:view.side,turn:view.turn,ownTeam:view.ownTeam,request:view.request,
    observations:view.observations,legalCommands:view.legalCommands,ended:view.ended,
    informationMode:view.informationMode,...(view.winner?{winner:view.winner}:{})});
}
function health(condition:string):number {
  if(condition.endsWith(' fnt'))return 0;
  const match=/^(\d+)\/(\d+)/.exec(condition);
  return match&&Number(match[2])>0?100*Number(match[1])/Number(match[2]):0;
}
function round(value:number):number{return Math.round(value*1000)/1000;}
function range(values:number[]):Range {
  return {mean:round(values.reduce((a,b)=>a+b,0)/values.length),minimum:Math.min(...values),maximum:Math.max(...values)};
}
function summarize(outcomes:Consequence[]):OutcomeSummary|null {
  return outcomes.length?{samples:outcomes.length,horizonUtility:range(outcomes.map(o=>o.horizonUtility)),
    ownRemaining:range(outcomes.map(o=>o.own.remaining)),ownHpPercentTotal:range(outcomes.map(o=>o.own.hpPercentTotal)),
    opponentSeenRemaining:range(outcomes.map(o=>o.opponent.seenRemaining)),opponentSeenHpPercentTotal:range(outcomes.map(o=>o.opponent.seenHpPercentTotal))}:null;
}
/** Spread early samples over the mixture, preserving one visit to each stratum and paired order across plans. */
function responseStrata(count:number,seed:string):number[] {
  const bits=Math.ceil(Math.log2(count));
  const reverse=(index:number)=>{let result=0;for(let bit=0;bit<bits;bit++){result=result*2+index%2;index=Math.floor(index/2);}return result;};
  const rotation=Math.floor(seededRandom(`${seed}:stratum-rotation`)()*count),jitter=seededRandom(`${seed}:stratum`)();
  return Array.from({length:count},(_,index)=>index).sort((a,b)=>reverse(a)-reverse(b))
    .map(index=>(((index+rotation)%count)+jitter)/count);
}
/** Retained examples are illustrative: preserve utility/HP extremes and every sampled response category. */
function retainedConsequences(outcomes:Consequence[]):Consequence[] {
  if(outcomes.length<=8)return outcomes;
  const selected=new Set<Consequence>();
  const extrema=(get:(outcome:Consequence)=>number,maximum=false)=>
    outcomes.reduce((best,next)=>(maximum?get(next)>get(best):get(next)<get(best))?next:best);
  selected.add(extrema(o=>o.horizonUtility));selected.add(extrema(o=>o.horizonUtility,true));
  selected.add(extrema(o=>o.own.remaining));
  selected.add(extrema(o=>o.own.hpPercentTotal));selected.add(extrema(o=>o.own.hpPercentTotal,true));
  for(const category of responseCategories){
    if([...selected].some(outcome=>outcome.opponentResponse?.category===category))continue;
    const group=outcomes.filter(outcome=>outcome.opponentResponse?.category===category);
    if(group.length)selected.add(group.reduce((best,next)=>next.horizonUtility<best.horizonUtility?next:best));
  }
  for(const outcome of outcomes){if(selected.size>=8)break;selected.add(outcome);}
  return outcomes.filter(outcome=>selected.has(outcome));
}
function publicEvents(lines:string[]):string[] {
  const result:string[]=[];let length=0;
  for(const line of lines) {
    if(result.length>=60||length+line.length>6000)break;
    result.push(line);length+=line.length;
  }
  return result;
}
/** Outcomes are projected from the hypothetical actor view, never the sampled opponent request. */
function consequence(view:PlayerView,root:PlayerView,kind:'terminal'|'capped',reason:string,response:Response|undefined) {
  const state=publicBattleState(view),foe:PlayerSide=view.side==='p1'?'p2':'p1';
  const party=view.request.side.pokemon,seen=Object.values(state.sides[foe].pokemon);
  const ownHp=party.reduce((sum,p)=>sum+health(p.condition),0);
  const enemyHp=seen.reduce((sum,p)=>sum+(p.fainted?0:p.hpPercent??100),0);
  // A small public-board utility on [-1,1]. Unknown opposing reserves receive no invented HP values.
  const utility=party.length&&seen.length?ownHp/(100*party.length)-enemyHp/(100*seen.length):0;
  const events=view.observations.slice(root.observations.length),retained=publicEvents(events);
  return {
    kind,reason,turn:view.turn,turnsResolved:Math.max(0,view.turn-Math.max(1,root.turn)+(view.ended?1:0)),
    ...(view.winner?{winner:view.winner}:{}),horizonUtility:round(utility),
    own:{remaining:party.filter(p=>!p.condition.endsWith(' fnt')).length,hpPercentTotal:round(ownHp),
      active:party.filter(p=>p.active).map(p=>({species:p.details.split(',')[0]!,condition:p.condition,hpPercent:round(health(p.condition)),
        item:p.item,ability:p.ability??p.baseAbility,speedStat:p.stats.spe??null,
        boosts:Object.values(state.sides[view.side].pokemon).find(visible=>visible.active&&visible.nickname===p.ident.split(': ').slice(1).join(': '))?.boosts??{}}))},
    opponent:{seenRemaining:seen.filter(p=>!p.fainted).length,seenHpPercentTotal:round(enemyHp),
      active:seen.filter(p=>p.active).map(p=>({species:p.species??p.nickname,slot:p.slot,hpPercent:p.hpPercent??null,
        hpRange:p.hp?.percentRange??null,fainted:p.fainted,status:p.status??null,boosts:p.boosts}))},
    field:structuredClone(state.field),sideConditions:{own:{conditions:state.sides[view.side].conditions??[],tailwindTurns:state.sides[view.side].tailwindTurns??0},
      opponent:{conditions:state.sides[foe].conditions??[],tailwindTurns:state.sides[foe].tailwindTurns??0}},
    opponentResponse:response??null,publicEvents:retained,omittedPublicEvents:events.length-retained.length,
  };
}
function describeChoices(view:PlayerView,command:string):string[] {
  if(command.startsWith('team '))return [...command.slice(5)].map(index=>view.request.side.pokemon[Number(index)-1]?.details.split(',')[0]??'?');
  return command.split(',').map((part,slot)=>{
    const choice=part.trim(),move=/^move (\d+)(.*)/.exec(choice),replacement=/^switch (\d+)/.exec(choice);
    const species=view.request.side.pokemon[slot]?.details.split(',')[0]??'?';
    return move?`${species}: ${view.request.active?.[slot]?.moves[Number(move[1])-1]?.move??'?'}${move[2]}`:
      replacement?`${species}: switch to ${view.request.side.pokemon[Number(replacement[1])-1]?.details.split(',')[0]??'?'}`:`${species}: ${choice}`;
  });
}
/** Explicit model mixture preserves defensive response families without a uniform floor over legal inputs. */
function opponentResponse(view:PlayerView,belief:TeamBelief,seed:string,stratum?:number):Response {
  const pool=planningActions(view,belief,12);
  if(!pool.length)throw new Error('No supported hypothetical opponent response');
  const best=Math.max(...pool.map(action=>action.score));
  const groups:Array<{category:Response['category'];weight:number;actions:ActionProbability[]}>=
    [{category:'tactical',weight:0.5,actions:pool.filter(action=>action.score>=best-18)},
      {category:'protect',weight:0.25,actions:pool.filter(action=>planningFamilies(view,action.command).some(f=>f.startsWith('protect:')))},
      {category:'switch',weight:0.25,actions:pool.filter(action=>planningFamilies(view,action.command).some(f=>f.startsWith('switch:')))}];
  const available=groups.filter(group=>group.actions.length),mass=available.reduce((sum,group)=>sum+group.weight,0);
  for(const group of available){group.weight/=mass;const total=group.actions.reduce((sum,a)=>sum+a.probability,0);group.actions=group.actions.map(a=>({...a,probability:a.probability/total}));}
  let threshold=stratum??seededRandom(`${seed}:category`)();
  const group=available.find(g=>{threshold-=g.weight;return threshold<0;})??available.at(-1)!;
  const command=chooseAction(group.actions,`${seed}:action`)!;
  return {command,families:planningFamilies(view,command),choices:describeChoices(view,command),category:group.category,
    modelWeight:round(available.reduce((sum,g)=>sum+g.weight*(g.actions.find(a=>a.command===command)?.probability??0),0))};
}
function validate(options:PlayerPlanOptions) {
  for(const [name,value,max] of [['samples',options.samples,32],['maxTurns',options.maxTurns,3]] as const)
    if(!Number.isInteger(value)||value<1||value>max)throw new Error(`${name} must be an integer from 1 to ${max}`);
  if(!Number.isFinite(options.budgetMs)||options.budgetMs<0||options.budgetMs>30_000)throw new Error('budgetMs must be finite and from 0 to 30000');
  if(typeof options.seed!=='string'||!options.seed.length||options.seed.length>256)throw new Error('seed must contain 1–256 characters');
  if(!Array.isArray(options.plans)||!options.plans.length||options.plans.length>8)throw new Error('plans must contain 1–8 joint plans');
  for(const plan of options.plans)if(typeof plan?.label!=='string'||!plan.label.trim()||plan.label.length>80||typeof plan.command!=='string'||!plan.command.trim()||plan.command.length>256)
    throw new Error('Each plan needs a 1–80 character label and a 1–256 character command');
}

/** Bounded imaginary joint-turn trials. The caller runs this synchronous work in a cancellable worker. */
export function evaluatePlayerPlans(view:PlayerView,belief:TeamBelief,sources:PlayerPlanSources,options:PlayerPlanOptions) {
  validate(options);
  const deadline=Date.now()+options.budgetMs,root=actorInput(view),opponent:PlayerSide=root.side==='p1'?'p2':'p1';
  const priorFactory=actorPriorFactory({regulationId:sources.regulationId,metaTeams:sources.metaTeams,usageRows:sources.usageRows});
  const evaluations:Evaluation[]=options.plans.map(plan=>({label:plan.label,command:plan.command,
    legality:root.legalCommands.includes(plan.command)?'legal':'illegal',
    counts:{attempted:0,terminal:0,capped:0,invalid:0,unsupported:0,notRun:0},reasons:[],terminalOutcomes:{wins:0,losses:0,draws:0},consequences:[],omittedConsequences:0,summary:null,
    responseCoverage:{interpretation:'Achieved model sampling coverage, not empirical opponent frequencies. Categories identify the selection channel; a joint command can belong to multiple tactical families. Summaries cover every returned consequence in that category.',
      unassigned:options.samples,categories:responseCategories.map(category=>({category,selected:0,rootExecuted:0,terminal:0,capped:0,invalid:0,unsupported:0,summary:null}))}}));
  const rootFailure=root.ended||root.request.wait?'Actor has no pending decision.':root.request.forceSwitch?
    'Partial-turn forced-switch roots are unsupported; a complete turn boundary is required.':!belief.candidates.length?
    'Insufficient opponent-set coverage; no actor world can be sampled.':undefined;
  for(const evaluation of evaluations){
    if(evaluation.legality==='illegal'){evaluation.counts.invalid=options.samples;evaluation.reasons.push('Command is absent from the exact own legalCommands.');}
    else if(rootFailure){evaluation.counts.unsupported=options.samples;evaluation.reasons.push(rootFailure);}
  }
  const eligible=evaluations.filter(e=>e.legality==='legal'&&!rootFailure),allConsequences=new Map(eligible.map(e=>[e,[] as Consequence[]]));
  const strata=responseStrata(options.samples,options.seed);
  let pairedSamples=0,budgetExhausted=false;
  for(let sample=0;sample<options.samples;sample++) {
    let paired=eligible.length>0;
    for(const evaluation of eligible) {
      if(Date.now()>=deadline){evaluation.counts.notRun++;paired=false;budgetExhausted=true;continue;}
      evaluation.counts.attempted++;
      const prefix=`${options.seed}:scenario:${sample}`;
      let response:Response|undefined,last:PlayerView|undefined,resolved=false;
      let outcome:Consequence|undefined;
      let sampleKind:'terminal'|'capped'|'invalid'|'unsupported'='invalid';
      try {
        // Deliberately identical seed for every root plan in the sample, independent of labels and commands.
        const world=sampleActorWorld(root,belief,`${prefix}:world`,{deadline,maxAttempts:64});
        let ownBelief=structuredClone(belief),otherBelief=priorFactory(actorInput(world.view(opponent))),depth=0;
        while(true) {
          const own=world.view(root.side);last=own;
          if(own.ended){outcome=consequence(own,root,'terminal','Sampled battle reached a terminal result.',response);break;}
          if(Date.now()>=deadline||depth>=options.maxTurns*8+4||own.turn-Math.max(1,root.turn)>=options.maxTurns){
            if(Date.now()>=deadline)budgetExhausted=true;
            const reason=Date.now()>=deadline?'Wall-time budget exhausted.':depth>=options.maxTurns*8+4?'Decision-step cap reached.':'Turn horizon reached; utility is not a win probability.';
            outcome=consequence(own,root,'capped',reason,response);break;
          }
          const other=world.view(opponent);
          ownBelief=updateBeliefFromView(ownBelief,own,{validateTeam:validateEngineTeam});
          otherBelief=updateBeliefFromView(otherBelief,other,{validateTeam:validateEngineTeam});
          const commands:{p1?:string;p2?:string}={};
          if(!other.request.wait){
            const chosen=opponentResponse(other,otherBelief,`${prefix}:opponent:${depth}`,depth===0?strata[sample]:undefined);
            commands[opponent]=chosen.command;if(depth===0)response=chosen;
          }
          if(!own.request.wait){
            const command=depth===0?evaluation.command:chooseAction(actionDistribution(own,ownBelief,'tactical'),`${prefix}:own:${depth}`);
            if(!command)throw new Error('No supported hypothetical actor continuation');
            commands[root.side]=command;
          }
          if(!commands.p1&&!commands.p2)throw new Error('Hypothetical world has no pending choice');
          if(Date.now()>=deadline){budgetExhausted=true;outcome=consequence(own,root,'capped','Wall-time budget exhausted before joint submission.',response);break;}
          world.step(commands);resolved=true;depth++;
        }
        sampleKind=outcome.kind;evaluation.counts[sampleKind]++;
        if(outcome.kind==='terminal')evaluation.terminalOutcomes[outcome.winner==='draw'?'draws':outcome.winner===root.side?'wins':'losses']++;
      }catch(error){
        const message=error instanceof Error?error.message:String(error);
        if(Date.now()>=deadline||/deadline exhausted/i.test(message)){
          budgetExhausted=true;
          sampleKind='capped';if(last)outcome=consequence(last,root,'capped','Wall-time budget exhausted.',response);
        }else if(error instanceof UnsupportedReplayError)sampleKind='unsupported';
        else sampleKind='invalid';
        evaluation.counts[sampleKind]++;
        if(evaluation.reasons.length<12&&!evaluation.reasons.includes(message))evaluation.reasons.push(message);
        paired=false;
      }
      if(response){
        const coverage=evaluation.responseCoverage.categories.find(row=>row.category===response!.category)!;
        evaluation.responseCoverage.unassigned--;coverage.selected++;coverage[sampleKind]++;
        if(resolved)coverage.rootExecuted++;
      }
      if(!resolved)paired=false;
      if(outcome)allConsequences.get(evaluation)!.push(outcome);
    }
    if(paired)pairedSamples++;
  }
  for(const evaluation of eligible){
    const outcomes=allConsequences.get(evaluation)!;
    evaluation.consequences=retainedConsequences(outcomes);evaluation.omittedConsequences=outcomes.length-evaluation.consequences.length;
    evaluation.summary=summarize(outcomes);
    for(const row of evaluation.responseCoverage.categories)row.summary=summarize(outcomes.filter(outcome=>outcome.opponentResponse?.category===row.category));
  }
  const status=rootFailure?'unsupported':budgetExhausted?'budget_exhausted':
    evaluations.some(e=>e.counts.unsupported||e.counts.invalid)?'partial':'completed';
  return {version:'actor-scenarios-v1' as const,status,requestedSamples:options.samples,maxTurns:options.maxTurns,pairedSamples,evaluations,
    responseModel:{categories:[{name:'tactical',weight:0.5},{name:'protect',weight:0.25},{name:'switch',weight:0.25}],
      weightInterpretation:'Stratified model mixture, not empirical opponent frequencies. Permuted strata spread early trials across response categories. Unavailable families are omitted and remaining weights renormalized; within families use tactical proposal weights.'},
    assumptions:[
      'Each sample reconstructs an imaginary world from actor-visible history and sourced set hypotheses. Paired root plans use the same world seed and response random variates; sampled randomness diverges after different actions.',
      'Both hypothetical players choose from pre-resolution actor views; no real opposing request, pending choice, checkpoint or RNG state is accepted.',
      'Complete joint turns include partner interactions and replacements. Later actor choices use a tactical heuristic; opponent choices use an explicit tactical/Protect/switch model mixture.',
      'Horizon utility is own mean HP fraction minus mean HP fraction of publicly seen opponents, on [-1,1]; it is not a win probability. Unseen opposing reserves, future threats and long-term strategy are not assigned fabricated values.',
      'HP, survival, boosts, speed stats and field summaries are hypothetical actor observations. Speed stats omit contextual multipliers; public opponent HP can be rounded, and unseen selected reserves remain unknown.',
      'Counts partition requested samples into terminal, capped, invalid, unsupported and notRun. attempted records reconstructions begun. pairedSamples excludes invalid, unsupported and unrun paired trials.',
      'At most eight illustrative consequences retain each sampled response category, utility and own-HP extrema, and lowest own survival. These selected examples are not a frequency sample; overall and per-category summaries include every returned consequence. Each example displays at most sixty public events.',
      'Response coverage counts include all trials with a selected root response, distinguish actual root execution from pre-submission caps and record invalid outcomes. Unassigned trials had no selected response. Bit-reversed, seed-rotated strata reduce systematic omission of defensive categories under early deadlines; achieved coverage remains model-dependent.',
      'Reconstruction uses at most sixty-four conditioning attempts per world.',
      'No player strength or calibrated outcome claim follows from these bounded model-dependent trials.',
    ],warnings:belief.warnings.slice(0,24)};
}
