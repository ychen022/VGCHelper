import {createHash} from 'node:crypto';
import {speciesIdentity} from './identity.js';

export const M_B_FORMAT_ID = 'gen9championsvgc2026regmb';
export const M_B_FORMAT_NAME = '[Gen 9 Champions] VGC 2026 Reg M-B';

export interface ReplayCorpusRecord {
  id: string;
  formatId?: string;
  format?: string;
  uploadTime?: string;
  rating?: number;
  log: string;
  duplicateGroup?: string;
  source: {provider: string; sourceVersion?: string; revision?: string; url?: string};
}

export type ActionLabelStatus = 'executed' | 'censored' | 'unexecuted' | 'retargeted' | 'ambiguous';

export interface PublicActionFeatures {
  species: string;
  turn: number;
  publicBoard: string[];
  previouslyRevealedMoves: string[];
}

export interface ReplayAction {
  kind: 'move';
  move: string;
  target?: string;
  key: string;
}

export interface ReplayActionExample {
  replayId: string;
  turn: number;
  actor: string;
  side?: 'p1' | 'p2';
  features: PublicActionFeatures;
  labelStatus: ActionLabelStatus;
  action?: ReplayAction;
}

export interface CorpusAudit {
  schemaVersion: 1;
  generatedAt: string;
  formatFilter: {formatId: string; formatName: string; policy: 'explicit_exact_match'};
  sourceVersions: string[];
  records: {seen: number; accepted: number; duplicates: number; excluded: number};
  exclusions: Record<string, number>;
  rating: {available: number; missing: number};
  replayTurns: {minimum: number; maximum: number; median: number};
  aborted: number;
  labels: Record<ActionLabelStatus, number>;
  acceptedIds: string[];
}

export interface ContextualActionPriorArtifact {
  schemaVersion: 1;
  kind: 'empirical-contextual-action-prior';
  formatId: string;
  sourceVersion: string;
  sourceHash: string;
  createdAt: string;
  trainingExamples: number;
  smoothing: number;
  counts: {
    global: Record<string, number>;
    bySpecies: Record<string, Record<string, number>>;
    byContext: Record<string, Record<string, number>>;
  };
  metrics?: {heldout: PriorMetrics; baseline: PriorMetrics; logLossImprovement: number;speciesBaseline:PriorMetrics;speciesLogLossImprovement:number};
  adopted: boolean;
  adoptionReasons: string[];
}

export interface PriorMetrics {
  examples: number;
  logLoss: number;
  topKRecall: Record<number, number>;
  /** Ten equal-width bins of top-label confidence, weighted by bin frequency. */
  calibrationError: number;
  calibrationMethod?: 'top-label-ece-10-bins';
  vocabularySize?:number;
  unknownTargets?:number;
}

function clean(value: string | undefined): string | undefined {
  return value?.toLowerCase().replace(/[^a-z0-9]/g, '') || undefined;
}

export function isExplicitMB(record: ReplayCorpusRecord): boolean {
  const id = clean(record.formatId);
  const name = clean(record.format);
  const tier=clean(record.log.split('\n').find(line=>line.startsWith('|tier|'))?.slice(6));
  const allowed=new Set([M_B_FORMAT_ID,`${M_B_FORMAT_ID}bo3`]);
  if (!id && !name) return false;
  if(id&&!allowed.has(id))return false;
  if(tier&&!allowed.has(tier))return false;
  if(id&&tier&&id!==tier)return false;
  // HolidayOugi's format column is an umbrella category, not the battle tier.
  if(name==='gen9championsvgc2026')return Boolean(id&&tier&&id===tier);
  if(name&&!allowed.has(name))return false;
  if(name&&id&&name!==id)return false;
  if(name&&tier&&name!==tier)return false;
  return true;
}

function hashLog(log: string): string {
  return createHash('sha256').update(log.trim()).digest('hex');
}

