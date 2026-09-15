import {createHash} from 'node:crypto';
import {isExplicitMC,buildReplayExamples,trainContextualActionPrior,evaluateActionPrior,type ReplayCorpusRecord,type ReplayActionExample,type ContextualActionPriorArtifact,type PriorMetrics} from './learning.js';

const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const id=(text:string)=>text.toLowerCase().replace(/[^a-z0-9]/g,'');
const count=(counts:Record<string,number>,key:string)=>{counts[key]=(counts[key]??0)+1;};
export const CORPUS_PROTOCOL=Object.freeze({version:'strict-mc-corpus-v2',trainFraction:0.7,validationFraction:0.15,smoothingGrid:[0.05,0.5,2],minimumTrainingExamples:500,minimumTestExamples:50,minimumLogLossImprovement:0.01});
export function normalizeCorpusRecord(input:unknown):ReplayCorpusRecord {
  if(!input || typeof input!=='object')throw new Error('malformed_record');
  const row=input as Record<string,unknown>;
  if(typeof row.id!=='string'||!row.id||typeof row.log!=='string'||!row.log)throw new Error('missing_id_or_log');
  const rawTime=row.uploadTime??row.uploadtime;
  let time=typeof rawTime==='number'?rawTime:typeof rawTime==='string'&&/^\d+(\.\d+)?$/.test(rawTime)?Number(rawTime):Date.parse(String(rawTime??''));
  if(typeof rawTime==='number'||typeof rawTime==='string'&&/^\d+(\.\d+)?$/.test(rawTime))time*=time<1e12?1000:1;
  if(!Number.isFinite(time)||time<Date.UTC(2010,0)||time>Date.UTC(2100,0))throw new Error('missing_or_invalid_upload_time');
  const source=row.source as ReplayCorpusRecord['source']|undefined;
  if(!source?.provider || !(source.sourceVersion||source.revision))throw new Error('missing_source_version');
  const record:ReplayCorpusRecord={id:row.id,log:row.log.replace(/\r\n/g,'\n').trim(),uploadTime:new Date(time).toISOString(),source:{...source},
    ...(typeof (row.formatId??row.formatid)==='string'?{formatId:String(row.formatId??row.formatid)}:{}),
    ...(typeof row.format==='string'?{format:row.format}:{}),...(typeof row.rating==='number'&&Number.isFinite(row.rating)?{rating:row.rating}:{})};
  const tiers=record.log.split('\n').filter(line=>line.startsWith('|tier|')).map(line=>id(line.slice(6)));
  if(!tiers.length)throw new Error('missing_log_tier');
  if(!isExplicitMC(record)||new Set(tiers).size!==1)throw new Error('format_or_tier_mismatch');
  return record;
}
function series(record:ReplayCorpusRecord):string|undefined {return record.log.match(/\/game-(bestof3-[a-z0-9-]+)/i)?.[1];}
function gameStratum(record:ReplayCorpusRecord):string {
  if(!series(record))return 'single_game';
  const game=Number(record.log.match(/Game\s+(\d+)/i)?.[1]);
  return game===1?'series_first_game':game>1?'series_later_game':'series_game_unknown';
}
/** Exact disclosed six-set sheet fingerprint, independent of nicknames and order.
 * No unavailable EVs are invented. Partial sheets cannot establish team identity. */
