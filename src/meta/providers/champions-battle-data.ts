import {parse as parseCsv} from 'csv-parse/sync';
import {z} from 'zod';

import type {MetaUsageRow, SourceReference} from '../../domain/contracts.js';
import {VgcError} from '../../errors.js';
import type {RegulationProfile} from '../../regulation/profile.js';
import {sha256} from '../../util/hash.js';
import {fetchText, mapBounded, normalizeIdentifier} from './http.js';
import type {
  ChampionsBattleDataResult,
  FetchOptions,
  ProviderSnapshot,
} from './types.js';

const PROVIDER = 'champions-battle-data';

const csvSourceSchema = z.object({
  season: z.string().min(1),
  format: z.string().min(1),
  path: z.string().min(1),
  date: z.string().min(1).optional(),
  daily: z.boolean().optional(),
});

const pokemonIndexSchema = z.object({
  generatedAt: z.string().min(1),
  dataVersion: z.union([z.string(), z.number()]).transform(String),
  defaultSeason: z.string().min(1).optional(),
  pokemon: z.array(
    z.object({
      name: z.string().min(1),
      showdownId: z.string().min(1),
      battleDataCsvs: z.array(csvSourceSchema),
    }),
  ),
});

const csvRowSchema = z.object({
  pokemon: z.string().min(1),
  category: z.string().min(1),
  rank: z.coerce.number().int().positive(),
  name: z.string(),
  percentage: z.string(),
  hp_points: z.string().optional(),
  attack_points: z.string().optional(),
  defense_points: z.string().optional(),
  sp_atk_points: z.string().optional(),
  sp_def_points: z.string().optional(),
  speed_points: z.string().optional(),
});

export interface ChampionsRequest {
  baseUrl: string;
  regulationId: string;
  pokemon: readonly string[];
  format?: 'Doubles';
  season?: string;
  days?: number;
  requireBinding?: boolean;
  allowMissing?: boolean;
  binding?: {regulationId: string; season: string; validFrom: string; validTo: string};
}

interface CsvSelection {
  pokemon: string;
  showdownId: string;
  path: string;
  sourceDate?: string;
  season: string;
  format: string;
  requestedPokemon: string[];
}

type PokemonIndexEntry = z.infer<typeof pokemonIndexSchema>['pokemon'][number];

