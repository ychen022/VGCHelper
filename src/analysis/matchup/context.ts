import {z} from 'zod';
import type {EvaluationContext, LeadMatchup, MetaTeam, PokemonTeam} from '../../domain/contracts.js';
import {VgcError} from '../../errors.js';
import {megaChoices} from './positions.js';
import {teamMatchesThreat} from './cohort.js';

const name=z.string().trim().min(1).max(120);
export const evaluationContextSchema=z.object({
  priorityThreats:z.array(name).max(12).optional(),
  roles:z.array(z.object({pokemon:name,move:name.optional(),purpose:z.string().trim().min(1).max(500),target:name.optional()}).strict()).max(12).optional(),
  modes:z.array(z.object({id:name,bringFour:z.array(name).length(4),lead:z.tuple([name,name]).optional(),mega:name.nullable(),targets:z.array(name).max(12).optional()}).strict()).max(6).optional(),
}).strict();

export function validateEvaluationContext(team: PokemonTeam, context: EvaluationContext): EvaluationContext {
  const parsed=evaluationContextSchema.safeParse(context);
  if(!parsed.success) throw new VgcError('INVALID_INPUT',parsed.error.message);
  context=parsed.data;
  const modes=context.modes ?? [];
  if(new Set(modes.map(m=>m.id)).size!==modes.length) throw new VgcError('INVALID_INPUT','Mode IDs must be unique');
  for(const role of context.roles ?? []) {
    const set=team.pokemon.find(s=>s.species===role.pokemon);
    if(!set || (role.move && !set.moves.includes(role.move))) throw new VgcError('INVALID_INPUT',`Role Pokemon/move is absent from the supplied team: ${role.pokemon} ${role.move??''}`);
  }
  for(const mode of modes) {
    if(new Set(mode.bringFour).size!==4 || mode.bringFour.some(s=>!team.pokemon.some(p=>p.species===s))) throw new VgcError('INVALID_INPUT',`Mode ${mode.id} must contain four distinct supplied Pokemon`);
    if(mode.lead && (mode.lead[0]===mode.lead[1] || mode.lead.some(s=>!mode.bringFour.includes(s)))) throw new VgcError('INVALID_INPUT',`Mode ${mode.id} lead must be two members of its four`);
    if(mode.mega && (!mode.bringFour.includes(mode.mega) || !megaChoices(team.pokemon).includes(mode.mega))) throw new VgcError('INVALID_INPUT',`Mode ${mode.id} Mega must be an eligible member of its four`);
  }
  return structuredClone(context);
}

export interface ModePlan {
  modeId: string;
  origin: 'user'|'inferred';
  opponentTeamId: string;
  bringFour: string[];
  lead: {first:string;second:string};
  userMega: string|null;
  screeningScore: number;
  worstResponse: {first:string;second:string};
  worstOpponentMega: string|null;
  responseCount: number;
  evidence: string[];
}

export function modeApplies(targets: string[]|undefined, team: MetaTeam): boolean {
  return !targets?.length || targets.some(t=>teamMatchesThreat(team,t));
}

/** Commit a lead and Mega before minimizing over all opposing lead/Mega responses. */
export function buildModePlans(user: PokemonTeam, opponent: MetaTeam, rows: LeadMatchup[], context: EvaluationContext): ModePlan[] {
  const candidates:ModePlan[]=[];
  const make=(modeId:string,origin:ModePlan['origin'],four:string[]|undefined,lead:{first:string;second:string},mega:string|null)=>{
    const activeMega=mega && [lead.first,lead.second].includes(mega)?mega:null;
    const responses=rows.filter(r=>r.userLead.first===lead.first && r.userLead.second===lead.second && (r.userMega??null)===activeMega);
    if(!responses.length)return;
    const worst=[...responses].sort((a,b)=>a.score-b.score)[0]!;
    const eligible=user.pokemon.filter(s=>![lead.first,lead.second].includes(s.species));
    const bench=eligible.map(s=>{
      const related=rows.filter(r=>[r.userLead.first,r.userLead.second].includes(s.species) && (r.userMega??null)===(mega && [r.userLead.first,r.userLead.second].includes(mega)?mega:null));
      return {species:s.species,score:related.reduce((n,r)=>n+r.score,0)/Math.max(1,related.length)};
    }).sort((a,b)=>b.score-a.score);
    const reserves=mega && ![lead.first,lead.second].includes(mega)?[mega,...bench.filter(s=>s.species!==mega).slice(0,1).map(s=>s.species)]:bench.slice(0,2).map(s=>s.species);
    candidates.push({modeId,origin,opponentTeamId:opponent.id,bringFour:four??[lead.first,lead.second,...reserves],lead,userMega:mega,
      screeningScore:worst.score,worstResponse:worst.opponentLead,worstOpponentMega:worst.opponentMega??null,responseCount:responses.length,
      evidence:[`The same lead, four and Mega allocation face all ${responses.length} screened opposing lead/Mega responses.`,
        origin==='user'?'User-supplied mode is a hypothesis; no score bonus is awarded.':'Inferred reserves use conditional lead coverage; switching and four-Pokemon endgames are not simulated.',
        mega && activeMega===null?`Mega ${mega} is reserved on the bench; the opening uses base forms.`:`Turn-one Mega: ${mega??'held'}.`,
        'The score measures the fixed opening only; bench utility requires follow-up validation.'],
    });
  };
  const leads=[...new Map(rows.map(r=>[`${r.userLead.first}|${r.userLead.second}`,r.userLead])).values()];
  for(const mode of context.modes??[]) {
    if(!modeApplies(mode.targets,opponent))continue;
    for(const lead of leads.filter(l=>[l.first,l.second].every(s=>mode.bringFour.includes(s)) && (!mode.lead || mode.lead.every(s=>[l.first,l.second].includes(s))))) make(mode.id,'user',mode.bringFour,lead,mode.mega);
  }
  for(const lead of leads) for(const mega of megaChoices(user.pokemon)) make(`inferred:${lead.first}+${lead.second}:${mega??'held'}`,'inferred',undefined,lead,mega);
  const userModes=[...new Set(candidates.filter(c=>c.origin==='user').map(c=>c.modeId))].map(id=>candidates.filter(c=>c.modeId===id).sort((a,b)=>b.screeningScore-a.screeningScore)[0]!);
  const inferred=candidates.filter(c=>c.origin==='inferred').sort((a,b)=>b.screeningScore-a.screeningScore).slice(0,3);
  return [...userModes,...inferred];
}
