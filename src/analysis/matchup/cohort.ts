import {Generations, toID} from '@smogon/calc';
import {STAT_IDS, type MetaTeam, type PokemonSet, type SourceReference, type Stats} from '../../domain/contracts.js';

export interface CohortPriorityCoverage {
  threat: string;
  status: 'tested' | 'omitted';
  reason?: 'missing-source' | 'budget';
  availableTeamIds: string[];
  selectedTeamIds: string[];
}

export interface CohortCoverage {
  availableTeams: number;
  uniqueCandidates: number;
  selectedTeams: number;
  maximum: number;
  testedPriorityThreats: string[];
  omittedPriorityThreats: Array<{threat: string; reason: 'missing-source' | 'budget'}>;
  priorities: CohortPriorityCoverage[];
  selections: Array<{teamId: string; reasons: string[]; source: SourceReference}>;
  diversity: {
    species: {available: string[]; selected: string[]};
    weather: {available: string[]; selected: string[]};
    control: {available: string[]; selected: string[]};
    publishedSpreadVariants: {available: number; selected: number};
  };
  limitations: string[];
}

interface Candidate {team: MetaTeam; features: Set<string>; aliases: Set<string>}
const champions = Generations.get(0);
const id = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '');
const base = (value: string): string => id(value).replace(/mega(?:x|y)?$/, '');
const controlMoves = new Set(['tailwind', 'trickroom', 'fakeout', 'followme', 'ragepowder', 'wideguard',
  'encore', 'taunt', 'icywind', 'electroweb', 'thunderwave', 'haze', 'quash']);
const weatherEffects: Record<string, string> = {drizzle: 'rain', raindance: 'rain', drought: 'sun', sunnyday: 'sun',
  sandstream: 'sand', sandstorm: 'sand', snowwarning: 'snow', snowscape: 'snow'};

function setAliases(set: PokemonSet): string[] {
  const aliases = [id(set.species), base(set.species)];
  const publishedItem = !['unknown', 'inferred'].includes(set.provenance?.item?.knowledge ?? '');
  const item = set.item && publishedItem ? champions.items.get(toID(set.item)) : undefined;
  for (const [original, mega] of Object.entries(item?.megaStone ?? {})) {
    if (base(set.species) === id(original)) aliases.push(id(mega));
  }
  return aliases;
}

function statsKey(stats: Stats): string {
  // Missing information is distinct from an explicitly published zero.
  return STAT_IDS.map(stat => `${stat}:${stats[stat] ?? '?'}`).join(',');
}

function setKey(set: PokemonSet): string {
  return JSON.stringify([id(set.species), id(set.item ?? ''), id(set.ability ?? ''), id(set.nature ?? ''),
    set.moves.map(id).sort(), statsKey(set.skillPoints), statsKey(set.ivs), set.level,
    // Equal numbers do not make a synthesized hypothesis the same evidence as a
    // published set. Retain distinct knowledge states, while deduplicating true
    // replicas regardless of their provider URL or retrieval time.
    (['species', 'item', 'ability', 'nature', 'moves', 'skillPoints'] as const)
      .map(field => set.provenance?.[field]?.knowledge ?? 'unspecified')]);
}

function teamKey(team: MetaTeam): string {
  return JSON.stringify([team.roster.map(id).sort(), team.pokemon.map(setKey).sort(), team.exactSets]);
}

function date(value?: string): number {
  const time = value ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : 0;
}

function placement(value?: string): number {
  if (!value) return Number.MAX_SAFE_INTEGER;
  if (/^(?:champion|winner)$/i.test(value.trim())) return 1;
  if (/runner/i.test(value)) return 2;
  return Number(value.match(/\d+/)?.[0] ?? Number.MAX_SAFE_INTEGER);
}

function features(team: MetaTeam): Set<string> {
  const result = new Set(team.roster.map(species => `species:${id(species)}`));
  for (const set of team.pokemon) {
    result.add(`species:${id(set.species)}`);
    const aliases = setAliases(set);
    for (const alias of aliases.filter(alias => alias.includes('mega'))) result.add(`species:${alias}`);
    // These are published capabilities, not claims that control or weather executes.
    const knownMoves = set.provenance?.moves?.knowledge !== 'unknown' && set.provenance?.moves?.knowledge !== 'inferred';
    const knownAbility = set.provenance?.ability?.knowledge !== 'unknown' && set.provenance?.ability?.knowledge !== 'inferred';
    for (const effect of [...(knownMoves ? set.moves.map(id) : []), ...(knownAbility ? [id(set.ability ?? '')] : [])]) {
      if (weatherEffects[effect]) result.add(`weather:${weatherEffects[effect]}`);
      if (controlMoves.has(effect)) result.add(`control:${effect}`);
    }
    if (aliases.includes('charizardmegay')) result.add('weather:sun');
    if ((team.exactSets || set.provenance?.skillPoints?.knowledge === 'known') &&
        !['unknown', 'inferred'].includes(set.provenance?.skillPoints?.knowledge ?? '') &&
        Object.keys(set.skillPoints).length > 0) {
      result.add(`spread:${base(set.species)}:${id(set.nature ?? '')}:${statsKey(set.skillPoints)}:${statsKey(set.ivs)}`);
    }
  }
  return result;
}

/** Select a reproducible evidence sample. Frequency and ladder usage never supply weights. */
export function teamMatchesThreat(team:MetaTeam, threat:string): boolean {
  return new Set([...team.roster.flatMap(species=>[id(species),base(species)]),...team.pokemon.flatMap(setAliases)]).has(id(threat));
}

