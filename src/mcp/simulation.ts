import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {randomUUID} from 'node:crypto';
import {readFileSync,statSync} from 'node:fs';
import {z} from 'zod/v4';
import type {AppContext} from '../app/context.js';
import type {ReplayAnalysis} from '../domain/contracts.js';
import {VgcError} from '../errors.js';
import {loadRegulationProfile} from '../regulation/profile.js';
import {parseShowdownTeam} from '../teams/parser.js';
import type {EngineCheckpoint} from '../simulation/engine.js';
import type {KnownPokemon} from '../simulation/beliefs.js';
import {readOpenSheet} from '../replay/sheets.js';
import {isActionPriorAdoptable} from '../simulation/learning.js';
import type {EpisodeTrace,SimulationRequest,TeamInput} from '../simulation/runner.js';
import {selectFeaturedCohort,type CohortRequest} from '../simulation/experiment.js';
import {executeTool} from './results.js';

const outputSchema={result:z.unknown()};
const investment=z.object({hp:z.number().int().min(0).max(32).optional(),atk:z.number().int().min(0).max(32).optional(),def:z.number().int().min(0).max(32).optional(),spa:z.number().int().min(0).max(32).optional(),spd:z.number().int().min(0).max(32).optional(),spe:z.number().int().min(0).max(32).optional()});
export const teamSchema=z.object({
  team_export:z.string().min(1).max(20000).optional(),preview:z.array(z.string().min(1)).length(6).optional(),
  known:z.array(z.object({species:z.string(),item:z.string().optional(),ability:z.string().optional(),nature:z.string().optional(),moves:z.array(z.string()).max(4).optional(),skillPoints:investment.optional()})).max(6).optional(),
}).refine(value=>Boolean(value.team_export)!==Boolean(value.preview),'Supply exactly one of team_export or six-member preview');
const actionSelectionSchema=z.object({topFraction:z.number().positive().max(1).optional(),maxScoreGap:z.number().min(0).max(10000).optional()});
const settings={samples:z.number().int().min(1).max(10000).default(100),max_turns:z.number().int().min(1).max(200).default(80),budget_ms:z.number().int().min(100).max(900000).default(180000),seed:z.string().min(1).max(200).optional(),action_selection:actionSelectionSchema.optional()};
const policy=z.enum(['tactical','damage','search']);
const searchSchema=z.object({iterations:z.number().int().min(1).max(10000).optional(),budgetMs:z.number().int().min(1).max(30000).optional(),maxTurns:z.number().int().min(1).max(200).optional(),maxDepth:z.number().int().min(1).max(1000).optional(),candidateCap:z.number().int().min(1).max(4096).optional(),confirmationSamples:z.number().int().min(0).max(10000).optional()});
const fixedPlan=z.array(z.string().min(1)).length(4);
export function parseTeam(input:z.infer<typeof teamSchema>):TeamInput {
  if(input.team_export){
    if(input.known?.length)throw new VgcError('INVALID_INPUT','known is only supported with preview; a team export specifies the simulated exact team.');
    const team=parseShowdownTeam(input.team_export,loadRegulationProfile());
    return {team,preview:team.pokemon.map(p=>p.species)};
  }
  return {preview:input.preview!,...(input.known?{known:JSON.parse(JSON.stringify(input.known)) as KnownPokemon[]}:{})};
}
function sources(context:AppContext,regulationId:string){return {metaTeams:context.repository.listMetaTeams(regulationId),usageRows:context.activeUsage(regulationId)};}