function increment<K extends string>(counts: Record<K, number>, key: K): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function lineParts(line: string): string[] {
  return line.startsWith('|') ? line.split('|').slice(1) : [];
}

function actorSlot(value: string | undefined): string {
  return value?.split(':')[0]?.trim() ?? '';
}

function actorSide(slot: string): 'p1' | 'p2' | undefined {
  return slot.startsWith('p1') ? 'p1' : slot.startsWith('p2') ? 'p2' : undefined;
}

function displaySpecies(details: string | undefined): string | undefined {
  const species = details?.split(',')[0]?.trim();
  return species || undefined;
}

export function buildReplayExamples(record: ReplayCorpusRecord): ReplayActionExample[] {
  const examples: ReplayActionExample[] = [];
  const active = new Map<string, string>();
  const revealedMoves = new Map<string, Set<string>>();
  let decisionActive = new Map<string, string>();
  let decisionRevealedMoves = new Map<string, Set<string>>();
  let turn = 0;
  let redirectedActor: string | undefined;
  let redirectionPossible=false;
  const identity=(slot:string,species:string)=>`${actorSide(slot)}:${speciesIdentity(species)}`;

  for (const line of record.log.split(/\r?\n/)) {
    const [type, ...args] = lineParts(line);
    if (type === 'turn') {
      turn = Number(args[0]) || turn + 1;
      decisionActive = new Map(active);
      decisionRevealedMoves = new Map(
        [...revealedMoves].map(([slot, moves]) => [slot, new Set(moves)]),
      );
      redirectedActor = undefined;
      redirectionPossible=false;
      continue;
    }
    if (type === 'switch' || type === 'drag' || type === 'replace') {
      const slot = actorSlot(args[0]);
      const species = displaySpecies(args[1]);
      if (slot && species) active.set(slot, species);
      continue;
    }
    if(type==='detailschange'||type==='-formechange'){
      const slot=actorSlot(args[0]),form=displaySpecies(args[1]);if(slot&&form)active.set(slot,form);continue;
    }
    if(type==='swap'){
      const slot=actorSlot(args[0]),other=`${actorSide(slot)}${Number(args[1])===0?'a':'b'}`;
      const one=active.get(slot),two=active.get(other);
      if(one)active.set(other,one);else active.delete(other);
      if(two)active.set(slot,two);else active.delete(slot);
      continue;
    }
    if (type === 'faint') {
      active.delete(actorSlot(args[0]));
      continue;
    }
    if ((type==='-singleturn' || type==='-activate') && /follow me|rage powder|spotlight|lightning rod|storm drain/i.test(args.join(' ')))redirectionPossible=true;
    if (type === '-redirect') {
      redirectedActor = actorSlot(args[1]) || actorSlot(args[0]);
      continue;
    }
    if (type !== 'move' && type !== 'cant') continue;

    const actor = actorSlot(args[0]);
    const species = decisionActive.get(actor) ?? active.get(actor) ?? 'Unknown';
    const features: PublicActionFeatures = {
      species,
      turn,
      publicBoard: [...decisionActive.entries()]
        .filter(([slot]) => slot !== actor)
        .map(([, value]) => value)
        .sort(),
      previouslyRevealedMoves: [...(decisionRevealedMoves.get(identity(actor,species)) ?? [])].sort(),
    };
    const side = actorSide(actor);
    if (type === 'cant') {
      examples.push({replayId: record.id, turn, actor, ...(side ? {side} : {}), features, labelStatus: 'censored'});
      continue;
    }

    const move = args[1]?.trim();
    const target = actorSlot(args[2]);
    const ambiguous = !actor || !move || args.some(arg=>arg.startsWith('[from]')) || (decisionActive.has(actor) && speciesIdentity(active.get(actor)??'')!==speciesIdentity(decisionActive.get(actor)!));
    const labelStatus: ActionLabelStatus = ambiguous
      ? 'ambiguous'
      : redirectedActor === actor || (redirectionPossible && target!==actor && Boolean(target)) ? 'retargeted' : 'executed';
    const action = move ? {
      kind: 'move' as const,
      move,
      // Public execution targets can be redirected or automatically retargeted.
      // This artifact learns move identity only, never an invented command target.
      key: `move:${move}`,
    } : undefined;
    examples.push({
      replayId: record.id, turn, actor, ...(side ? {side} : {}), features, labelStatus,
      ...(action ? {action} : {}),
    });
    if (actor && move) {
      const key=identity(actor,active.get(actor)??species);
      const known = revealedMoves.get(key) ?? new Set<string>();
      known.add(move);
      revealedMoves.set(key, known);
    }
    redirectedActor = undefined;
  }
  return examples;
}