export function selectCohort(teams: MetaTeam[], maximum: number, priorityThreats: string[] = []): {teams: MetaTeam[]; coverage: CohortCoverage} {
  const cap = Number.isFinite(maximum) ? Math.max(0, Math.floor(maximum)) : 0;
  const ordered = [...teams].sort((a, b) => date(b.date ?? b.source.sourceDate) - date(a.date ?? a.source.sourceDate) ||
    placement(a.placement) - placement(b.placement) || a.id.localeCompare(b.id) || teamKey(a).localeCompare(teamKey(b)));
  const distinct = new Map<string, MetaTeam>();
  for (const team of ordered) if (!distinct.has(teamKey(team))) distinct.set(teamKey(team), team);
  const candidates: Candidate[] = [...distinct.values()].map(team => ({team, features: features(team),
    aliases: new Set([...team.roster.flatMap(species => [id(species), base(species)]), ...team.pokemon.flatMap(setAliases)])}));
  const priorities = [...new Map(priorityThreats.filter(threat => threat.trim()).map(threat => [id(threat), threat.trim()])).values()];
  const selected: Candidate[] = [];
  const covered = new Set<string>();
  const selections: CohortCoverage['selections'] = [];
  const add = (candidate: Candidate, reasons: string[]): void => {
    selected.push(candidate);
    for (const feature of candidate.features) covered.add(feature);
    selections.push({teamId: candidate.team.id, reasons, source: candidate.team.source});
  };
  const matches = (candidate: Candidate, threat: string): boolean => candidate.aliases.has(id(threat));

  // Greedy set cover serves the largest number of requested threats per slot; source recency breaks ties.
  while (selected.length < cap) {
    const untested = priorities.filter(threat => !selected.some(candidate => matches(candidate, threat)));
    const remaining = candidates.filter(candidate => !selected.includes(candidate));
    const ranked = remaining.map(candidate => ({candidate, threats: untested.filter(threat => matches(candidate, threat))}))
      .sort((a, b) => b.threats.length - a.threats.length);
    if (!ranked[0]?.threats.length) break;
    add(ranked[0].candidate, ranked[0].threats.map(threat => `Priority threat: ${threat}`));
  }

  // Retain approximately a quarter of the budget from the most recent source evidence, when priorities leave room.
  const recentQuota = Math.max(1, Math.floor(cap / 4));
  for (const candidate of candidates.slice(0, recentQuota)) {
    if (selected.length >= cap) break;
    if (!selected.includes(candidate)) add(candidate, ['Recent published team; date, then placement, then stable ID']);
  }
  while (selected.length < cap) {
    const remaining = candidates.filter(candidate => !selected.includes(candidate));
    const ranked = remaining.map(candidate => {
      const novel = [...candidate.features].filter(feature => !covered.has(feature));
      const score = novel.reduce((sum, feature) => sum + (/^(weather|control):/.test(feature) ? 4 : feature.startsWith('species:') ? 2 : 1), 0);
      return {candidate, novel, score};
    }).sort((a, b) => b.score - a.score);
    const next = ranked[0];
    if (!next) break;
    add(next.candidate, next.novel.length ? next.novel.map(feature => `Additional source coverage: ${feature}`) : ['Recent distinct published set evidence']);
  }

  const priorityCoverage: CohortPriorityCoverage[] = priorities.map(threat => {
    const availableTeamIds = ordered.filter(team => matches({team, features: new Set(), aliases: new Set([
      ...team.roster.flatMap(species => [id(species), base(species)]), ...team.pokemon.flatMap(setAliases),
    ])}, threat)).map(team => team.id);
    const selectedTeamIds = selected.filter(candidate => matches(candidate, threat)).map(candidate => candidate.team.id);
    return {threat, status: selectedTeamIds.length ? 'tested' : 'omitted',
      ...(selectedTeamIds.length ? {} : {reason: availableTeamIds.length ? 'budget' as const : 'missing-source' as const}),
      availableTeamIds, selectedTeamIds};
  });
  const availableFeatures = new Set(candidates.flatMap(candidate => [...candidate.features]));
  const labels = (values: Set<string>, prefix: string): string[] => [...values].filter(value => value.startsWith(prefix)).map(value => value.slice(prefix.length)).sort();
  const category = (prefix: string): {available: string[]; selected: string[]} => ({available: labels(availableFeatures, prefix), selected: labels(covered, prefix)});
  return {teams: selected.map(candidate => candidate.team), coverage: {
    availableTeams: teams.length, uniqueCandidates: candidates.length, selectedTeams: selected.length, maximum: cap,
    testedPriorityThreats: priorityCoverage.filter(entry => entry.status === 'tested').map(entry => entry.threat),
    omittedPriorityThreats: priorityCoverage.flatMap(entry => entry.reason ? [{threat: entry.threat, reason: entry.reason}] : []),
    priorities: priorityCoverage, selections,
    diversity: {species: category('species:'), weather: category('weather:'), control: category('control:'),
      publishedSpreadVariants: {available: labels(availableFeatures, 'spread:').length, selected: labels(covered, 'spread:').length}},
    limitations: ['Coverage describes the supplied source teams, not metagame frequency or win probability.',
      'Numerically identical published and inferred sets remain distinct evidence candidates; deduplication preserves field knowledge and exact-set status.',
      'Weather and control labels describe set capabilities; successful execution is not assumed.',
      'Priority coverage means the species or explicit Mega option is represented in the cohort; it does not guarantee every lead, bring-four, or spread scenario was simulated.',
      ...(selected.length < candidates.length ? ['The cohort budget omits some distinct published teams or sets.'] : [])],
  }};
}
