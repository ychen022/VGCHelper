import {describe,it,expect,vi} from 'vitest';
import * as runner from '../src/simulation/runner.js';
import {readFileSync} from 'node:fs';
import {selectFeaturedCohort,runCohortExperiment} from '../src/simulation/experiment.js';
import {parseShowdownTeam} from '../src/teams/parser.js';
import {loadRegulationProfile} from '../src/regulation/profile.js';
import type {MetaTeam} from '../src/domain/contracts.js';
const team=parseShowdownTeam(readFileSync('examples/sample-team.txt','utf8'),loadRegulationProfile());
const meta=(id:string,placement:string,date:string):MetaTeam=>({id,name:id,regulationId:'champions-vgc-2026-m-c',roster:team.pokemon.map(p=>p.species),pokemon:structuredClone(team.pokemon),exactSets:true,placement,date,event:'Regional',source:{provider:'vgc-pastes',retrievedAt:'2026-09-07'}});
describe('featured-team experiments',()=>{
  it('selects high placements reproducibly with no wrong-regulation or duplicate roster entries',()=>{
    const newest=meta('newest','Champion','2026-08-31');
    const other=meta('other','2nd','2026-08-31');other.roster[0]='Incineroar';other.pokemon[0]!.species='Incineroar';
    const wrong={...meta('wrong','1st','2026-09-01'),regulationId:'other'};
    const result=selectFeaturedCohort([wrong,meta('old','1st','2026-07-01'),meta('fifth','5th','2026-09-01'),newest,other],2);
    expect(result.teams.map(t=>t.id)).toEqual(['newest','other']);
    expect(result.selection).toContain('placement');
  });
  it('reports separate opponent/policy outcomes and preserves caps',()=>{
    const progress:any[]=[];
    const result=runCohortExperiment({kind:'cohort',regulationId:'champions-vgc-2026-m-c',team,opponents:[meta('one','1st','2026-09-01')],metaTeams:[],usageRows:[],samples:1,maxTurns:1,budgetMs:30000,seed:'cohort',informationMode:'closed',policyProfiles:['tactical','damage'],playerPolicy:'tactical'},{progress:value=>progress.push(value)});
    expect(result.matchups).toHaveLength(2);
    expect(result.matchups.every(m=>m.report.variants[0]!.unresolved===1)).toBe(true);
    expect(result.aggregate.conditionalWinRate).toBeNull();
    expect(result.aggregate.interpretation).toContain('population');
    expect(progress.filter(p=>p.completedMatchups===1).every(p=>p.completedResults[0]?.variants[0]?.games===1)).toBe(true);
  },30000);
  it('suppresses policy sensitivity when an allocated matchup stopped early',()=>{
    const mock=vi.spyOn(runner,'runSimulation').mockReturnValue({status:'partial',variants:[{games:1,wins:1,losses:0,draws:0,invalid:0,unresolved:0,winRate:1}]} as runner.SimulationReport);
    try{
      const result=runCohortExperiment({kind:'cohort',regulationId:'champions-vgc-2026-m-c',team,opponents:[meta('one','1st','2026-09-01')],metaTeams:[],usageRows:[],samples:2,maxTurns:60,budgetMs:30000,seed:'partial',informationMode:'closed',policyProfiles:['tactical'],playerPolicy:'tactical'});
      expect(result.sensitivity[0]).toMatchObject({minimum:null,maximum:null});
    }finally{mock.mockRestore();}
  });
});
