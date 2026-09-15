import {parse as parseCsv} from 'csv-parse/sync';
import {Teams} from '@pkmn/sets';

import type {FieldProvenance, PokemonSet, SourceReference, Stats} from '../../domain/contracts.js';
import {VgcError} from '../../errors.js';
import type {RegulationProfile} from '../../regulation/profile.js';
import {sha256} from '../../util/hash.js';
import {fetchText, mapBounded, normalizeIdentifier} from './http.js';
import type {
  FetchOptions,
  VgcPastesResult,
  VgcPasteTeam,
} from './types.js';

const PROVIDER = 'vgc-pastes';

interface VgcPastesRequest {
  spreadsheetId: string;
  gid: string;
  regulationId: string;
  teamIdPrefix?: string | undefined;
  level?: number;
}

interface TeamSeed {
  id: string;
  description: string;
  player?: string;
  roster: string[];
  pasteUrl?: string;
  event?: string;
  placement?: string;
  date?: string;
  category?: string;
}

function cell(row: readonly string[], index: number | undefined): string {
  return index === undefined ? '' : (row[index] ?? '').trim();
}

function normalizedHeader(value: string): string {
  return normalizeIdentifier(value.replace(/\r?\n/g, ' '));
}

function findColumn(
  headers: readonly string[],
  names: readonly string[],
  required = false,
): number | undefined {
  const wanted = new Set(names.map(normalizedHeader));
  const index = headers.findIndex((header) => wanted.has(normalizedHeader(header)));
  if (index >= 0) return index;
  if (required) {
    throw new VgcError(
      'SOURCE_SCHEMA_CHANGED',
      `VGC Pastes CSV is missing column ${names[0] ?? 'unknown'}`,
    );
  }
  return undefined;
}

function parseCsvRows(csv: string): string[][] {
  let rows: unknown;
  try {
    rows = parseCsv(csv, {
      bom: true,
      relax_column_count: true,
      skip_empty_lines: true,
    });
  } catch (error) {
    throw new VgcError(
      'SOURCE_SCHEMA_CHANGED',
      'VGC Pastes returned malformed CSV',
      undefined,
      {cause: error},
    );
  }
  if (
    !Array.isArray(rows) ||
    rows.some(
      (row) =>
        !Array.isArray(row) ||
        row.some((value: unknown) => typeof value !== 'string'),
    )
  ) {
    throw new VgcError(
      'SOURCE_SCHEMA_CHANGED',
      'VGC Pastes CSV did not contain text rows',
    );
  }
  return rows as string[][];
}

function parseSeeds(csv: string): TeamSeed[] {
  const rows = parseCsvRows(csv);
  const headerIndex = rows.findIndex((row) => {
    const normalized = new Set(row.map(normalizedHeader));
    return normalized.has('teamid') && normalized.has('pokepaste');
  });
  if (headerIndex < 0) {
    throw new VgcError(
      'SOURCE_SCHEMA_CHANGED',
      'Unable to identify the VGC Pastes header row',
    );
  }
  const headers = rows[headerIndex];
  if (!headers) {
    throw new VgcError('SOURCE_SCHEMA_CHANGED', 'VGC Pastes header is empty');
  }
  const columns = {
    id: findColumn(headers, ['Team ID'], true),
    description: findColumn(headers, ['Team Description', 'Description'], true),
    player: findColumn(headers, ['Full Name', 'Player', 'Player Name']),
    paste: findColumn(headers, ['Pokepaste', 'Pokepaste Link'], true),
    event: findColumn(headers, ['Tournament / Event', 'Event']),
    placement: findColumn(headers, ['Rank', 'Placement']),
    date: findColumn(headers, ['Date Shared', 'Date']),
    category: findColumn(headers, ['Category']),
    roster: findColumn(headers, [
      'Pokemon Text for Copypasta',
      'Pokémon Text for Copypasta',
      'Roster',
    ]),
    rosterColumns: Array.from({length: 6}, (_, index) =>
      findColumn(headers, [
        `Pokemon ${index + 1}`,
        `Pokémon ${index + 1}`,
        String(index + 1),
      ]),
    ),
  };
  if (
    columns.roster === undefined &&
    columns.rosterColumns.every((index) => index === undefined)
  ) {
    throw new VgcError(
      'SOURCE_SCHEMA_CHANGED',
      'VGC Pastes CSV is missing its roster columns',
    );
  }
  const seeds: TeamSeed[] = [];
  for (const row of rows.slice(headerIndex + 1)) {
    const id = cell(row, columns.id);
    if (!id) continue;
    const textRoster =
      columns.roster === undefined
        ? []
        : row
            .slice(columns.roster)
            .map((value) => value.trim())
            .filter(Boolean)
            .slice(0, 6);
    const numberedRoster = columns.rosterColumns
      .map((index) => cell(row, index))
      .filter(Boolean);
    const roster = textRoster.length ? textRoster : numberedRoster;
    if (!roster.length) {
      throw new VgcError(
        'SOURCE_SCHEMA_CHANGED',
        `VGC Pastes team ${id} has no roster`,
      );
    }
    const optional = {
      player: cell(row, columns.player),
      pasteUrl: cell(row, columns.paste),
      event: cell(row, columns.event),
      placement: cell(row, columns.placement),
      date: cell(row, columns.date),
      category: cell(row, columns.category),
    };
    seeds.push({
      id,
      description: cell(row, columns.description) || id,
      roster,
      ...(optional.player ? {player: optional.player} : {}),
      ...(optional.pasteUrl.startsWith('http')
        ? {pasteUrl: optional.pasteUrl}
        : {}),
      ...(optional.event ? {event: optional.event} : {}),
      ...(optional.placement ? {placement: optional.placement} : {}),
      ...(optional.date ? {date: optional.date} : {}),
      ...(optional.category ? {category: optional.category} : {}),
    });
  }
  if (!seeds.length) {
    throw new VgcError('SOURCE_SCHEMA_CHANGED', 'VGC Pastes CSV has no teams');
  }
  return seeds;
}

