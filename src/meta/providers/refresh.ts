import type {MetaTeam, MetaUsageRow} from '../../domain/contracts.js';
import {VgcError} from '../../errors.js';
import type {RegulationProfile} from '../../regulation/profile.js';
import type {SqliteRepository} from '../../storage/repository.js';
import type {SourceSnapshot} from '../../storage/types.js';
import {ChampionsBattleDataProvider} from './champions-battle-data.js';
import {VgcPastesProvider} from './vgc-pastes.js';
import {normalizeIdentifier} from './http.js';

export interface MetaRefreshOptions {
  cacheTtlMs?: number;
  now?: () => Date;
}

export interface MetaRefreshRequest {
  relevantPokemon?: readonly string[];
  force?: boolean;
}

export interface MetaRefreshResult {
  teams: MetaTeam[];
  usage: MetaUsageRow[];
  snapshots: SourceSnapshot[];
  cached: boolean;
  warnings: string[];
}

function usageWarnings(usage: MetaUsageRow[], teams: MetaTeam[]): string[] {
  const warnings = usage.some(row => row.source.regulationVerified === false)
    ? ['Usage season-to-regulation mapping is unverified; these rows are contextual only and excluded from regulation-specific set hydration.']
    : [];
  const identity = (name: string) => normalizeIdentifier(name).replace(/mega(?:x|y)?$/, '');
  const covered = new Set(usage.map(row => identity(row.pokemon)));
  const missing = [...new Set(teams.flatMap(team => team.roster))].filter(species => !covered.has(identity(species)));
  if (missing.length) warnings.push(`Usage data is unavailable for ${missing.join(', ')}; published teams are retained and no usage fields are invented for these species.`);
  return warnings;
}

export class MetaRefreshService {
  private readonly cacheTtlMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly repository: SqliteRepository,
    private readonly champions: ChampionsBattleDataProvider,
    private readonly pastes: VgcPastesProvider,
    options: MetaRefreshOptions = {},
  ) {
    this.cacheTtlMs = options.cacheTtlMs ?? 15 * 60 * 1000;
    this.now = options.now ?? (() => new Date());
  }

  async refresh(
    profile: RegulationProfile,
    request: MetaRefreshRequest = {},
  ): Promise<MetaRefreshResult> {
    this.repository.initialize();
    if (request.relevantPokemon?.length) {
      throw new VgcError(
        'INVALID_INPUT',
        'A partial Pokemon list cannot be activated as the regulation-wide meta snapshot; use provider fetches for dry runs',
      );
    }
    if (!request.force) {
      const cached = this.readCache(profile);
      if (cached) return cached;
    }

    const pasteResult = await this.pastes.fetch(profile);
    const relevantPokemon =
      request.relevantPokemon?.length
        ? [...new Set(request.relevantPokemon)]
        : [...new Set(pasteResult.data.flatMap((team) => team.roster))];
    if (!relevantPokemon.length) {
      throw new VgcError(
        'SOURCE_SCHEMA_CHANGED',
        'VGC Pastes did not provide Pokémon for battle-data refresh',
      );
    }
    const championsResult = await this.champions.fetch(
      profile,
      relevantPokemon,
      {allowMissing: true},
    );

    const pasteSnapshot = this.repository.saveSourceSnapshot({
      provider: pasteResult.source.provider,
      regulationId: profile.id,
      data: pasteResult.data,
      retrievedAt: pasteResult.source.retrievedAt,
      ...(pasteResult.source.sourceVersion
        ? {sourceVersion: pasteResult.source.sourceVersion}
        : {}),
      ...(pasteResult.source.url ? {url: pasteResult.source.url} : {}),
      ...(pasteResult.source.contentHash
        ? {contentHash: pasteResult.source.contentHash}
        : {}),
    });
    const championsSnapshot = this.repository.saveSourceSnapshot({
      provider: championsResult.source.provider,
      regulationId: profile.id,
      data: championsResult.data,
      retrievedAt: championsResult.source.retrievedAt,
      ...(championsResult.source.sourceVersion
        ? {sourceVersion: championsResult.source.sourceVersion}
        : {}),
      ...(championsResult.source.url ? {url: championsResult.source.url} : {}),
      ...(championsResult.source.contentHash
        ? {contentHash: championsResult.source.contentHash}
        : {}),
    });

    this.repository.activateMetaSnapshot({
      regulationId: profile.id,
      teams: pasteResult.data,
      sourceSnapshotIds: [pasteSnapshot.id, championsSnapshot.id],
    });
    return {
      teams: pasteResult.data,
      usage: championsResult.data,
      snapshots: [
        {...pasteSnapshot, active: true},
        {...championsSnapshot, active: true},
      ],
      cached: false,
      warnings: usageWarnings(championsResult.data, pasteResult.data),
    };
  }

  private readCache(profile: RegulationProfile): MetaRefreshResult | undefined {
    const regulationId = profile.id;
    const snapshots =
      this.repository.listLatestSourceSnapshots(regulationId, true);
    const paste = snapshots.find(
      (snapshot) => snapshot.provider === 'vgc-pastes',
    );
    const champions = snapshots.find(
      (snapshot) => snapshot.provider === 'champions-battle-data',
    );
    if (!paste || !champions) return undefined;
    const config = profile.sources.championsBattleData;
    const binding = config.binding;
    const usage = champions.data as MetaUsageRow[];
    if (!Array.isArray(usage) || !usage.length || usage.some(row =>
      row.source.season !== config.season || row.source.format !== config.format ||
      row.source.regulationVerified !== Boolean(binding) ||
      !row.source.url?.startsWith(`${config.baseUrl.replace(/\/+$/, '')}/`) ||
      (binding && (row.source.regulationId !== regulationId || binding.regulationId !== regulationId ||
        binding.season !== config.season || !row.source.sourceDate ||
        row.source.sourceDate < binding.validFrom || row.source.sourceDate > binding.validTo))
    )) return undefined;
    const pasteConfig = profile.sources.vgcPastes;
    if (paste.url !== `https://docs.google.com/spreadsheets/d/${encodeURIComponent(pasteConfig.spreadsheetId)}/export?format=csv&gid=${encodeURIComponent(pasteConfig.gid)}`) return undefined;
    const oldest = Math.min(
      Date.parse(paste.retrievedAt),
      Date.parse(champions.retrievedAt),
    );
    if (
      !Number.isFinite(oldest) ||
      this.now().getTime() - oldest > this.cacheTtlMs
    ) {
      return undefined;
    }
    return {
      teams: this.repository.listMetaTeams(regulationId),
      usage: champions.data as MetaUsageRow[],
      snapshots,
      cached: true,
      warnings: usageWarnings(champions.data as MetaUsageRow[], this.repository.listMetaTeams(regulationId)),
    };
  }
}

export {MetaRefreshService as MetagameRefreshService};