export function auditReplayRecords(records: ReplayCorpusRecord[]): CorpusAudit {
  const exclusions: Record<string, number> = {};
  const labels: Record<ActionLabelStatus, number> = {executed: 0, censored: 0, unexecuted: 0, retargeted: 0, ambiguous: 0};
  const seenHashes = new Set<string>();
  const sourceVersions = new Set<string>();
  const acceptedIds: string[] = [];
  const turns: number[] = [];
  let duplicates = 0;
  let ratingAvailable = 0;
  let aborted = 0;

  for (const record of records) {
    const version = record.source.sourceVersion ?? record.source.revision;
    if (version) sourceVersions.add(version);
    if (!record.formatId && !record.format) {
      exclusions.format_missing = (exclusions.format_missing ?? 0) + 1;
      continue;
    }
    if (!isExplicitMB(record)) {
      exclusions.format_mismatch = (exclusions.format_mismatch ?? 0) + 1;
      continue;
    }
    const duplicateKey = record.duplicateGroup ?? hashLog(record.log);
    if (seenHashes.has(duplicateKey)) {
      duplicates += 1;
      exclusions.duplicate = (exclusions.duplicate ?? 0) + 1;
      continue;
    }
    seenHashes.add(duplicateKey);
    acceptedIds.push(record.id);
    if (Number.isFinite(record.rating)) ratingAvailable += 1;
    if (!/(?:^|\n)\|(?:win\||tie(?:\||\n|$))/m.test(record.log)) aborted += 1;
    const replayTurns = [...record.log.matchAll(/(?:^|\n)\|turn\|(\d+)/g)].map(match => Number(match[1]));
    turns.push(Math.max(0, ...replayTurns));
    for (const example of buildReplayExamples(record)) increment(labels, example.labelStatus);
  }
  const orderedTurns = turns.toSorted((a, b) => a - b);
  const middle = orderedTurns.length ? orderedTurns[Math.floor((orderedTurns.length - 1) / 2)]! : 0;
  const accepted = acceptedIds.length;
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    formatFilter: {formatId: M_B_FORMAT_ID, formatName: M_B_FORMAT_NAME, policy: 'explicit_exact_match'},
    sourceVersions: [...sourceVersions].sort(),
    records: {seen: records.length, accepted, duplicates, excluded: records.length - accepted - duplicates},
    exclusions,
    rating: {available: ratingAvailable, missing: accepted - ratingAvailable},
    replayTurns: {minimum: orderedTurns[0] ?? 0, maximum: orderedTurns.at(-1) ?? 0, median: middle},
    aborted,
    labels,
    acceptedIds,
  };
}

export function splitReplayGroupsByTime(
  records: ReplayCorpusRecord[],
  ratios: {train: number; validation: number} = {train: 0.7, validation: 0.15},
): {train: ReplayCorpusRecord[]; validation: ReplayCorpusRecord[]; test: ReplayCorpusRecord[]} {
  if (ratios.train < 0 || ratios.validation < 0 || ratios.train + ratios.validation > 1) {
    throw new Error('Split ratios must be non-negative and total at most one');
  }
  const groups = new Map<string, ReplayCorpusRecord[]>();
  for (const record of records) {
    const key = record.duplicateGroup ?? hashLog(record.log);
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }
  const ordered = [...groups.values()].sort((a, b) =>
    timestamp(a[0]?.uploadTime) - timestamp(b[0]?.uploadTime));
  const trainGroups = Math.floor(ordered.length * ratios.train);
  const validationGroups = Math.floor(ordered.length * ratios.validation);
  return {
    train: ordered.slice(0, trainGroups).flat(),
    validation: ordered.slice(trainGroups, trainGroups + validationGroups).flat(),
    test: ordered.slice(trainGroups + validationGroups).flat(),
  };
}

