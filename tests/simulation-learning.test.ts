import {describe, expect, it} from 'vitest';

import {
  auditReplayRecords,
  buildReplayExamples,
  contextualActionWeights,
  evaluateActionPrior,
  isExplicitMB,
  isActionPriorAdoptable,
  splitReplayGroupsByTime,
  trainContextualActionPrior,
  type ContextualActionPriorArtifact,
  type ReplayCorpusRecord,
} from '../src/simulation/learning.js';
import {mixLearnedActionPrior} from '../src/simulation/learned-policy.js';
import type {PlayerView} from '../src/simulation/engine.js';

const baseLog = `|tier|[Gen 9 Champions] VGC 2026 Reg M-B
|gametype|doubles
|player|p1|Alice
|player|p2|Bob
|switch|p1a: Cat|Incineroar, L50|100/100
|switch|p1b: Giraffe|Farigiraf, L50|100/100
|switch|p2a: Ursa|Ursaluna-Bloodmoon, L50|100/100
|switch|p2b: Bolt|Raging Bolt, L50|100/100
|turn|1
|move|p1a: Cat|Fake Out|p2a: Ursa
|cant|p1b: Giraffe|flinch
|move|p2a: Ursa|Hyper Voice|p1a: Cat
|turn|2
|move|p1a: Cat|Knock Off|p2b: Bolt
|move|p1b: Giraffe|Trick Room|p1b: Giraffe`;

function record(overrides: Partial<ReplayCorpusRecord> = {}): ReplayCorpusRecord {
  return {
    id: 'battle-1',
    formatId: 'gen9championsvgc2026regmb',
    format: '[Gen 9 Champions] VGC 2026 Reg M-B',
    uploadTime: '2026-09-01T00:00:00.000Z',
    log: baseLog,
    source: {provider: 'fixture', sourceVersion: 'fixture-r1'},
    ...overrides,
  };
}