export function registerSimulationTools(server:McpServer,context:AppContext):void {
  server.registerTool('vgc_simulate_battle',{
    title:'Simulate uncertain VGC battles',description:'Start an asynchronous Champions M-B full-game simulation. Each side knows its own team, with only preview/sheet/revealed opponent information. Exact supplied opponents stay hidden from policies. Preview-only sets are sampled from cached legal priors. Poll the returned job ID; rates are conditional model estimates. Optional candidate replaces p1 for paired team comparison.',
    inputSchema:{p1:teamSchema,p2:teamSchema,...settings,information_mode:z.enum(['closed','open_sheet']).default('closed'),p1_policy:policy.default('tactical'),p2_policy:policy.default('tactical'),search:searchSchema.optional(),p1_fixed_plan:fixedPlan.optional(),p2_fixed_plan:fixedPlan.optional(),compare_reselected_plan:z.boolean().default(false),comparison_team_export:z.string().min(1).max(20000).optional(),checkpoint_turns:z.array(z.number().int().min(1).max(200)).max(8).optional(),opponent_action_prior_path:z.string().min(1).max(4096).optional()},
    outputSchema,annotations:{destructiveHint:false},
  },async input=>executeTool(()=>{
    const regulationId=loadRegulationProfile().id;
    const request:SimulationRequest={kind:input.comparison_team_export?'comparison':'battle',regulationId,teams:{p1:parseTeam(input.p1),p2:parseTeam(input.p2)},...sources(context,regulationId),samples:input.samples,maxTurns:input.max_turns,budgetMs:input.budget_ms,seed:input.seed??randomUUID(),informationMode:input.information_mode,policies:{p1:input.p1_policy,p2:input.p2_policy},
      ...(input.search?{search:JSON.parse(JSON.stringify(input.search))}:{}),...(input.action_selection?{actionSelection:JSON.parse(JSON.stringify(input.action_selection))}:{}),fixedPlans:{...(input.p1_fixed_plan?{p1:input.p1_fixed_plan}:{}),...(input.p2_fixed_plan?{p2:input.p2_fixed_plan}:{})},compareReselectedPlan:input.compare_reselected_plan,
      ...(input.comparison_team_export?{comparisonTeam:parseShowdownTeam(input.comparison_team_export,loadRegulationProfile())}:{}),...(input.checkpoint_turns?{checkpointTurns:input.checkpoint_turns}:{})};
    if(input.opponent_action_prior_path){
      if(statSync(input.opponent_action_prior_path).size>2*1024*1024)throw new VgcError('INVALID_INPUT','Replay action-prior artifact exceeds 2 MiB.');
      const artifact:unknown=JSON.parse(readFileSync(input.opponent_action_prior_path,'utf8'));
      if(!isActionPriorAdoptable(artifact))throw new VgcError('INVALID_INPUT','Replay action-prior artifact did not pass the explicit M-B coverage and held-out adoption gate.');
      request.opponentActionPrior=artifact;
    }
    return context.simulations.start(request);
  }));
  server.registerTool('vgc_simulate_cohort',{
    title:'Evaluate a team against a Featured Teams cohort',description:'Start a bounded asynchronous multi-opponent experiment using cached M-B Featured Teams. Select exact team IDs or automatically choose distinct high-placing rosters. Reports individual matchups and policy sensitivity with equal cohort weighting, not population usage. Omitted published spreads remain inferred scenarios.',
    inputSchema:{team_export:z.string().min(1).max(20000),opponent_ids:z.array(z.string().min(1)).min(1).max(8).optional(),cohort_size:z.number().int().min(1).max(8).default(4),policy_profiles:z.array(policy).min(1).max(3).default(['tactical','damage']),player_policy:policy.default('tactical'),search:searchSchema.optional(),fixed_plan:fixedPlan.optional(),compare_reselected_plan:z.boolean().default(false),comparison_team_export:z.string().min(1).max(20000).optional(),information_mode:z.enum(['closed','open_sheet']).default('closed'),...settings},outputSchema,annotations:{destructiveHint:false},
  },async input=>executeTool(()=>{
    const profile=loadRegulationProfile(),cached=sources(context,profile.id);
    const selected=input.opponent_ids?input.opponent_ids.map(id=>{const team=cached.metaTeams.find(t=>t.id===id);if(!team)throw new VgcError('NOT_FOUND',`Cached cohort team not found: ${id}`);return team;}):selectFeaturedCohort(cached.metaTeams,input.cohort_size).teams;
    if(!selected.length||selected.some(t=>t.pokemon.length!==6))throw new VgcError('INVALID_INPUT','Cohort needs cached six-member published sets. Refresh Featured Teams first.');
    if(new Set(selected.map(t=>t.id)).size!==selected.length)throw new VgcError('INVALID_INPUT','Opponent IDs must be distinct.');
    const request:CohortRequest={kind:'cohort',regulationId:profile.id,team:parseShowdownTeam(input.team_export,profile),opponents:selected,...cached,
      samples:input.samples,maxTurns:input.max_turns,budgetMs:input.budget_ms,seed:input.seed??randomUUID(),informationMode:input.information_mode,policyProfiles:input.policy_profiles,playerPolicy:input.player_policy,compareReselectedPlan:input.compare_reselected_plan,
      ...(input.fixed_plan?{fixedPlan:input.fixed_plan}:{}),...(input.search?{search:JSON.parse(JSON.stringify(input.search))}:{}),...(input.action_selection?{actionSelection:JSON.parse(JSON.stringify(input.action_selection))}:{}),...(input.comparison_team_export?{comparisonTeam:parseShowdownTeam(input.comparison_team_export,profile)}:{})};
    return {...context.simulations.start(request),cohort:selected.map(t=>({id:t.id,name:t.name,placement:t.placement,source:t.source}))};
  }));
  server.registerTool('vgc_simulation_get',{title:'Get simulation progress or result',description:'Read persisted progress, outcome counts, uncertainty, assumptions and versioned provenance. Unresolved/invalid games are never silently losses or draws.',inputSchema:{job_id:z.string()},outputSchema,annotations:{readOnlyHint:true}},async({job_id})=>executeTool(()=>context.simulations.get(job_id)));
  server.registerTool('vgc_simulation_cancel',{title:'Cancel a simulation',description:'Stop a queued/running local simulation and retain completed progress. Safe to repeat.',inputSchema:{job_id:z.string()},outputSchema,annotations:{destructiveHint:false,idempotentHint:true}},async({job_id})=>executeTool(()=>context.simulations.cancel(job_id)));
  server.registerTool('vgc_simulation_trace',{title:'Inspect player battle logs and decision evidence',description:'Retrieve a retained episode from one player perspective. battleLog.lines includes the final turn resolution and win/tie event for completed games; status is complete, partial for unfinished games, or unavailable for older traces without a saved log. decisions contain bounded pre-action observations, posterior uncertainty and action alternatives. Only retained first-game traces are available; offset/limit paginate episodes, not turns. Private engine checkpoints and opposing requests/log channels are excluded.',inputSchema:{job_id:z.string(),perspective:z.enum(['p1','p2']).default('p1'),offset:z.number().int().min(0).default(0),limit:z.number().int().min(1).max(5).default(1)},outputSchema,annotations:{readOnlyHint:true}},async({job_id,perspective,offset,limit})=>executeTool(()=>{
    const page=context.simulations.trace(job_id,offset,limit);
    return {items:(page.items as EpisodeTrace[]).map(trace=>{
      const log=trace.battleLogs?.[perspective];
      return {episode:trace.episode,variant:trace.variant,outcome:trace.outcome,
        battleLog:log?{...log,status:log.ended?'complete':'partial'}:{status:'unavailable',lines:[],reason:'No final battle log was saved for this episode. Older traces require a rerun with the updated server to capture the final resolution.'},
        decisions:trace.decisions.filter(d=>d.side===perspective)};
    }),nextOffset:page.nextOffset};
  }));
  server.registerTool('vgc_replay_counterfactual',{
    title:'Compare alternative turn decisions',description:'Start full-game continuations from a saved simulation checkpoint OR a saved replay analysis. Public replays use only the prefix before the requested turn and reject unsupported reconstruction. Omit actions to compare up to three tactical candidates; optional commands use Showdown joint-choice syntax. Both sides adapt on later turns.',
    inputSchema:{job_id:z.string().optional(),analysis_id:z.string().optional(),trace_index:z.number().int().min(0).max(4).default(0),turn:z.number().int().min(1).max(200),actor:z.enum(['p1','p2']).optional(),continuation_policy:policy.default('tactical'),search:searchSchema.optional(),actions:z.array(z.object({label:z.string().min(1).max(80),command:z.string().min(1).max(200)})).min(1).max(8).optional(),...settings},outputSchema,annotations:{destructiveHint:false},
  },async input=>executeTool(()=>{
    if(Boolean(input.job_id)===Boolean(input.analysis_id))throw new VgcError('INVALID_INPUT','Supply exactly one of job_id or analysis_id.');
    let request:SimulationRequest;
    if(input.job_id){
      const original=context.simulations.request(input.job_id) as SimulationRequest;
      if((original.kind as string)==='cohort')throw new VgcError('INVALID_INPUT','Use an individual battle job for a saved-checkpoint counterfactual.');
      const checkpoint=context.simulations.checkpoint(input.job_id,input.trace_index,input.turn) as EngineCheckpoint;
      request={...original,kind:'branch',checkpoint,actor:input.actor??'p1',teams:{p1:{...original.teams.p1,preview:checkpoint.options.teams.p1.pokemon.map(p=>p.species)},p2:{...original.teams.p2,preview:checkpoint.options.teams.p2.pokemon.map(p=>p.species)}}};
      delete request.comparisonTeam;delete request.replayStart;delete request.compareReselectedPlan;delete request.fixedPlans;
      const trace=context.simulations.trace(input.job_id,input.trace_index,1).items[0] as EpisodeTrace;
      const actual=trace.decisions.find(d=>d.side===request.actor&&d.turn===input.turn);
      if(actual)request.baselineAction={label:'recorded decision',command:actual.command};
    } else {
      const record=context.repository.getAnalysis<ReplayAnalysis>(input.analysis_id!);
      if(!record||record.type!=='replay')throw new VgcError('NOT_FOUND','Saved replay analysis was not found. Run vgc_replay_analyze first.');
      const analysis=record.analysis;
      const saved=context.repository.getReplay(analysis.replayId);
      if(!saved||!analysis.userTeam)throw new VgcError('INVALID_INPUT','Replay analysis lacks its saved replay or complete own team.');
      const side=analysis.playerSide,opponent=side==='p1'?'p2':'p1';
      if(input.actor&&input.actor!==side)throw new VgcError('INVALID_INPUT','Public replay branching currently requires the analyzed player perspective.');
      const own:TeamInput={team:analysis.userTeam,preview:analysis.userTeam.pokemon.map(p=>p.species)};
      const boundary=saved.replay.events.findIndex(e=>e.type==='turn');
      if(boundary<0)throw new VgcError('INVALID_INPUT','Replay is missing its opening decision boundary.');
      const foe:TeamInput={preview:saved.replay.events.slice(0,boundary).filter(e=>e.type==='poke'&&e.args[0]===opponent).map(e=>e.args[1]!.split(',')[0]!)};
      const decision=saved.replay.events.findIndex(e=>e.type==='turn'&&Number(e.args[0])===input.turn);
      if(decision<0)throw new VgcError('INVALID_INPUT','Replay does not contain the requested decision turn.');
      for(const event of saved.replay.events.slice(0,decision).filter(e=>e.type==='showteam')){
        const target=event.args[0]===side?own:foe;
        target.publicKnown=readOpenSheet(event.args[1]!).map(set=>({species:set.species,item:set.item??'',...(set.ability?{ability:set.ability}:{}),moves:set.moves,...(set.nature?{nature:set.nature}:{})}));
      }
      request={kind:'branch',regulationId:analysis.regulationId,teams:side==='p1'?{p1:own,p2:foe}:{p1:foe,p2:own},...sources(context,analysis.regulationId),informationMode:'replay_observed',policies:{p1:'tactical',p2:'tactical'},actor:side,
        replayStart:{replay:saved.replay,userTeam:analysis.userTeam,playerSide:side,turn:input.turn},samples:input.samples,maxTurns:input.max_turns,budgetMs:input.budget_ms,seed:input.seed??randomUUID()};
    }
    Object.assign(request,{samples:input.samples,maxTurns:input.max_turns,budgetMs:input.budget_ms,seed:input.seed??randomUUID(),policies:{p1:input.continuation_policy,p2:input.continuation_policy}});
    if(input.search)request.search=JSON.parse(JSON.stringify(input.search));
    if(input.action_selection)request.actionSelection=JSON.parse(JSON.stringify(input.action_selection));
    if(input.actions)request.branches=input.actions;else delete request.branches;
    if(request.maxTurns<input.turn)throw new VgcError('INVALID_INPUT','max_turns must reach the branching turn.');
    return context.simulations.start(request);
  }));
}
