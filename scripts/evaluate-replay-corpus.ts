import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {createHash} from 'node:crypto';
import {prepareReplayCorpus,evaluateFrozenCorpus} from '../src/simulation/corpus.js';
const input=resolve(process.argv[2]??'.vgc-helper/experiments/stages-4-6/holidayougi-mb.jsonl');
const output=resolve(process.argv[3]??dirname(input));
mkdirSync(output,{recursive:true});
const implementationHashes=Object.fromEntries(['src/simulation/learning.ts','src/simulation/corpus.ts','src/simulation/identity.ts','scripts/evaluate-replay-corpus.ts'].map(path=>[path,createHash('sha256').update(readFileSync(resolve(path))).digest('hex')]));
const codeFreeze=join(output,'corpus-code-freeze.json'),code=JSON.stringify(implementationHashes,null,2)+'\n';
if(existsSync(codeFreeze)&&readFileSync(codeFreeze,'utf8')!==code)throw new Error('Frozen feature/model/metric implementation changed; use a new output directory with an explicit evaluation-use label');
writeFileSync(codeFreeze,code);
const content=readFileSync(input,'utf8'),sampleHash=createHash('sha256').update(content).digest('hex');
const rows=content.split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line) as unknown);
const manifestPath=join(dirname(input),'corpus-manifest.json');
const manifest=existsSync(manifestPath)?JSON.parse(readFileSync(manifestPath,'utf8')) as {sampleSha256?:string}:undefined;
if(manifest?.sampleSha256 && manifest.sampleSha256!==sampleHash)throw new Error('Corpus bytes do not match the pinned acquisition manifest');
const prepared=prepareReplayCorpus(rows);
const freezePath=join(output,'corpus-split-freeze.json');
if(existsSync(freezePath)){
  const previous=JSON.parse(readFileSync(freezePath,'utf8')) as typeof prepared.frozen;
  if(previous.splitHash!==prepared.frozen.splitHash)throw new Error('Existing split freeze differs; use a new explicit output directory for a new protocol');
}else writeFileSync(freezePath,JSON.stringify(prepared.frozen,null,2)+'\n');
console.log(JSON.stringify({phase:'splits_frozen_before_tuning',splitHash:prepared.frozen.splitHash,audit:prepared.audit,splitGames:Object.fromEntries(Object.entries(prepared.splits).map(([key,value])=>[key,value.length]))}));
const result=evaluateFrozenCorpus(prepared,{onParametersFrozen(parameters){
  const path=join(output,'corpus-parameters-freeze.json');
  const serialized=JSON.stringify(parameters,null,2)+'\n';
  if(existsSync(path)&&readFileSync(path,'utf8')!==serialized)throw new Error('Frozen development-selected parameters changed; refusing test evaluation');
  writeFileSync(path,serialized);
  console.log(JSON.stringify({phase:'parameters_frozen_before_test',parameters}));
}});
const cohortPath=join(dirname(input),'featured-cohort.json');
let featuredRosterOverlap:unknown=null;
if(existsSync(cohortPath)){
  const cohort=JSON.parse(readFileSync(cohortPath,'utf8')) as {teams:Array<{id:string;name?:string;pokemon:Array<{species:string}>}>};
  featuredRosterOverlap=cohort.teams.map(team=>{
    const roster=team.pokemon.map(p=>p.species.toLowerCase().replace(/[^a-z0-9]/g,'')).sort().join(',');
    return {id:team.id,name:team.name,roster,sideAppearances:result.distributions.rosterCounts[roster]??0,
      splitSideAppearances:Object.fromEntries(Object.entries(result.splitDistributions).map(([key,value])=>[key,value.rosterCounts[roster]??0])),
      matchingReplayIds:prepared.records.filter(record=>['p1','p2'].some(side=>record.log.split('\n').filter(line=>line.startsWith(`|poke|${side}|`)).map(line=>line.split('|')[3]!.split(',')[0]!.toLowerCase().replace(/[^a-z0-9]/g,'')).sort().join(',')===roster)).map(record=>record.id)};
  });
}
const {artifact,...evaluation}=result;
writeFileSync(join(output,'corpus-evaluation.json'),JSON.stringify({...evaluation,evaluationUse:process.argv[4]??'initial-heldout-evaluation',acquisitionManifest:manifest,sampleHash,implementationHashes,featuredRosterOverlap,artifactPath:'action-prior.json',artifactAdoption:{adopted:artifact.adopted,reasons:artifact.adoptionReasons}},null,2)+'\n');
writeFileSync(join(output,'action-prior.json'),JSON.stringify(artifact,null,2)+'\n');
console.log(JSON.stringify({phase:'complete',test:result.evaluation.test,adopted:artifact.adopted,reasons:artifact.adoptionReasons,featuredRosterOverlap}));
