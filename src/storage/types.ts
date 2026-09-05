import type {MetaTeam, ParsedReplay} from '../domain/contracts.js';

export interface SourceSnapshotInput<T = unknown> {
  provider: string;
  regulationId: string;
  data: T;
  retrievedAt?: string;
  sourceVersion?: string;
  url?: string;
  contentHash?: string;
  active?: boolean;
}

export interface SourceSnapshot<T = unknown> {
  id: string;
  provider: string;
  regulationId: string;
  retrievedAt: string;
  sourceVersion?: string;
  url?: string;
  contentHash: string;
  data: T;
  active: boolean;
}

export interface ReplayRecord {
  id: string;
  contentHash: string;
  createdAt: string;
  replay: ParsedReplay;
}

export interface AnalysisRecord<T = unknown> {
  id: string;
  replayId?: string;
  regulationId?: string;
  type: string;
  contentHash: string;
  createdAt: string;
  analysis: T;
}

export interface AnalysisInput<T = unknown> {
  id?: string;
  replayId?: string;
  regulationId?: string;
  type: string;
  createdAt?: string;
  analysis: T;
}

export interface ActivateMetaInput {
  regulationId: string;
  teams: readonly MetaTeam[];
  sourceSnapshotIds?: readonly string[];
}