describe('simulation replay learning', () => {
  it('recognizes HolidayOugi category labels only with explicit matching M-B IDs and log tiers',()=>{
    const bo3=record({formatId:'gen9championsvgc2026regmbbo3',format:'[Gen 9] CHAMPIONS VGC 2026',log:baseLog.replace('Reg M-B','Reg M-B (Bo3)')});
    expect(isExplicitMB(bo3)).toBe(true);
    expect(isExplicitMB({...bo3,log:baseLog})).toBe(false);
    expect(isExplicitMB({...bo3,formatId:'gen9championsvgc2026regma'})).toBe(false);
    expect(isExplicitMB({...bo3,formatId:undefined} as unknown as ReplayCorpusRecord)).toBe(false);
  });
  it('accepts only explicit M-B records and reports coverage and duplicates', () => {
    const audit = auditReplayRecords([
      record(),
      record({id: 'duplicate'}),
      record({id: 'other', formatId: 'gen9vgc2026regm', format: 'VGC 2026 Reg M'}),
      {id: 'unknown', log: baseLog, source: {provider: 'fixture', sourceVersion: 'fixture-r1'}},
    ]);

    expect(audit.records).toEqual({seen: 4, accepted: 1, duplicates: 1, excluded: 2});
    expect(audit.exclusions).toEqual({duplicate: 1, format_mismatch: 1, format_missing: 1});
    expect(audit.sourceVersions).toEqual(['fixture-r1']);
    expect(audit.labels).toMatchObject({executed: 4, censored: 1});
  });

  it('uses only the public prefix and marks prevented actions as censored', () => {
    const first = buildReplayExamples(record());
    const changedFuture = buildReplayExamples(record({
      log: baseLog.replace('|move|p1a: Cat|Knock Off|p2b: Bolt', '|move|p1a: Cat|Flare Blitz|p2b: Bolt'),
    }));

    expect(first.find(example => example.turn === 1 && example.actor === 'p1a')?.features)
      .toEqual(changedFuture.find(example => example.turn === 1 && example.actor === 'p1a')?.features);
    const censored = first.find(example => example.actor === 'p1b' && example.turn === 1);
    expect(censored?.labelStatus).toBe('censored');
    expect(censored?.action).toBeUndefined();
    expect(first.every(example => !JSON.stringify(example.features).includes('Knock Off'))).toBe(true);
  });

  it('does not expose earlier same-turn resolution to a simultaneous action label', () => {
    const unchanged = buildReplayExamples(record());
    const pivotedDuringTurn = buildReplayExamples(record({log: baseLog.replace(
      '|move|p1a: Cat|Fake Out|p2a: Ursa',
      '|move|p1a: Cat|U-turn|p2a: Ursa\n|switch|p1a: Ape|Rillaboom, L50|100/100',
    )}));
    expect(unchanged.find(example => example.actor === 'p2a' && example.turn === 1)?.features)
      .toEqual(pivotedDuringTurn.find(example => example.actor === 'p2a' && example.turn === 1)?.features);
  });

  it('marks redirected and malformed move labels honestly', () => {
    const examples = buildReplayExamples(record({log: baseLog.replace(
      '|move|p1a: Cat|Fake Out|p2a: Ursa',
      '|-redirect|p2b: Bolt|p1a: Cat\n|move|p1a: Cat|Fake Out|p2b: Bolt\n|move||Protect|',
    )}));
    expect(examples.find(example => example.action?.move === 'Fake Out')?.labelStatus).toBe('retargeted');
    expect(examples.some(example => example.labelStatus === 'ambiguous')).toBe(true);
  });

  it('keeps duplicate groups in one chronological partition', () => {
    const split = splitReplayGroupsByTime([
      record({id: 'old-a', uploadTime: '2026-01-01T00:00:00Z', duplicateGroup: 'same'}),
      record({id: 'old-b', uploadTime: '2026-02-01T00:00:00Z', duplicateGroup: 'same'}),
      record({id: 'mid', uploadTime: '2026-03-01T00:00:00Z'}),
      record({id: 'new', uploadTime: '2026-04-01T00:00:00Z'}),
    ], {train: 0.5, validation: 0.25});
    const partitions = [split.train, split.validation, split.test];
    expect(partitions.filter(part => part.some(item => item.duplicateGroup === 'same'))).toHaveLength(1);
    expect(new Date(split.train.at(-1)!.uploadTime!).getTime()).toBeLessThanOrEqual(
      new Date(split.test[0]!.uploadTime!).getTime(),
    );
  });

  it('trains an optional contextual prior and gates adoption on evidence', () => {
    const examples = buildReplayExamples(record()).filter(example => example.labelStatus === 'executed');
    const artifact = trainContextualActionPrior(examples, {
      sourceVersion: 'fixture-r1', minimumTrainingExamples: 20,
    });
    expect(artifact.adopted).toBe(false);
    expect(artifact.adoptionReasons).toContain('insufficient_training_examples');
    expect(artifact.formatId).toBe('gen9championsvgc2026regmb');
    expect(artifact.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(isActionPriorAdoptable(artifact)).toBe(false);

    const qualified = {
      ...artifact,
      trainingExamples: 500,
      adopted: true,
      adoptionReasons: [],
      metrics: {
        heldout: {examples: 50, logLoss: 1, topKRecall: {1: 0.5, 3: 0.8}, calibrationError: 0.1},
        baseline: {examples: 50, logLoss: 1.2, topKRecall: {1: 0.4, 3: 0.7}, calibrationError: 0.2},
        logLossImprovement: 0.2,
        speciesBaseline:{examples:50,logLoss:1.1,topKRecall:{1:0.4,3:0.7},calibrationError:0.2},speciesLogLossImprovement:0.1,
      },
    };
    expect(isActionPriorAdoptable(qualified)).toBe(true);
    expect(isActionPriorAdoptable({...qualified,metrics:{...qualified.metrics,speciesBaseline:{...qualified.metrics.speciesBaseline,logLoss:0.9},speciesLogLossImprovement:-0.1}})).toBe(false);
    expect(isActionPriorAdoptable({...qualified, formatId: 'gen9vgc2026regm'})).toBe(false);
    expect(isActionPriorAdoptable({...qualified, metrics: {}})).toBe(false);
    expect(isActionPriorAdoptable({...qualified, counts: {}})).toBe(false);
    expect(isActionPriorAdoptable({...qualified, smoothing: Number.NaN})).toBe(false);
    expect(isActionPriorAdoptable({...qualified, counts: {...qualified.counts, global: {'move:Fake Out': -1}}})).toBe(false);
    expect(isActionPriorAdoptable({...qualified, metrics: {...qualified.metrics, logLossImprovement: 10}})).toBe(false);

    const weights = contextualActionWeights(artifact, {
      species: 'Incineroar', turn: 1, publicBoard: ['Farigiraf', 'Raging Bolt', 'Ursaluna-Bloodmoon'],
    }, ['move:Fake Out:p2a', 'move:Protect:self']);
    expect(Object.values(weights).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1);
    expect(weights['move:Fake Out:p2a']).toBeGreaterThan(weights['move:Protect:self']!);

    const metrics = evaluateActionPrior(examples, artifact);
    expect(metrics).toEqual(expect.objectContaining({examples: examples.length}));
    expect(metrics.logLoss).toBeGreaterThanOrEqual(0);
    expect(metrics.topKRecall[1]).toBeGreaterThanOrEqual(0);
    expect(metrics.calibrationError).toBeGreaterThanOrEqual(0);
  });

  it('mixes an adopted view-only move prior without changing switch mass', () => {
    const view = {
      side: 'p1', turn: 1, ownTeam: {pokemon: []}, informationMode: 'closed', ended: false,
      observations: [
        '|switch|p1a: Cat|Incineroar, L50|100/100', '|switch|p1b: Giraffe|Farigiraf, L50|100/100',
        '|switch|p2a: Ursa|Ursaluna-Bloodmoon, L50|100/100', '|switch|p2b: Bolt|Raging Bolt, L50|100/100', '|turn|1',
      ],
      legalCommands: [],
      request: {
        side: {name: 'Alice', id: 'p1', pokemon: [
          {ident:'p1: Cat',details:'Incineroar, L50',condition:'100/100',active:true,stats:{},moves:['fakeout','protect'],baseAbility:'intimidate',item:''},
          {ident:'p1: Giraffe',details:'Farigiraf, L50',condition:'100/100',active:true,stats:{},moves:['trickroom','protect'],baseAbility:'armortail',item:''},
          {ident:'p1: Bench',details:'Garchomp, L50',condition:'100/100',active:false,stats:{},moves:['protect'],baseAbility:'roughskin',item:''},
        ]},
        active:[{moves:[{move:'Fake Out',id:'fakeout'},{move:'Protect',id:'protect'}]},{moves:[{move:'Trick Room',id:'trickroom'},{move:'Protect',id:'protect'}]}],
      },
    } satisfies PlayerView;
    const distribution = [
      {command:'move 1 1, move 1',score:3,probability:0.4,reasons:[]},
      {command:'move 2, move 2',score:2,probability:0.4,reasons:[]},
      {command:'switch 3, move 2',score:1,probability:0.2,reasons:[]},
    ];
    const artifact = {
      schemaVersion:1,kind:'empirical-contextual-action-prior',formatId:'gen9championsvgc2026regmb',sourceVersion:'fixture',sourceHash:'a'.repeat(64),createdAt:'2026-09-07',trainingExamples:500,smoothing:0.5,
      counts:{global:{'move:Fake Out':10,'move:Trick Room':10,'move:Protect':1},bySpecies:{Incineroar:{'move:Fake Out':10,'move:Protect':1},Farigiraf:{'move:Trick Room':10,'move:Protect':1}},byContext:{}},
      metrics:{heldout:{examples:50,logLoss:1,topKRecall:{1:0.5,3:0.8},calibrationError:0.1},baseline:{examples:50,logLoss:1.2,topKRecall:{1:0.4,3:0.7},calibrationError:0.2},logLossImprovement:0.2,speciesBaseline:{examples:50,logLoss:1.1,topKRecall:{1:0.4,3:0.7},calibrationError:0.2},speciesLogLossImprovement:0.1},adopted:true,adoptionReasons:[],
    } satisfies ContextualActionPriorArtifact;
    const mixed=mixLearnedActionPrior(view,distribution,artifact,0.15);
    expect(mixed[0]!.probability).toBeGreaterThan(distribution[0]!.probability);
    expect(mixed[1]!.probability).toBeLessThan(distribution[1]!.probability);
    expect(mixed[2]!.probability).toBeCloseTo(distribution[2]!.probability);
    const rejected={...artifact,adopted:false};
    expect(mixLearnedActionPrior(view,distribution,rejected)).toBe(distribution);
    expect(mixLearnedActionPrior(view,distribution)).toBe(distribution);
  });
});

describe('honest action evaluation and identity features',()=>{
  it('updates public form and swapped positions only at later decision boundaries',()=>{
    const log='|switch|p1a: Dragon|Dragonite, L50|100/100\n|switch|p1b: Shark|Garchomp, L50|100/100\n|turn|1\n|detailschange|p1a: Dragon|Dragonite-Mega, L50\n|move|p1a: Dragon|Protect|p1a: Dragon\n|turn|2\n|move|p1a: Dragon|Protect|p1a: Dragon\n|swap|p1a: Dragon|1\n|turn|3\n|move|p1b: Dragon|Protect|p1b: Dragon';
    const examples=buildReplayExamples(record({log}));
    expect(examples[0]!.features.species).toBe('Dragonite');
    expect(examples[0]!.labelStatus).toBe('executed');
    expect(examples[1]!.features.species).toBe('Dragonite-Mega');
    expect(examples[1]!.features.previouslyRevealedMoves).toEqual(['Protect']);
    expect(examples[2]!.features.species).toBe('Dragonite-Mega');
  });
  it('keeps revealed moves attached to Pokemon identity across switches and returns',()=>{
    const examples=buildReplayExamples(record({log:baseLog+'\n|switch|p1a: Ape|Rillaboom, L50|100/100\n|turn|3\n|move|p1a: Ape|Grassy Glide|p2a: Ursa\n|switch|p1a: Cat|Incineroar, L50|100/100\n|turn|4\n|move|p1a: Cat|Protect|p1a: Cat'}));
    expect(examples.find(e=>e.turn===3 && e.actor==='p1a')!.features.previouslyRevealedMoves).toEqual([]);
    expect(examples.find(e=>e.turn===4 && e.actor==='p1a')!.features.previouslyRevealedMoves).toEqual(['Fake Out','Knock Off']);
  });
  it('uses a fixed training vocabulary plus unknown for every heldout target',()=>{
    const examples=buildReplayExamples(record()).filter(e=>e.labelStatus==='executed');
    const artifact=trainContextualActionPrior([examples[0]!],{sourceVersion:'test',smoothing:1});
    const known=evaluateActionPrior([examples[0]!],artifact);
    const unknown=evaluateActionPrior([{...examples[0]!,action:{kind:'move',move:'Never Seen',key:'move:Never Seen'}}],artifact);
    expect(known.logLoss).toBeCloseTo(-Math.log(2/3));
    expect(unknown.logLoss).toBeCloseTo(-Math.log(1/3));
    expect(known.calibrationError).toBeCloseTo(1/3);
    expect(unknown.calibrationError).toBeCloseTo(2/3);
  });
  it('marks called and Follow Me target-ambiguous actions instead of inventing command targets',()=>{
    const examples=buildReplayExamples(record({log:baseLog.replace('|move|p1a: Cat|Fake Out|p2a: Ursa','|-singleturn|p2a: Ursa|move: Follow Me\n|move|p1a: Cat|Fake Out|p2a: Ursa\n|move|p1a: Cat|Tackle|p2a: Ursa|[from] move: Sleep Talk')}));
    expect(examples.find(e=>e.action?.move==='Fake Out')!.labelStatus).toBe('retargeted');
    expect(examples.find(e=>e.action?.move==='Tackle')!.labelStatus).toBe('ambiguous');
  });
});

it('does not call an observed target the original command target after another Pokemon faints',()=>{
  const examples=buildReplayExamples(record({log:baseLog.replace('|move|p2a: Ursa|Hyper Voice|p1a: Cat','|faint|p1b: Giraffe\n|move|p2a: Ursa|Thunderbolt|p1a: Cat')}));
  expect(examples.find(e=>e.action?.move==='Thunderbolt')!.action!.target).toBeUndefined();
});

it('computes binned calibration with bin accuracy, not one minus true-label probability',()=>{
  const sample=buildReplayExamples(record()).find(e=>e.action?.move==='Fake Out')!;
  const artifact=trainContextualActionPrior([sample],{sourceVersion:'test',smoothing:1});
  const metrics=evaluateActionPrior([sample,{...sample,action:{kind:'move',move:'Unknown',key:'move:Unknown'}}],artifact);
  expect(metrics.calibrationError).toBeCloseTo(1/6);
});
