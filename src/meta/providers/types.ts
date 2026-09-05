import type {MetaTeam, MetaUsageRow, SourceReference} from '../../domain/contracts.js';

export interface ProviderSnapshot<T> {
  data: T;
  source: SourceReference;
}

export interface ChampionsBattleDataResult
  extends ProviderSnapshot<MetaUsageRow[]> {
  pokemon: string[];
  missingPokemon?: string[];
}

export interface VgcPasteTeam extends MetaTeam {
  player?: string;
}

export type VgcPastesResult = ProviderSnapshot<VgcPasteTeam[]>;

export interface FetchOptions {
  fetch?: typeof globalThis.fetch;
  concurrency?: number;
  throttleMs?: number;
  now?: () => Date;
}