function timestamp(value: string | undefined): number {
  const parsed = Date.parse(value ?? '');
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function contextKey(features: Pick<PublicActionFeatures, 'species' | 'turn' | 'publicBoard'>): string {
  const turnBucket = features.turn <= 2 ? 'opening' : features.turn <= 5 ? 'middle' : 'late';
  return `${features.species}|${turnBucket}|${features.publicBoard.toSorted().join(',')}`;
}

function usableExamples(examples: ReplayActionExample[]): Array<ReplayActionExample & {action: ReplayAction}> {
  return examples.filter((example): example is ReplayActionExample & {action: ReplayAction} =>
    example.labelStatus === 'executed' && example.action !== undefined);
}

function addCount(counts: Record<string, number>, key: string): void {
  counts[key] = (Object.hasOwn(counts,key) ? counts[key]! : 0) + 1;
}

function countRecord():Record<string,number> {return Object.create(null) as Record<string,number>;}

export function trainContextualActionPrior(
  examples: ReplayActionExample[],
  options: {sourceVersion: string; sourceHash?: string; heldout?: ReplayActionExample[]; minimumTrainingExamples?: number; minimumHeldoutExamples?: number; minimumLogLossImprovement?: number; smoothing?: number},
): ContextualActionPriorArtifact {
  const training = usableExamples(examples);
  const global = countRecord();
  const bySpecies: Record<string, Record<string, number>> = Object.create(null) as Record<string, Record<string, number>>;
  const byContext: Record<string, Record<string, number>> = Object.create(null) as Record<string, Record<string, number>>;
  for (const example of training) {
    addCount(global, example.action.key);
    const species = Object.hasOwn(bySpecies,example.features.species) ? bySpecies[example.features.species]! : countRecord();
    addCount(species, example.action.key);
    bySpecies[example.features.species] = species;
    const key = contextKey(example.features);
    const context = Object.hasOwn(byContext,key) ? byContext[key]! : countRecord();
    addCount(context, example.action.key);
    byContext[key] = context;
  }
  const artifact: ContextualActionPriorArtifact = {
    schemaVersion: 1,
    kind: 'empirical-contextual-action-prior',
    formatId: M_B_FORMAT_ID,
    sourceVersion: options.sourceVersion,
    sourceHash: options.sourceHash ?? createHash('sha256').update(options.sourceVersion).digest('hex'),
    createdAt: new Date().toISOString(),
    trainingExamples: training.length,
    smoothing: options.smoothing ?? 0.5,
    counts: {global, bySpecies, byContext},
    adopted: false,
    adoptionReasons: [],
  };
  const minimum = options.minimumTrainingExamples ?? 500;
  if (training.length < minimum) artifact.adoptionReasons.push('insufficient_training_examples');
  if (options.heldout) {
    const heldout = evaluateActionPrior(options.heldout, artifact);
    const baselineArtifact = {...artifact, counts: {global, bySpecies: {}, byContext: {}}};
    const baseline = evaluateActionPrior(options.heldout, baselineArtifact);
    const speciesBaseline=evaluateActionPrior(options.heldout,{...artifact,counts:{...artifact.counts,byContext:{}}});
    const improvement = baseline.logLoss - heldout.logLoss;
    const speciesImprovement=speciesBaseline.logLoss-heldout.logLoss;
    artifact.metrics = {heldout, baseline, logLossImprovement: improvement,speciesBaseline,speciesLogLossImprovement:speciesImprovement};
    if (heldout.examples < (options.minimumHeldoutExamples ?? 50)) {
      artifact.adoptionReasons.push('insufficient_heldout_examples');
    }
    if (improvement < (options.minimumLogLossImprovement ?? 0.01)) {
      artifact.adoptionReasons.push('no_heldout_logloss_improvement');
    }
    if(speciesImprovement<(options.minimumLogLossImprovement??0.01))artifact.adoptionReasons.push('no_heldout_species_logloss_improvement');
  } else {
    artifact.adoptionReasons.push('heldout_evaluation_missing');
  }
  artifact.adopted = artifact.adoptionReasons.length === 0;
  return artifact;
}

/** Validate adoption evidence again when loading an artifact from disk. */
export function isActionPriorAdoptable(
  value: unknown,
  options: {minimumTrainingExamples?: number; minimumHeldoutExamples?: number; minimumLogLossImprovement?: number} = {},
): value is ContextualActionPriorArtifact {
  if (!plainRecord(value)) return false;
  const artifact = value;
  const minimum = options.minimumTrainingExamples ?? 500;
  const minimumHeldout = options.minimumHeldoutExamples ?? 50;
  const improvement = options.minimumLogLossImprovement ?? 0.01;
  if (artifact.schemaVersion !== 1
    || artifact.kind !== 'empirical-contextual-action-prior'
    || artifact.formatId !== M_B_FORMAT_ID
    || typeof artifact.sourceVersion !== 'string'
    || artifact.sourceVersion.length === 0
    || typeof artifact.sourceHash !== 'string'
    || !/^[a-f0-9]{64}$/.test(artifact.sourceHash)
    || !Number.isInteger(artifact.trainingExamples)
    || (artifact.trainingExamples as number) < minimum
    || typeof artifact.smoothing !== 'number'
    || !Number.isFinite(artifact.smoothing)
    || artifact.smoothing <= 0
    || artifact.adopted !== true
    || !Array.isArray(artifact.adoptionReasons)
    || artifact.adoptionReasons.length !== 0
    || !validCounts(artifact.counts)
    || !plainRecord(artifact.metrics)) return false;
  const heldout=artifact.metrics.heldout;
  const baseline=artifact.metrics.baseline;
  const recorded=artifact.metrics.logLossImprovement;
  if(!validMetrics(heldout,minimumHeldout)||!validMetrics(baseline,minimumHeldout)
    ||typeof recorded!=='number'||!Number.isFinite(recorded))return false;
  const actual=baseline.logLoss-heldout.logLoss;
  const speciesBaseline=artifact.metrics.speciesBaseline,speciesRecorded=artifact.metrics.speciesLogLossImprovement;
  if(!validMetrics(speciesBaseline,minimumHeldout)||typeof speciesRecorded!=='number'||!Number.isFinite(speciesRecorded)||speciesBaseline.examples!==heldout.examples||baseline.examples!==heldout.examples)return false;
  const speciesActual=speciesBaseline.logLoss-heldout.logLoss;
  return actual>=improvement&&recorded>=improvement&&Math.abs(actual-recorded)<=1e-9&&speciesActual>=improvement&&speciesRecorded>=improvement&&Math.abs(speciesActual-speciesRecorded)<=1e-9;
}

function plainRecord(value:unknown):value is Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const prototype=Object.getPrototypeOf(value) as unknown;
  return prototype===Object.prototype||prototype===null;
}

