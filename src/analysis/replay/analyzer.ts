import {toID} from '@smogon/calc';
import {calculatorVersion} from '../../calc/champions.js';
import type {MetaTeam, ParsedReplay, PokemonTeam, ReplayAnalysis, ReplayFinding} from '../../domain/contracts.js';
import {VgcError} from '../../errors.js';
import type {RegulationProfile} from '../../regulation/profile.js';
import {newId, sha256} from '../../util/hash.js';
import {knownBefore, replayAlternatives} from './scenarios.js';

const speciesId = (value?: string) => toID(value ?? '').replace(/mega(?:x|y|z)?$/, '');
const nickname = (ident?: string) => ident?.split(':').slice(1).join(':').trim().toLowerCase();

export function identifyPlayerSide(replay: ParsedReplay, team: PokemonTeam, playerName?: string): 'p1' | 'p2' {
  if (playerName) {
    const found = (['p1', 'p2'] as const).find(side => toID(replay.finalState.sides[side].player ?? '') === toID(playerName));
    if (!found) throw new VgcError('INVALID_REPLAY', `Player "${playerName}" does not appear in this replay`);
    return found;
  }
  const roster = new Set(team.pokemon.map(set=>speciesId(set.species)));
  const matching = (['p1', 'p2'] as const).filter(side => {
    const observed = Object.values(replay.finalState.sides[side].pokemon).map(p=>speciesId(p.species)).filter(Boolean);
    return observed.length > 0 && observed.every(s=>roster.has(s));
  });
  if (matching.length !== 1) throw new VgcError('INVALID_REPLAY', 'Could not identify the user side from the supplied team; provide player_name');
  return matching[0]!;
}

export function teamVersion(team: PokemonTeam): string {
  return sha256(JSON.stringify(team.pokemon.map(({species,item,ability,nature,moves,skillPoints,level}) => ({species,item,ability,nature,moves:[...moves].sort(),skillPoints,level})).sort((a,b)=>a.species.localeCompare(b.species))));
}

