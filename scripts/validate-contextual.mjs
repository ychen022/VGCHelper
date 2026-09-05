import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {AppContext} from '../dist/app/context.js';
import {parseShowdownTeam} from '../dist/teams/parser.js';
import {loadRegulationProfile} from '../dist/regulation/profile.js';
import {evaluateTeam} from '../dist/analysis/matchup/evaluator.js';
import {compareEvaluations} from '../dist/analysis/matchup/compare-evaluations.js';

// Offline cached-source validation; no replay history or active snapshot is changed.
const app=new AppContext();
try {
  const profile=loadRegulationProfile();
  const original=readFileSync('examples/contextual-team.txt','utf8');
  const team=parseShowdownTeam(original,profile);
  const intent=JSON.parse(readFileSync('examples/contextual-evaluation.json','utf8'));
  const teams=app.repository.listMetaTeams(profile.id),usage=app.activeUsage(profile.id);
  const baseline=evaluateTeam(team,teams,usage,profile,intent);
  console.log(JSON.stringify({phase:'baseline',teams:baseline.cohort.length,matchups:baseline.matchups.length,tested:baseline.evaluation.coverage.testedPriorityThreats}));
  const comparison=compareEvaluations(team,parseShowdownTeam(original.replace('- Rock Slide','- Dire Claw'),profile),baseline,usage,profile);
  const selected=comparison.benchmarks.filter(b=>b.attackerSpecies==='Sneasler' && /Charizard|Floette/.test(b.defenderSpecies));
  const summary={createdAt:new Date().toISOString(),methodologyVersion:baseline.evaluation.methodologyVersion,
    coverage:baseline.evaluation.coverage,modePlans:baseline.evaluation.modePlans,matchupCount:baseline.matchups.length,
    sources:baseline.evaluation.sources,comparison:{counts:comparison.counts,cohortTeamIds:comparison.cohortTeamIds,matchupChanges:comparison.matchupChanges,
      benchmarks:selected,scenarios:comparison.scenarios.filter(s=>selected.some(b=>b.scenarioId===s.id)),contextChanges:comparison.contextChanges,limitations:comparison.limitations}};
  mkdirSync('examples/reports',{recursive:true});
  writeFileSync('examples/reports/contextual-validation.json',JSON.stringify(summary,null,2));
  const zardLoss=selected.some(b=>b.defenderSpecies==='Charizard-Mega-Y' && b.change==='loss');
  const fairyGain=selected.some(b=>b.defenderSpecies==='Floette-Mega' && b.change==='gain');
  console.log(JSON.stringify({phase:'comparison',counts:comparison.counts,zardLoss,fairyGain,report:'examples/reports/contextual-validation.json'}));
  if(!zardLoss || !fairyGain || !baseline.evaluation.modePlans.some(p=>p.modeId==='fairy-example' && p.userMega==='Banette')) process.exitCode=1;
} finally {app.close();}