// The provider documents daily folder dates as DD_MM_YYYY, not sortable text.
function sourceDate(value: string): string {
  const folder = /^(\d{2})_(\d{2})_(\d{4})$/.exec(value);
  const iso = folder ? `${folder[3]}-${folder[2]}-${folder[1]}` : value.slice(0, 10);
  const timestamp = Date.parse(`${iso}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || !Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== iso) {
    throw new VgcError('SOURCE_SCHEMA_CHANGED', `Invalid source date: ${value}`);
  }
  return iso;
}

function validateBinding(request: ChampionsRequest): void {
  const binding = request.binding;
  if (request.requireBinding && !binding) {
    throw new VgcError('CONFIGURATION_ERROR', 'An explicit usage season and regulation date binding is required');
  }
  if (!binding) return;
  if (binding.regulationId !== request.regulationId || binding.season !== request.season ||
      sourceDate(binding.validFrom) > sourceDate(binding.validTo)) {
    throw new VgcError('CONFIGURATION_ERROR', 'Usage source binding does not match this regulation and season');
  }
}

function parsePercentage(value: string, category: string): number {
  const trimmed = value.trim();
  if (!trimmed && category === 'teammate') return 0;
  if (!/^(?:100(?:\.0+)?|\d{1,2}(?:\.\d+)?)%$/.test(trimmed)) {
    throw new VgcError(
      'SOURCE_SCHEMA_CHANGED',
      `Invalid Champions Battle Data percentage: ${value}`,
    );
  }
  return Number(trimmed.slice(0, -1));
}

function spreadName(row: z.infer<typeof csvRowSchema>): string {
  const values = [
    ['HP', row.hp_points],
    ['Atk', row.attack_points],
    ['Def', row.defense_points],
    ['SpA', row.sp_atk_points],
    ['SpD', row.sp_def_points],
    ['Spe', row.speed_points],
  ] as const;
  const present = values.filter((entry) => entry[1]?.trim());
  if (present.length !== 6) {
    throw new VgcError(
      'SOURCE_SCHEMA_CHANGED',
      'Champions Battle Data spread row is incomplete',
      {pokemon: row.pokemon, rank: row.rank},
    );
  }
  const amounts = present.map(([, value]) => Number(value));
  if (amounts.some(value => !Number.isInteger(value) || value < 0 || value > 32) ||
      amounts.reduce((sum, value) => sum + value, 0) > 66) {
    throw new VgcError('SOURCE_SCHEMA_CHANGED', 'Champions Battle Data spread exceeds skill-point limits', {pokemon: row.pokemon, rank: row.rank});
  }
  return present.map(([stat, value]) => `${value} ${stat}`).join(' / ');
}

function mapCategory(category: string): string {
  switch (category) {
    case 'held_item':
      return 'item';
    case 'stat_alignment':
      return 'nature';
    case 'stat_points':
      return 'spread';
    default:
      return category;
  }
}

function parseRows(csv: string, source: SourceReference): MetaUsageRow[] {
  let records: unknown;
  try {
    records = parseCsv(csv, {
      bom: true,
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });
  } catch (error) {
    throw new VgcError(
      'SOURCE_SCHEMA_CHANGED',
      'Champions Battle Data returned malformed CSV',
      undefined,
      {cause: error},
    );
  }
  const parsed = z.array(csvRowSchema).min(1).safeParse(records);
  if (!parsed.success) {
    throw new VgcError(
      'SOURCE_SCHEMA_CHANGED',
      'Champions Battle Data CSV schema changed',
      {issues: parsed.error.issues.slice(0, 5)},
      {cause: parsed.error},
    );
  }
  return parsed.data.map((row) => {
    const category = mapCategory(row.category);
    const name = category === 'spread' ? spreadName(row) : row.name.trim();
    if (!name) {
      throw new VgcError(
        'SOURCE_SCHEMA_CHANGED',
        'Champions Battle Data row has no name',
        {pokemon: row.pokemon, category, rank: row.rank},
      );
    }
    return {
      pokemon: row.pokemon,
      category,
      name,
      rank: row.rank,
      percentage: parsePercentage(row.percentage, row.category),
      source,
    };
  });
}

function requestFromProfile(
  profile: RegulationProfile,
  pokemon: readonly string[],
): ChampionsRequest {
  const source = profile.sources.championsBattleData;
  return {
    baseUrl: source.baseUrl,
    regulationId: profile.id,
    pokemon,
    format: source.format,
    season: source.season,
    days: source.days,
    ...(source.binding ? {binding: source.binding} : {}),
  };
}

function resolveIndexEntry(
  entries: PokemonIndexEntry[],
  requested: string,
): PokemonIndexEntry | undefined {
  const normalized = normalizeIdentifier(requested);
  const aliases = new Set([
    normalized,
    normalized.replace(/mega(?:x|y|z)?$/, ''),
  ]);
  // Cosmetic forms share battle characteristics in the pinned calculator.
  // These exact source names were checked against the live index on 2026-09-04.
  // Do not generalize this to regional forms or Floette's distinct stat forms.
  const cosmeticUsageAliases: Record<string, string> = {
    sinistchamasterpiece: 'sinistcha',
    vivillon: 'vivillonfancy',
  };
  const cosmeticAlias = cosmeticUsageAliases[normalized];
  if (cosmeticAlias) aliases.add(cosmeticAlias);
  for (const alias of aliases) {
    const exact = entries.find(
      (entry) =>
        normalizeIdentifier(entry.name) === alias ||
        normalizeIdentifier(entry.showdownId) === alias,
    );
    if (exact) return exact;
  }

  // Regional forms are distinct species; only an explicit Mega suffix aliases a base.
  return undefined;
}

export class ChampionsBattleDataProvider {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly concurrency: number;
  private readonly throttleMs: number;
  private readonly now: () => Date;

  constructor(options: FetchOptions = {}) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.concurrency = options.concurrency ?? 4;
    this.throttleMs = options.throttleMs ?? 50;
    this.now = options.now ?? (() => new Date());
  }

  async fetch(
    profile: RegulationProfile,
    pokemon: readonly string[],
    options?: {allowMissing?: boolean},
  ): Promise<ChampionsBattleDataResult>;
  async fetch(request: ChampionsRequest): Promise<ChampionsBattleDataResult>;
  async fetch(
    profileOrRequest: RegulationProfile | ChampionsRequest,
    pokemon?: readonly string[],
    options?: {allowMissing?: boolean},
  ): Promise<ChampionsBattleDataResult> {
    const request =
      'sources' in profileOrRequest
        ? {...requestFromProfile(profileOrRequest, pokemon ?? []), ...(options?.allowMissing ? {allowMissing: true} : {})}
        : profileOrRequest;
    validateBinding(request);
    if (!request.pokemon.length) {
      throw new VgcError(
        'INVALID_INPUT',
        'At least one relevant Pokémon is required',
      );
    }
    const baseUrl = request.baseUrl.replace(/\/+$/, '');
    const indexUrl = `${baseUrl}/data/pokemon-index.json`;
    const indexText = await fetchText(this.fetcher, indexUrl, PROVIDER);
    let indexJson: unknown;
    try {
      indexJson = JSON.parse(indexText) as unknown;
    } catch (error) {
      throw new VgcError(
        'SOURCE_SCHEMA_CHANGED',
        'Champions Battle Data index is not valid JSON',
        {url: indexUrl},
        {cause: error},
      );
    }
    const parsedIndex = pokemonIndexSchema.safeParse(indexJson);
    if (!parsedIndex.success) {
      throw new VgcError(
        'SOURCE_SCHEMA_CHANGED',
        'Champions Battle Data index schema changed',
        {issues: parsedIndex.error.issues.slice(0, 5)},
        {cause: parsedIndex.error},
      );
    }
    const generatedDate = sourceDate(parsedIndex.data.generatedAt);

    const missing: string[] = [];
    const selectedByPath = new Map<string, CsvSelection>();
    for (const requested of [...new Set(request.pokemon)]) {
      const entry = resolveIndexEntry(parsedIndex.data.pokemon, requested);
      if (!entry) {
        missing.push(requested);
        continue;
      }
      const format = request.format ?? 'Doubles';
      const season =
        request.season ?? parsedIndex.data.defaultSeason ?? 'Current';
      const sources = entry.battleDataCsvs.filter(
        (candidate) =>
          candidate.format === format &&
          (candidate.season === season ||
            (season === 'Current' && candidate.season === 'Current')),
      );
      // A percentage is a marginal within one snapshot. Pooling daily rows without
      // denominators double-counts observations and invents a joint distribution.
      const dated = sources.map(candidate => ({...candidate,
        sourceDate: candidate.date ? sourceDate(candidate.date) : undefined,
      })).filter(candidate => !request.binding || (candidate.sourceDate &&
        candidate.sourceDate >= sourceDate(request.binding.validFrom) &&
        candidate.sourceDate <= sourceDate(request.binding.validTo)))
        .sort((left, right) =>
        (right.sourceDate ?? '').localeCompare(left.sourceDate ?? '') || left.path.localeCompare(right.path));
      const candidate = dated[0];
      if (!candidate) {
        missing.push(requested);
        continue;
      }
      if (candidate.daily && !candidate.sourceDate) {
        throw new VgcError('SOURCE_SCHEMA_CHANGED', 'Daily usage source has no date', {pokemon: requested});
      }
      const previous = selectedByPath.get(candidate.path);
      if (previous && previous.showdownId !== entry.showdownId) {
        throw new VgcError('SOURCE_SCHEMA_CHANGED', 'Usage CSV is assigned to multiple species', {path: candidate.path});
      }
      selectedByPath.set(candidate.path, {
        pokemon: entry.name,
        showdownId: entry.showdownId,
        path: candidate.path,
        season,
        format,
        requestedPokemon: [...(previous?.requestedPokemon ?? []), requested],
        ...(candidate.sourceDate ? {sourceDate: candidate.sourceDate} : {}),
      });
    }
    if (missing.length && !request.allowMissing) {
      throw new VgcError(
        'SOURCE_SCHEMA_CHANGED',
        'Requested Pokémon are missing from Champions Battle Data',
        {pokemon: missing},
      );
    }
    const selected = [...selectedByPath.values()];
    if (!selected.length && !request.allowMissing) {
      throw new VgcError(
        'SOURCE_SCHEMA_CHANGED',
        'No matching Doubles CSV files were listed by Champions Battle Data',
      );
    }

    const retrievedAt = this.now().toISOString();
    const documents = await mapBounded(
      selected,
      this.concurrency,
      this.throttleMs,
      async (selection) => {
        const url = new URL(selection.path, `${baseUrl}/`).toString();
        const text = await fetchText(this.fetcher, url, PROVIDER);
        const source: SourceReference = {
          provider: PROVIDER,
          retrievedAt,
          sourceVersion: parsedIndex.data.dataVersion,
          url,
          contentHash: sha256(text),
          season: selection.season,
          format: selection.format,
          ...(selection.sourceDate ? {sourceDate: selection.sourceDate} : {}),
          regulationVerified: Boolean(request.binding),
          ...(request.binding ? {regulationId: request.regulationId} : {}),
        };
        const rows = parseRows(text, source);
        if (rows.some(row => ![selection.pokemon, selection.showdownId].some(name =>
          normalizeIdentifier(name) === normalizeIdentifier(row.pokemon)))) {
          throw new VgcError('SOURCE_SCHEMA_CHANGED', 'Usage CSV species does not match its index entry', {url});
        }
        const baseIdentity = (name: string) => normalizeIdentifier(name).replace(/mega(?:x|y|z)?$/, '');
        const identities = selection.requestedPokemon.filter((name, index, all) =>
          all.findIndex(candidate => baseIdentity(candidate) === baseIdentity(name)) === index);
        return {
          // Preserve requested identities for cosmetic usage aliases, without
          // changing any published team set or hiding the original source URL.
          rows: identities.flatMap(pokemon => rows.map(row => ({...row, pokemon}))),
          text,
        };
      },
    );
    const contentHash = sha256(
      indexText + documents.map((document) => document.text).join(''),
    );
    return {
      pokemon: [...new Set(selected.flatMap((item) => item.requestedPokemon))],
      missingPokemon: missing,
      data: documents.flatMap((document) => document.rows),
      source: {
        provider: PROVIDER,
        retrievedAt,
        sourceVersion: parsedIndex.data.dataVersion,
        url: indexUrl,
        contentHash,
        sourceDate: generatedDate,
        season: request.season ?? parsedIndex.data.defaultSeason ?? 'Current',
        format: request.format ?? 'Doubles',
        regulationVerified: Boolean(request.binding),
        ...(request.binding ? {regulationId: request.regulationId} : {}),
      },
    };
  }

  async load(
    profile: RegulationProfile,
    pokemon: readonly string[],
  ): Promise<ProviderSnapshot<MetaUsageRow[]>> {
    return this.fetch(profile, pokemon);
  }
}

export const ChampionsProvider = ChampionsBattleDataProvider;