export function analyzeReplay(replay: ParsedReplay, userTeam: PokemonTeam, metaTeams: MetaTeam[], profile: RegulationProfile, playerName?: string): ReplayAnalysis {
  const playerSide = identifyPlayerSide(replay, userTeam, playerName);
  const opponentSide = playerSide === 'p1' ? 'p2' : 'p1';
  const compatibleMeta = metaTeams.filter(team=>team.regulationId === profile.id);
  const findings: ReplayFinding[] = [];
  for (const turn of replay.turns) {
    const knowledge = knownBefore(turn.beforeEvents);
    const own = (value?: string) => value?.startsWith(playerSide) ?? false;
    const moves = turn.events.filter(e=>e.type==='move' && own(e.args[0]));
    for (const action of moves) {
      const nextMove = turn.events.find(e=>e.index > action.index && e.type==='move');
      const effects = turn.events.filter(e=>e.index > action.index && (!nextMove || e.index < nextMove.index));
      const failure = effects.find(e=>['-fail','-miss','-immune','-block'].includes(e.type));
      const move = action.args[1] ?? '';
      if (failure) {
        findings.push({id:newId('finding'),turn:turn.turn,kind:'improvement',category:'failed-action',decisionAssessment:'review',priority:65,
          title:`Review the unsuccessful ${move} attempt`,knownBefore:knowledge,
          evidence:[action.raw,failure.raw],eventIndices:[action.index,failure.index],confidence:0.65,
          alternatives:[{action:'Check target, move conditions and the partner’s objective before repeating this line',rationale:'Failure is an observed outcome. Immunity, Protect, accuracy and hidden information can justify different assessments; it does not prove the choice was wrong.'}]});
        continue;
      }
      const establishesControl = effects.some(e =>
        (e.type==='-sidestart' && own(e.args[0]) && /Tailwind/.test(e.args[1]??'')) ||
        (e.type==='-fieldstart' && /Trick Room/.test(e.args[0]??'')) ||
        (e.type==='-unboost' && e.args[0]?.startsWith(opponentSide) && e.args[1]==='spe'));
      if (establishesControl) findings.push({id:newId('finding'),turn:turn.turn,kind:'strength',category:'speed-control',decisionAssessment:'observed-success',priority:45,
        title:`Established speed control with ${move}`,knownBefore:knowledge,evidence:effects.filter(e=>['-sidestart','-fieldstart','-unboost'].includes(e.type)).map(e=>e.raw),eventIndices:[action.index],alternatives:[],confidence:0.9});
    }
    const opponentFaints = turn.events.filter(e=>e.type==='faint' && e.args[0]?.startsWith(opponentSide));
    if (opponentFaints.length) findings.push({id:newId('finding'),turn:turn.turn,kind:'strength',category:'knockout',decisionAssessment:'observed-success',priority:50+opponentFaints.length*5,
      title:`Removed ${opponentFaints.length} opposing Pokémon`,knownBefore:knowledge,evidence:opponentFaints.map(e=>e.raw),eventIndices:opponentFaints.map(e=>e.index),alternatives:[],confidence:1});
    const userFaints = turn.events.filter(e=>e.type==='faint' && own(e.args[0]));
    for (const faint of userFaints) {
      const actor = Object.values(turn.beforeEvents.sides[playerSide].pokemon).find(p=>p.nickname.toLowerCase()===nickname(faint.args[0]) && p.active);
      const set = userTeam.pokemon.find(s=>speciesId(s.species)===speciesId(actor?.species));
      const action = moves.find(e=>nickname(e.args[0])===nickname(faint.args[0]));
      findings.push({id:newId('finding'),turn:turn.turn,kind:'improvement',category:'positioning',decisionAssessment:'review',priority:80+(userFaints.length>1?10:0),
        title:`Review the position before ${actor?.species ?? nickname(faint.args[0]) ?? 'your Pokémon'} fainted`,knownBefore:knowledge,
        evidence:[faint.raw,...(action?[action.raw]:['No move from this Pokémon was logged before it fainted; its selected command is unknown.'])],eventIndices:[faint.index,...(action?[action.index]:[])],
        alternatives:actor&&set?replayAlternatives(turn.beforeEvents,actor,set,userTeam,compatibleMeta,action?.args[1]):[],confidence:0.6});
    }
    if (turn.turn===1 && !userFaints.length) {
      const actor = Object.values(turn.beforeEvents.sides[playerSide].pokemon).find(p=>p.active);
      const set = userTeam.pokemon.find(s=>speciesId(s.species)===speciesId(actor?.species));
      if (actor&&set) findings.push({id:newId('finding'),turn:1,kind:'uncertainty',category:'opening-plan',decisionAssessment:'review',priority:35,
        title:'Compare the opening plan against both opposing slots',knownBefore:knowledge,evidence:moves.map(e=>e.raw),eventIndices:moves.map(e=>e.index),
        alternatives:replayAlternatives(turn.beforeEvents,actor,set,userTeam,compatibleMeta,moves.find(e=>nickname(e.args[0])===actor.nickname.toLowerCase())?.args[1]),confidence:0.5});
    }
  }
  const sources = [...new Map(compatibleMeta.map(team=>[JSON.stringify(team.source),team.source])).values()];
  const winner = replay.document.metadata.winner;
  const player = replay.finalState.sides[playerSide].player;
  const result = winner==='Tie'?'tie':winner&&player?(toID(winner)===toID(player)?'win':'loss'):'unknown';
  findings.sort((a,b)=>(b.priority??0)-(a.priority??0)||a.turn-b.turn);
  const improvements = findings.filter(f=>f.kind==='improvement');
  return {id:newId('replay_analysis'),replayId:replay.document.metadata.id??replay.document.contentHash,regulationId:profile.id,
    regulationVersion:sha256(JSON.stringify(profile)),calculatorVersion:calculatorVersion(),teamVersion:teamVersion(userTeam),userTeam:structuredClone(userTeam),
    createdAt:new Date().toISOString(),playerSide,result,findings,
    summary:{strengths:findings.filter(f=>f.kind==='strength').slice(0,5).map(f=>`Turn ${f.turn}: ${f.title}`),improvements:improvements.slice(0,5).map(f=>`Turn ${f.turn}: ${f.title}`),
      practiceFocus:[...(improvements.some(f=>f.category==='positioning')?['Before risking a slot, name its partner’s objective and compare Protect, a known bench switch, and an attack.']:[]),
        ...(improvements.some(f=>f.category==='failed-action')?['Before selecting a move, check immunities, targeting, and failure conditions.']:[]),
        'Review your lead and bring-four plan against both opposing slots; distinguish a good decision from a favorable roll.'].slice(0,3)},
    assumptions:['The supplied team is authoritative; selected commands that did not execute may be absent from the replay.',
      'Each alternative uses only the state available before that turn. A faint is a review prompt, not proof of an error.',
      'Damage scenarios assume attacks execute; they do not resolve a full simultaneous turn, speed ties, redirection, PP, choice locks or switch trees.',
      'Public HP is rounded. Confidence values rank evidence and sampled sets; they are not calibrated probabilities.',
      ...(sources.length?[]:['No verified metagame cohort is available; opponent calculations require revealed open sheets.']),
      ...(replay.finalState.warnings??[])],sources};
}