function finiteProbability(value:unknown):value is number {
  return typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1;
}

function validMetrics(value:unknown,minimumExamples:number):value is PriorMetrics {
  if(!plainRecord(value)||!Number.isInteger(value.examples)||(value.examples as number)<minimumExamples
    ||typeof value.logLoss!=='number'||!Number.isFinite(value.logLoss)||value.logLoss<0
    ||!finiteProbability(value.calibrationError)||!plainRecord(value.topKRecall))return false;
  return Object.values(value.topKRecall).every(finiteProbability);
}

function validCountRecord(value:unknown):value is Record<string,number> {
  return plainRecord(value)&&Object.values(value).every(count=>typeof count==='number'&&Number.isFinite(count)&&count>=0);
}

function validNestedCounts(value:unknown):value is Record<string,Record<string,number>> {
  return plainRecord(value)&&Object.values(value).every(validCountRecord);
}

function validCounts(value:unknown):value is ContextualActionPriorArtifact['counts'] {
  if(!plainRecord(value)||!validCountRecord(value.global)||!Object.keys(value.global).length)return false;
  return validNestedCounts(value.bySpecies)&&validNestedCounts(value.byContext);
}

export function contextualActionWeights(
  artifact: ContextualActionPriorArtifact | undefined,
  context: Pick<PublicActionFeatures, 'species' | 'turn' | 'publicBoard'>,
  legalActions: string[],
): Record<string, number> {
  if (!legalActions.length) return {};
  const contextual=artifact?.counts.byContext;
  const species=artifact?.counts.bySpecies;
  const key=contextKey(context);
  const counts = contextual&&Object.hasOwn(contextual,key) ? contextual[key]!
    : species&&Object.hasOwn(species,context.species) ? species[context.species]!
    : artifact?.counts.global ?? {};
  const smoothing = artifact?.smoothing ?? 1;
  const countFor = (action: string): number => {
    if (Object.hasOwn(counts,action)) return counts[action]!;
    const parts = action.split(':');
    const base=parts.length > 2 ? parts.slice(0, 2).join(':') : action;
    return Object.hasOwn(counts,base) ? counts[base]! : 0;
  };
  const total = legalActions.reduce((sum, action) => sum + countFor(action) + smoothing, 0);
  return Object.fromEntries(legalActions.map(action => [action, (countFor(action) + smoothing) / total]));
}

