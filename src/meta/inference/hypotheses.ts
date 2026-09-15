import {Generations, toID} from '@smogon/calc';

import type {
  MetaTeam,
  MetaUsageRow,
  OpponentSetHypothesis,
  PokemonBattleState,
  PokemonSet,
  SourceReference,
  Stats,
} from '../../domain/contracts.js';
import {sha256} from '../../util/hash.js';

const champions = Generations.get(0);

function normalize(value?: string): string {
  return value ? toID(value) : '';
}

function normalizeSpecies(value?: string): string {
  return normalize(value)
    .replace(/mega(?:x|y|z)?$/, '')
    .replace(/eternalmega$/, 'eternal');
}

function signature(set: PokemonSet): string {
  return [
    normalize(set.species),
    normalize(set.item),
    normalize(set.ability),
    normalize(set.nature),
    set.moves.map(normalize).sort().join(','),
    JSON.stringify(set.skillPoints),
  ].join('|');
}

function sourceFromTeam(team: MetaTeam): SourceReference {
  return {
    ...team.source,
    ...(team.sourceUrl ? {url: team.sourceUrl} : {}),
  };
}

function confidenceForSet(
  set: PokemonSet,
  observed: PokemonBattleState,
): {compatible: boolean; score: number; reasons: string[]} {
  let score = 1;
  const reasons: string[] = [];

  const observedItem = observed.revealedItem ?? observed.item;
  if (observedItem && set.item) {
    if (normalize(set.item) !== normalize(observedItem)) {
      return {
        compatible: false,
        score: 0,
        reasons: [`revealed item ${observedItem} conflicts with ${set.item ?? 'no item'}`],
      };
    }
    score += 4;
    reasons.push(`matches revealed item ${observedItem}`);
  }

  if (observed.ability && set.ability) {
    if (normalize(set.ability) !== normalize(observed.ability)) {
      return {
        compatible: false,
        score: 0,
        reasons: [
          `revealed ability ${observed.ability} conflicts with ${set.ability ?? 'unknown ability'}`,
        ],
      };
    }
    score += 4;
    reasons.push(`matches revealed ability ${observed.ability}`);
  }

  for (const move of observed.moves) {
    if (!set.moves.some((candidate) => normalize(candidate) === normalize(move))) {
      if (set.moves.length < 4) {
        reasons.push(`published move list is incomplete; ${move} remains possible`);
        continue;
      }
      return {
        compatible: false,
        score: 0,
        reasons: [`revealed move ${move} is absent from this set`],
      };
    }
    score += 2;
    reasons.push(`matches revealed move ${move}`);
  }

  if (reasons.length === 0) reasons.push('compatible with currently revealed information');
  return {compatible: true, score, reasons};
}

export function buildOpponentHypotheses(
  observed: PokemonBattleState,
  metaTeams: MetaTeam[],
): OpponentSetHypothesis[] {
  const candidates = new Map<string, {set: PokemonSet; source: SourceReference; prior: number}>();
  const species = normalizeSpecies(observed.species ?? observed.nickname);

  for (const team of metaTeams) {
    for (const set of team.pokemon) {
      if (normalizeSpecies(set.species) !== species) continue;
      const key = signature(set);
      const current = candidates.get(key);
      if (current) current.prior += team.exactSets ? 2 : 1;
      else {
        candidates.set(key, {
          set,
          source: sourceFromTeam(team),
          prior: team.exactSets ? 2 : 1,
        });
      }
    }
  }

  const scored = [...candidates.entries()].map(([key, candidate]) => {
    const evidence = confidenceForSet(candidate.set, observed);
    return {
      id: `hyp_${sha256(key).slice(0, 16)}`,
      set: candidate.set,
      compatible: evidence.compatible,
      rawScore: evidence.compatible ? evidence.score * candidate.prior : 0,
      reasons: [...evidence.reasons,
        ...(Object.values(candidate.set.provenance ?? {}).some(field => field?.knowledge !== 'known')
          ? ['Some fields are inferred or unknown; confidence is a heuristic, not a probability.'] : []),
        ...(Object.values(candidate.set.provenance ?? {}).some(field => field?.source.includes('marginal'))
          ? ['Usage marginals form a hypothetical combination, not an observed published set.'] : []),
      ],
      source: candidate.source,
    };
  });
  const total = scored.reduce((sum, candidate) => sum + candidate.rawScore, 0);
  const evidenceSignals =
    (observed.revealedItem ?? observed.item ? 1 : 0) +
    (observed.ability ? 1 : 0) +
    observed.moves.length;
  const absoluteCap = Math.min(0.93, 0.45 + evidenceSignals * 0.12);

  return scored
    .map(({rawScore, ...candidate}) => ({
      ...candidate,
      confidence:
        total > 0 ? Math.min(rawScore / total, absoluteCap) : 0,
    }))
    .sort((left, right) => right.confidence - left.confidence);
}

function top(rows: MetaUsageRow[], category: string): MetaUsageRow | undefined {
  const normalized = category.replace(/[^a-z]/g, '');
  return rows
    .filter(
      (row) =>
        row.category.toLowerCase().replace(/[^a-z]/g, '') === normalized,
    )
    .sort(
      (left, right) =>
        right.percentage - left.percentage || left.rank - right.rank,
    )[0];
}