function decodeHtml(value: string): string {
  const entities: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    '#39': "'",
    nbsp: ' ',
  };
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[\da-f]+|[a-z]+);/gi, (match, entity: string) => {
      const lower = entity.toLowerCase();
      if (lower.startsWith('#x')) {
        return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
      }
      if (lower.startsWith('#')) {
        return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
      }
      return entities[lower] ?? match;
    })
    .trim();
}

export function extractPokepasteText(body: string): string | undefined {
  const trimmed = body.trim();
  if (!trimmed.startsWith('<')) return trimmed || undefined;
  const pre = [...body.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/gi)]
    .map((match) => match[1])
    .filter((value): value is string => value !== undefined);
  if (pre.length) return pre.map(decodeHtml).join('\n\n');
  const textarea = /<textarea[^>]*>([\s\S]*?)<\/textarea>/i.exec(body)?.[1];
  if (textarea) return decodeHtml(textarea);
  const paste = /<(?:div|section)[^>]+(?:class|id)=["'][^"']*(?:paste|content)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|section)>/i.exec(
    body,
  )?.[1];
  return paste ? decodeHtml(paste) : undefined;
}

function stats(
  value: Partial<Record<'hp' | 'atk' | 'def' | 'spa' | 'spd' | 'spe', number>>,
): Stats {
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, number] =>
      Number.isFinite(entry[1]),
    ),
  ) as Stats;
}

function parseTeam(text: string, level: number, source: string): PokemonSet[] | undefined {
  const parsed = Teams.importTeam(text);
  if (!parsed?.team.length) return undefined;
  const result: PokemonSet[] = [];
  for (const set of parsed.team) {
    const species = set.species || set.name;
    if (!species) return undefined;
    const field = (present: boolean): FieldProvenance => ({
      knowledge: present ? 'known' : 'unknown', confidence: present ? 1 : 0,
      source: present ? source : `${source}; omitted from published set`,
    });
    result.push({
      species,
      ...(set.name && set.name !== set.species ? {nickname: set.name} : {}),
      ...(set.item ? {item: set.item} : {}),
      ...(set.ability ? {ability: set.ability} : {}),
      ...(set.nature ? {nature: set.nature} : {}),
      moves: [...(set.moves ?? [])],
      skillPoints: stats(set.evs ?? {}),
      ivs: stats(set.ivs ?? {}),
      level: set.level ?? level,
      ...(set.gender ? {gender: set.gender} : {}),
      ...(set.shiny === undefined ? {} : {shiny: set.shiny}),
      provenance: {
        species: field(true),
        item: field(Boolean(set.item)),
        ability: field(Boolean(set.ability)),
        nature: field(Boolean(set.nature)),
        moves: field(Boolean(set.moves?.length)),
        skillPoints: field(Boolean(set.evs && Object.keys(set.evs).length)),
      },
    });
  }
  return result;
}

function rawUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.hostname === 'pokepast.es' && !parsed.pathname.endsWith('/raw')) {
    parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/raw`;
  }
  return parsed.toString();
}

function requestFromProfile(profile: RegulationProfile): VgcPastesRequest {
  return {
    ...profile.sources.vgcPastes,
    regulationId: profile.id,
    level: profile.level,
  };
}

export class VgcPastesProvider {
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

  async fetch(profile: RegulationProfile): Promise<VgcPastesResult>;
  async fetch(request: VgcPastesRequest): Promise<VgcPastesResult>;
  async fetch(
    profileOrRequest: RegulationProfile | VgcPastesRequest,
  ): Promise<VgcPastesResult> {
    const request =
      'sources' in profileOrRequest
        ? requestFromProfile(profileOrRequest)
        : profileOrRequest;
    const csvUrl =
      `https://docs.google.com/spreadsheets/d/` +
      `${encodeURIComponent(request.spreadsheetId)}/export?format=csv&gid=` +
      encodeURIComponent(request.gid);
    const csv = await fetchText(this.fetcher, csvUrl, PROVIDER);
    const seeds = parseSeeds(csv);
    const expectedPrefix = request.teamIdPrefix;
    if (expectedPrefix && seeds.some(seed => !seed.id.startsWith(expectedPrefix))) {
      throw new VgcError('SOURCE_SCHEMA_CHANGED', 'VGC Pastes team IDs do not match the configured regulation', {
        regulationId: request.regulationId, expectedPrefix: request.teamIdPrefix,
      });
    }
    const retrievedAt = this.now().toISOString();
    const csvHash = sha256(csv);
    const teams = await mapBounded(
      seeds,
      this.concurrency,
      this.throttleMs,
      async (seed): Promise<VgcPasteTeam> => {
        let pokemon: PokemonSet[] = [];
        let exactSets = false;
        let pasteHash: string | undefined;
        if (seed.pasteUrl) {
          // A supplied paste that fails is not evidence of a roster-only team.
          // Propagate before staging so a refresh retains the active generation.
          let response: string;
          try {
            response = await fetchText(this.fetcher, rawUrl(seed.pasteUrl), PROVIDER);
          } catch (error) {
            if (!(error instanceof VgcError) || error.code !== 'SOURCE_UNAVAILABLE') {
              throw error;
            }
            response = await fetchText(this.fetcher, seed.pasteUrl, PROVIDER);
          }
          const pasteText = extractPokepasteText(response);
          const parsed = pasteText
            ? parseTeam(pasteText, request.level ?? 50, `${PROVIDER}:${seed.pasteUrl}#${sha256(pasteText)}`)
            : undefined;
          const identity = (name: string) => normalizeIdentifier(name).replace(/mega(?:x|y|z)?$/, '');
          const expected = seed.roster.map(identity).sort();
          const actual = parsed?.map(set => identity(set.species)).sort();
          if (parsed?.length === seed.roster.length && JSON.stringify(expected) === JSON.stringify(actual)) {
            pokemon = parsed;
            // Published fields are exact; omitted fields remain explicitly unknown.
            exactSets = true;
            pasteHash = sha256(pasteText ?? response);
          } else {
            throw new VgcError('SOURCE_SCHEMA_CHANGED', 'Published paste is malformed or does not match its listed roster', {teamId: seed.id, url: seed.pasteUrl});
          }
        }
        const source: SourceReference = {
          provider: PROVIDER,
          retrievedAt,
          sourceVersion: csvHash,
          url: seed.pasteUrl ?? csvUrl,
          contentHash: pasteHash ?? csvHash,
        };
        return {
          id: seed.id,
          regulationId: request.regulationId,
          name: seed.description,
          pokemon,
          roster: seed.roster,
          exactSets,
          source,
          ...(seed.player ? {player: seed.player} : {}),
          ...(seed.event ? {event: seed.event} : {}),
          ...(seed.placement ? {placement: seed.placement} : {}),
          ...(seed.date ? {date: seed.date} : {}),
          ...(seed.category ? {category: seed.category} : {}),
          ...(seed.pasteUrl ? {sourceUrl: seed.pasteUrl} : {}),
        };
      },
    );
    return {
      data: teams,
      source: {
        provider: PROVIDER,
        retrievedAt,
        sourceVersion: csvHash,
        url: csvUrl,
        contentHash: sha256(
          csv + teams.map((team) => team.source.contentHash).join(''),
        ),
      },
    };
  }

  async load(profile: RegulationProfile): Promise<VgcPastesResult> {
    return this.fetch(profile);
  }
}

export const VgcPastes = VgcPastesProvider;