function sheetFingerprints(record:ReplayCorpusRecord):string[] {
  const fingerprints:string[]=[];
  for(const line of record.log.split('\n').filter(line=>line.startsWith('|showteam|'))) {
    const packed=line.split('|').slice(3).join('|');
    const sets=packed.split(']').filter(Boolean);
    if(sets.length!==6)continue;
    const canonical=sets.map(set=>{
      const f=set.split('|');
      return [(f[1]||f[0]||''),f[2]??'',f[3]??'',...(f[4]??'').split(',').map(id).sort(),f[5]??'',f[7]??'',f[10]||'50'].map(id).join(':');
    }).sort();
    fingerprints.push(hash(canonical.join(';')));
  }
  return [...new Set(fingerprints)];
}
export interface FrozenCorpusSplit {
  version:typeof CORPUS_PROTOCOL.version;sourceHash:string;splitHash:string;
  smoothingGrid:number[];adoption:{minimumTrainingExamples:number;minimumTestExamples:number;minimumLogLossImprovement:number};
  cutoffs:{trainEnd:string|null;validationEnd:string|null};
  splits:{train:string[];validation:string[];test:string[]};
  purgedIds:string[];groups:Record<string,string>;
}
export interface PreparedReplayCorpus {
  records:ReplayCorpusRecord[];
  splits:{train:ReplayCorpusRecord[];validation:ReplayCorpusRecord[];test:ReplayCorpusRecord[]};
  frozen:FrozenCorpusSplit;
  audit:{seen:number;accepted:number;duplicates:number;exclusions:Record<string,number>;boundaryPurged:number;retained:number;seriesGroups:number;sharedSheetFingerprints:number;sourceVersions:string[]};
}
export function prepareReplayCorpus(inputs:unknown[]):PreparedReplayCorpus {
  const exclusions:Record<string,number>={},normalized:ReplayCorpusRecord[]=[];
  for(const input of inputs)try{normalized.push(normalizeCorpusRecord(input));}catch(error){count(exclusions,error instanceof Error?error.message:String(error));}
  normalized.sort((a,b)=>a.uploadTime!.localeCompare(b.uploadTime!)||a.id.localeCompare(b.id));
  const ids=new Set<string>(),logs=new Set<string>(),records:ReplayCorpusRecord[]=[];let duplicates=0;
  for(const row of normalized){const log=hash(row.log);if(ids.has(row.id)||logs.has(log)){duplicates++;continue;}ids.add(row.id);logs.add(log);records.push(row);}
  const parents=records.map((_,i)=>i);
  const find=(index:number):number=>parents[index]===index?index:(parents[index]=find(parents[index]!));
  const unite=(a:number,b:number)=>{const left=find(a),right=find(b);if(left!==right)parents[Math.max(left,right)]=Math.min(left,right);};
  const keys=new Map<string,number>(),seriesKeys=new Set<string>(),sheetUses=new Map<string,Set<number>>();
  records.forEach((record,index)=>{
    const match=series(record);if(match)seriesKeys.add(match);
    const sheets=sheetFingerprints(record);
    for(const sheet of sheets){const uses=sheetUses.get(sheet)??new Set<number>();uses.add(index);sheetUses.set(sheet,uses);}
    for(const key of [...(match?[`series:${match}`]:[]),...sheets.map(value=>`sheet:${value}`)]){
      const previous=keys.get(key);if(previous!==undefined)unite(previous,index);else keys.set(key,index);
    }
  });
  const trainAt=records[Math.floor(records.length*CORPUS_PROTOCOL.trainFraction)]?.uploadTime??null;
  const validationAt=records[Math.floor(records.length*(CORPUS_PROTOCOL.trainFraction+CORPUS_PROTOCOL.validationFraction))]?.uploadTime??null;
  const partition=(record:ReplayCorpusRecord)=>trainAt&&record.uploadTime!<trainAt?'train':validationAt&&record.uploadTime!<validationAt?'validation':'test';
  const membership=new Map<number,Set<string>>();
  records.forEach((record,index)=>{const root=find(index),parts=membership.get(root)??new Set<string>();parts.add(partition(record));membership.set(root,parts);});
  const splits:PreparedReplayCorpus['splits']={train:[],validation:[],test:[]},purgedIds:string[]=[],groups:Record<string,string>={};
  records.forEach((record,index)=>{
    const root=find(index);groups[record.id]=records[root]!.id;
    if(membership.get(root)!.size>1)purgedIds.push(record.id);else splits[partition(record)].push(record);
  });
  const sourceHash=hash(JSON.stringify(records.map(r=>[r.id,r.uploadTime,hash(r.log),r.source.sourceVersion??r.source.revision])));
  const frozenBase={version:CORPUS_PROTOCOL.version,sourceHash,smoothingGrid:[...CORPUS_PROTOCOL.smoothingGrid],adoption:{minimumTrainingExamples:CORPUS_PROTOCOL.minimumTrainingExamples,minimumTestExamples:CORPUS_PROTOCOL.minimumTestExamples,minimumLogLossImprovement:CORPUS_PROTOCOL.minimumLogLossImprovement},cutoffs:{trainEnd:trainAt,validationEnd:validationAt},splits:{train:splits.train.map(r=>r.id),validation:splits.validation.map(r=>r.id),test:splits.test.map(r=>r.id)},purgedIds,groups};
  return {records,splits,frozen:{...frozenBase,splitHash:hash(JSON.stringify(frozenBase))},audit:{seen:inputs.length,accepted:records.length,duplicates,exclusions,boundaryPurged:purgedIds.length,retained:records.length-purgedIds.length,seriesGroups:seriesKeys.size,sharedSheetFingerprints:[...sheetUses.values()].filter(uses=>uses.size>1).length,sourceVersions:[...new Set(records.map(r=>r.source.sourceVersion??r.source.revision!))].sort()}};
}
function summary(values:number[]) {
  const sorted=values.toSorted((a,b)=>a-b),histogram:Record<string,number>={};for(const value of values)count(histogram,String(value));
  const quantile=(p:number)=>sorted.length?sorted[Math.floor((sorted.length-1)*p)]!:null;
  return {count:values.length,mean:values.length?values.reduce((a,b)=>a+b,0)/values.length:null,min:sorted[0]??null,p25:quantile(.25),median:quantile(.5),p75:quantile(.75),p90:quantile(.9),max:sorted.at(-1)??null,histogram};
}
const CONTROL_MOVES=new Set(['tailwind','trickroom','icywind','electroweb','thunderwave','taunt','encore','followme','ragepowder','wideguard','quickguard','haze','clearsmog','fakeout','helpinghand','quash','disable','imprison']);
export function corpusBehaviorDistributions(records:ReplayCorpusRecord[]) {
  const lengths:number[]=[],switches:number[]=[],protects:number[]=[],controls:number[]=[],ratings:number[]=[],rosterCounts:Record<string,number>={},matchupRosterCounts:Record<string,number>={},strata:Record<string,number>={};
  let completed=0,executedMoves=0,protectMoves=0,controlMoves=0,voluntarySwitches=0,otherPostOpeningSwitches=0,otsGames=0;
  for(const record of records){
    let turn=0,moved=false,switched=0,protect=0,control=0;
    const rosters:{p1:string[];p2:string[]}={p1:[],p2:[]};
    for(const line of record.log.split('\n')){
      const [,kind,...args]=line.split('|');
      if(kind==='poke' && (args[0]==='p1'||args[0]==='p2'))rosters[args[0]].push(id((args[1]??'').split(',')[0]!));
      if(kind==='turn'){turn=Number(args[0]);moved=false;}
      if(kind==='switch' && turn>0){if(!moved)switched++;else otherPostOpeningSwitches++;}
      if(kind==='move'){moved=true;if(args.some(arg=>arg.startsWith('[from]')))continue;executedMoves++;const move=id(args[1]??'');if(move==='protect'){protect++;protectMoves++;}if(CONTROL_MOVES.has(move)){control++;controlMoves++;}}
    }
    lengths.push(turn);switches.push(switched);protects.push(protect);controls.push(control);voluntarySwitches+=switched;
    if(Number.isFinite(record.rating))ratings.push(record.rating!);
    if(/(?:^|\n)\|(?:win\||tie(?:\||\n|$))/.test(record.log))completed++;
    const fullSides=new Set(record.log.split('\n').filter(line=>line.startsWith('|showteam|')).filter(line=>line.split('|').slice(3).join('|').split(']').filter(Boolean).length===6).map(line=>line.split('|')[2]));
    if(fullSides.has('p1')&&fullSides.has('p2'))otsGames++;
    count(strata,gameStratum(record));
    const rosterKeys=[rosters.p1.sort().join(','),rosters.p2.sort().join(',')];
    for(const key of rosterKeys)if(key)count(rosterCounts,key);
    if(rosterKeys.every(Boolean))count(matchupRosterCounts,rosterKeys.sort().join(' vs '));
  }
  return {games:records.length,completed,incomplete:records.length-completed,completionRate:records.length?completed/records.length:0,executedMoves,protectMoves,controlMoves,voluntarySwitches,otherPostOpeningSwitches,
    protectPer100ExecutedMoves:executedMoves?100*protectMoves/executedMoves:0,controlPer100ExecutedMoves:executedMoves?100*controlMoves/executedMoves:0,
    turns:summary(lengths),voluntarySwitchesPerGame:summary(switches),protectPerGame:summary(protects),controlPerGame:summary(controls),rating:{...summary(ratings),missing:records.length-ratings.length},
    openTeamSheets:{bothFullSheets:otsGames,other:records.length-otsGames},strata,rosterCounts,matchupRosterCounts,
    definitions:{controlMoves:[...CONTROL_MOVES].sort(),voluntarySwitch:'A switch after a turn marker and before that turn first move; a public-log proxy for voluntary choices. Post-action switches are separately counted as replacement/pivot/ambiguous rather than labeled voluntary.',moves:'Direct executed move events only; called moves are excluded. No claim about chosen but censored commands.',rating:'Dataset record rating field; missing values excluded from rating summary.',rosters:'Exact sorted six-species public preview fingerprints where available.'}};
}
function baseline(artifact:ContextualActionPriorArtifact,kind:'empirical'|'global'|'species'):ContextualActionPriorArtifact {
  return kind==='empirical'?artifact:{...artifact,counts:{global:artifact.counts.global,bySpecies:kind==='species'?artifact.counts.bySpecies:{},byContext:{}}};
}
export function evaluateFrozenCorpus(prepared:PreparedReplayCorpus,options:{onParametersFrozen?:(parameters:unknown)=>void}={}) {
  const {frozen}=prepared;
  const train=prepared.splits.train.flatMap(buildReplayExamples),validation=prepared.splits.validation.flatMap(buildReplayExamples);
  const choices={} as Record<'empirical'|'global'|'species',{smoothing:number;metrics:PriorMetrics}>;
  const tuning:Array<{model:string;smoothing:number;metrics:PriorMetrics}>=[];
  const base=trainContextualActionPrior(train,{sourceVersion:prepared.audit.sourceVersions.join('+'),sourceHash:frozen.sourceHash});
  for(const model of ['empirical','global','species'] as const)for(const smoothing of frozen.smoothingGrid){
    const metrics=evaluateActionPrior(validation,baseline({...base,smoothing},model));
    tuning.push({model,smoothing,metrics});
    if(!choices[model] || metrics.logLoss<choices[model].metrics.logLoss)choices[model]={smoothing,metrics};
  }
  // Freeze all parameters and their hash before materializing or evaluating test labels.
  const parameters={choices:Object.fromEntries(Object.entries(choices).map(([name,value])=>[name,value.smoothing])),splitHash:frozen.splitHash};
  const parameterHash=hash(JSON.stringify(parameters));
  options.onParametersFrozen?.({...parameters,parameterHash});
  const test=prepared.splits.test.flatMap(buildReplayExamples);
  const testMetrics={} as Record<'empirical'|'global'|'species',PriorMetrics>;
  for(const model of ['empirical','global','species'] as const)testMetrics[model]=evaluateActionPrior(test,baseline({...base,smoothing:choices[model].smoothing},model));
  const artifact={...base,smoothing:choices.empirical.smoothing,adoptionReasons:[] as string[]};
  if(base.trainingExamples<frozen.adoption.minimumTrainingExamples)artifact.adoptionReasons.push('insufficient_training_examples');
  if(testMetrics.empirical.examples<frozen.adoption.minimumTestExamples)artifact.adoptionReasons.push('insufficient_test_examples');
  for(const model of ['global','species'] as const)if(testMetrics[model].logLoss-testMetrics.empirical.logLoss<frozen.adoption.minimumLogLossImprovement)artifact.adoptionReasons.push(`no_test_logloss_improvement_over_${model}`);
  if(!validation.some(e=>e.labelStatus==='executed'))artifact.adoptionReasons.push('validation_examples_missing');
  artifact.metrics={heldout:testMetrics.empirical,baseline:testMetrics.global,logLossImprovement:testMetrics.global.logLoss-testMetrics.empirical.logLoss,speciesBaseline:testMetrics.species,speciesLogLossImprovement:testMetrics.species.logLoss-testMetrics.empirical.logLoss};
  artifact.adopted=artifact.adoptionReasons.length===0;
  const labels=(examples:ReplayActionExample[])=>{const counts:Record<string,number>={};for(const example of examples)count(counts,example.labelStatus);return counts;};
  const strataEvaluation:Record<string,Record<string,PriorMetrics>>={};
  for(const stratum of ['single_game','series_first_game','series_later_game','series_game_unknown']){
    const stratumIds=new Set(prepared.splits.test.filter(r=>gameStratum(r)===stratum).map(r=>r.id));
    const examples=test.filter(e=>stratumIds.has(e.replayId));
    strataEvaluation[stratum]={};for(const model of ['empirical','global','species'] as const)strataEvaluation[stratum]![model]=evaluateActionPrior(examples,baseline({...base,smoothing:choices[model].smoothing},model));
  }
  return {protocol:CORPUS_PROTOCOL,frozen,audit:prepared.audit,parameters:{...parameters,parameterHash},tuning,
    evaluation:{test:testMetrics,testStrata:strataEvaluation,labels:{train:labels(train),validation:labels(validation),test:labels(test)},unknownTargetPolicy:'Fixed training move vocabulary plus one UNK category for every model and heldout example.',calibration:'Top-label expected calibration error in 10 equal-width confidence bins.'},
    distributions:corpusBehaviorDistributions(prepared.records),splitDistributions:Object.fromEntries(Object.entries(prepared.splits).map(([split,rows])=>[split,corpusBehaviorDistributions(rows)])),
    tacticalBaseline:{status:'unavailable' as const,reason:'Public replays do not supply exact actor requests, complete own sets, PP and selected reserves at each pre-action decision. Inventing these inputs would not be a comparable heldout action baseline.'},
    limitations:['This uniformly sampled corpus covers two pinned shards, not the entire format population.','Later series games may contain cross-game knowledge unavailable in a single replay; first/later strata are reported separately.','Prediction of uncensored move identity is not joint-command prediction or evidence of battle strength.','Sheet fingerprints cover exactly disclosed sheet fields, not hidden stat investments.','Contextual/global/species smoothing is chosen on validation only; test results cannot retune parameters.'],artifact};
}

/** Shared real/simulated behavioral projection; no corpus-format or split dependency. */
export function behaviorSummary(logs:string[]) {
  return corpusBehaviorDistributions(logs.map((log,index)=>({id:String(index),log,source:{provider:'behavior-summary'}})));
}
