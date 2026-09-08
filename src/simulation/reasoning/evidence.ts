import {ENGINE_PROFILE,moveMetadata,type PlayerView} from '../engine.js';
import type {TeamBelief} from '../beliefs.js';
import {planningActions,publicBattleState} from '../policy.js';
import {planningFamilies} from '../action-support.js';
import type {PokemonSet} from '../../domain/contracts.js';

/** Retain the mechanical set, not free-form source documents attached to a team. */
function setEvidence(set:PokemonSet):PokemonSet {
  return structuredClone({species:set.species,moves:set.moves,skillPoints:set.skillPoints,ivs:set.ivs,level:set.level,
    ...(set.nickname!==undefined?{nickname:set.nickname}:{}),...(set.item!==undefined?{item:set.item}:{}),
    ...(set.ability!==undefined?{ability:set.ability}:{}),...(set.nature!==undefined?{nature:set.nature}:{}),
    ...(set.gender!==undefined?{gender:set.gender}:{}),...(set.shiny!==undefined?{shiny:set.shiny}:{})});
}

/** The only inputs are the actor projection and its public-source belief. No session is accepted. */
export function buildPlayerEvidence(view:PlayerView,belief:TeamBelief) {
  const board=publicBattleState(view),limitations=[
    'Planning actions are a diverse heuristic proposal pool. Any command in legalCommands may be proposed for engine evaluation, including allied interactions outside this pool.',
    'Action scores and proposal weights are model judgments, not calibrated win probabilities or empirical opponent response frequencies.',
    'Move mechanics below are pinned engine metadata; they omit conditional effects, item and ability interactions. Use complete-turn scenarios to verify interactions.',
    'Opponent sets are hypotheses from actor-accessible sources. Unrevealed selection, investments and choices remain unknown.',
  ];
  const allLines=view.observations.flatMap(line=>line.split('\n'));
  const lines:string[]=[];let length=0;
  for(const line of allLines.toReversed()) {
    if(lines.length>=200||length+line.length+(lines.length?1:0)>24_000)break;
    lines.unshift(line);length+=line.length+(lines.length>1?1:0);
  }
  const candidates=[...belief.candidates].sort((a,b)=>b.weight-a.weight||a.id.localeCompare(b.id));
  const selected=candidates.slice(0,12);
  if(lines.length<allLines.length)limitations.push('Older public history is omitted from this bounded packet; board state still uses the complete actor history.');
  if(candidates.length>selected.length)limitations.push('Only the highest-weight twelve team hypotheses are displayed; displayed weights are not renormalized.');
  if(belief.status==='insufficient_coverage'||!candidates.length)limitations.push('Insufficient opponent-set coverage: no statistically adequate set distribution is available.');
  if(candidates.length<=1)limitations.push('At most one candidate is available; set uncertainty is not adequately explored.');
  const hypotheses=selected.map(candidate=>({
    proposalWeight:candidate.weight,pokemon:candidate.team.pokemon.map(setEvidence),
    source:structuredClone(candidate.source),sources:structuredClone(candidate.sources.slice(0,6)),
    sourceTeamIds:candidate.sourceTeamIds.slice(0,6),assumptions:candidate.assumptions.slice(0,12),
  }));
  const names=[...view.ownTeam.pokemon.flatMap(set=>set.moves),
    ...view.request.active?.flatMap(slot=>slot.moves.map(move=>move.move))??[],
    ...selected.flatMap(candidate=>candidate.team.pokemon.flatMap(set=>set.moves)),
    ...Object.values(board.sides).flatMap(side=>Object.values(side.pokemon).flatMap(p=>p.moves))];
  const unique=[...new Map(names.map(name=>[name.toLowerCase().replace(/[^a-z0-9]/g,''),name])).values()];
  const moves=unique.slice(0,64).flatMap(name=>{
    try{return [{name,...moveMetadata(name)}];}
    catch{limitations.push(`No pinned metadata found for move ${name}.`);return [];}
  });
  let plans:ReturnType<typeof planningActions>=[];
  try{plans=planningActions(view,belief,12);}catch(error){limitations.push(`Planning proposal unavailable: ${error instanceof Error?error.message:String(error)}`);}
  return {
    version:'actor-evidence-v1' as const,side:view.side,turn:view.turn,informationMode:view.informationMode,
    phase:view.ended?'ended':view.request.wait?'waiting':view.request.teamPreview?'team_preview':view.request.forceSwitch?'forced_switch':'turn',
    board,ownTeam:{pokemon:view.ownTeam.pokemon.map(setEvidence)},request:structuredClone(view.request),legalCommands:[...view.legalCommands],
    publicHistory:{lines,omittedLines:allLines.length-lines.length},
    planningActions:plans.map(action=>({command:action.command,heuristicScore:action.score,proposalWeight:action.probability,
      families:planningFamilies(view,action.command),reasons:action.reasons})),
    opponentBelief:{regulationId:belief.regulationId,status:belief.status,preview:[...belief.preview],known:structuredClone(belief.known),
      candidateCount:candidates.length,effectiveSampleSize:belief.effectiveSampleSize,hypotheses,
      omittedCandidates:candidates.length-selected.length,displayedWeight:selected.reduce((sum,c)=>sum+c.weight,0),
      weightInterpretation:'Posterior model/proposal weights conditional on public evidence; not measured joint set frequencies.',
      warnings:belief.warnings.slice(0,24),publicEvidence:belief.observations.slice(-24).map(observation=>observation.kind==='reveal'?structuredClone(observation):
        observation.kind==='damage'?{kind:'damage' as const,turn:observation.turn,observedDamage:observation.observedDamage}:
        {kind:'speed' as const,turn:observation.turn,actedFirst:observation.actedFirst,priority:observation.priority,otherPriority:observation.otherPriority,trickRoom:observation.trickRoom,orderUncertain:observation.orderUncertain})},
    mechanics:{engineRevision:ENGINE_PROFILE.revision,format:ENGINE_PROFILE.format,mod:ENGINE_PROFILE.mod,moves,omittedMoves:Math.max(0,unique.length-64)},
    limitations,
  };
}