function parseSpread(value?: string): Stats {
  if (!value) return {};
  const labels: Record<string, keyof Stats> = {
    hp: 'hp',
    atk: 'atk',
    attack: 'atk',
    def: 'def',
    defense: 'def',
    spa: 'spa',
    spatk: 'spa',
    spattack: 'spa',
    spd: 'spd',
    spdef: 'spd',
    spdefense: 'spd',
    spe: 'spe',
    speed: 'spe',
  };
  const spread: Stats = {};
  for (const part of value.split(/\s*[/,]\s*/)) {
    const first = /(\d+)\s*([A-Za-z. ]+)/.exec(part);
    const second = /([A-Za-z. ]+)\s*[:=]\s*(\d+)/.exec(part);
    const amount = Number(first?.[1] ?? second?.[2]);
    const label = (first?.[2] ?? second?.[1] ?? '')
      .toLowerCase()
      .replace(/[^a-z]/g, '');
    const stat = labels[label];
    if (stat && Number.isFinite(amount)) spread[stat] = amount;
  }
  return spread;
}

export function synthesizeUsageSet(
  species: string,
  usageRows: MetaUsageRow[],
  level = 50,
): PokemonSet {
  const eligibleRows = usageRows.filter(
    (row) => row.source.regulationVerified !== false &&
      (row.source.provider !== 'champions-battle-data' || row.source.regulationVerified === true) &&
      normalizeSpecies(row.pokemon) === normalizeSpecies(species),
  );
  // Older caches may contain many daily snapshots. Keep one whole snapshot so
  // an absent field in the newest data is not filled from an unrelated day.
  const sourceKey = (row: MetaUsageRow) => JSON.stringify([
    row.source.sourceDate, row.source.retrievedAt, row.source.url,
    row.source.contentHash, row.source.sourceVersion,
  ]);
  const latest = [...eligibleRows].sort((a, b) =>
    (b.source.sourceDate ?? b.source.retrievedAt).localeCompare(a.source.sourceDate ?? a.source.retrievedAt) ||
    sourceKey(a).localeCompare(sourceKey(b)))[0];
  const rows = latest ? eligibleRows.filter(row => sourceKey(row) === sourceKey(latest)) : [];
  const moves = rows
    .filter(
      (row) => row.category.toLowerCase().replace(/[^a-z]/g, '') === 'move',
    )
    .sort(
      (left, right) =>
        right.percentage - left.percentage || left.rank - right.rank,
    )
    .slice(0, 4)
    .map((row) => row.name)
    .filter((move) => champions.moves.get(toID(move)));
  const item = top(rows, 'item')?.name;
  const ability = top(rows, 'ability')?.name;
  const natureRow = top(rows, 'nature');
  const nature = natureRow?.name ?? 'Serious';
  const spread =
    top(rows, 'spread')?.name ??
    top(rows, 'statspread')?.name ??
    top(rows, 'stats')?.name;

  return {
    species,
    ...(item ? {item} : {}),
    ...(ability ? {ability} : {}),
    nature,
    moves,
    skillPoints: parseSpread(spread),
    ivs: {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31},
    level,
    provenance: {
      species: {knowledge: 'known', confidence: 1, source: 'team-roster'},
      item: {
        knowledge: item ? 'inferred' : 'unknown',
        confidence: item ? 0.6 : 0,
        source: 'champions-battle-data marginal synthesis; not an observed set',
      },
      ability: {
        knowledge: ability ? 'inferred' : 'unknown',
        confidence: ability ? 0.6 : 0,
        source: 'champions-battle-data marginal synthesis; not an observed set',
      },
      nature: {
        knowledge: natureRow ? 'inferred' : 'unknown',
        confidence: natureRow ? 0.5 : 0,
        source: natureRow ? 'champions-battle-data marginal synthesis; not an observed set' : 'neutral nature assumption; no published nature',
      },
      moves: {
        knowledge: moves.length ? 'inferred' : 'unknown',
        confidence: moves.length ? 0.5 : 0,
        source: 'champions-battle-data marginal synthesis; not an observed set',
      },
      skillPoints: {
        knowledge: spread ? 'inferred' : 'unknown',
        confidence: spread ? 0.4 : 0,
        source: spread ? 'champions-battle-data marginal synthesis; not an observed set' : 'zero investment assumption; no published spread',
      },
    },
  };
}

export function hydrateMetaTeam(
  team: MetaTeam,
  usageRows: MetaUsageRow[],
  level = 50,
): MetaTeam {
  const existing = new Map(
    team.pokemon.map((set) => [normalizeSpecies(set.species), set]),
  );
  const regulationUsage = usageRows.filter(row => !row.source.regulationId || row.source.regulationId === team.regulationId);
  const pokemon = team.roster.map(
    (species) =>
      existing.get(normalizeSpecies(species)) ??
      synthesizeUsageSet(species, regulationUsage, level),
  );
  return {...team, pokemon, exactSets: team.exactSets && team.roster.every(species => existing.has(normalizeSpecies(species)))};
}