export const UNKNOWN_ACTION='__UNK__';
export function evaluateActionPrior(examples: ReplayActionExample[], artifact: ContextualActionPriorArtifact): PriorMetrics {
  const usable = usableExamples(examples);
  const vocabulary = [...Object.keys(artifact.counts.global).filter(key=>key!==UNKNOWN_ACTION).sort(),UNKNOWN_ACTION];
  const known=new Set(vocabulary);
  if (!usable.length) return {examples: 0, logLoss: 0, topKRecall: {1: 0, 3: 0}, calibrationError: 0,calibrationMethod:'top-label-ece-10-bins',vocabularySize:vocabulary.length,unknownTargets:0};
  let loss = 0,top1 = 0,top3 = 0,unknownTargets=0;
  const bins=Array.from({length:10},()=>({count:0,confidence:0,correct:0}));
  for (const example of usable) {
    const target=known.has(example.action.key)?example.action.key:UNKNOWN_ACTION;
    if(target===UNKNOWN_ACTION)unknownTargets++;
    const weights = contextualActionWeights(artifact, example.features, vocabulary);
    loss -= Math.log(Math.max(weights[target] ?? 0, 1e-12));
    const ranked = vocabulary.toSorted((a, b) => (weights[b] ?? 0) - (weights[a] ?? 0) || a.localeCompare(b));
    const correct=ranked[0]===target?1:0;
    top1+=correct;
    if (ranked.slice(0, 3).includes(target)) top3 += 1;
    const confidence=weights[ranked[0]!]??0;
    const bin=bins[Math.min(9,Math.floor(confidence*10))]!;
    bin.count++;bin.confidence+=confidence;bin.correct+=correct;
  }
  return {
    examples: usable.length,logLoss: loss / usable.length,
    topKRecall: {1: top1 / usable.length, 3: top3 / usable.length},
    calibrationError:bins.reduce((sum,bin)=>sum+Math.abs(bin.correct-bin.confidence),0)/usable.length,
    calibrationMethod:'top-label-ece-10-bins',vocabularySize:vocabulary.length,unknownTargets,
  };
}
