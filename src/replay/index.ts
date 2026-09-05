import type {ParsedReplay} from '../domain/contracts.js';
import {VgcError} from '../errors.js';
import {
  formatMatches,
  type RegulationProfile,
} from '../regulation/profile.js';
import {loadReplay, type ReplayInput} from './input.js';
import {parseReplay} from './parser.js';

export function ingestReplay(
  input: ReplayInput,
  profile: RegulationProfile,
): ParsedReplay {
  const document = loadReplay(input);
  if (document.metadata.gameType?.toLowerCase() !== 'doubles') {
    throw new VgcError(
      'WRONG_FORMAT',
      `Expected a doubles replay, found ${document.metadata.gameType ?? 'unknown game type'}`,
    );
  }

  const format = document.metadata.format ?? document.metadata.formatId;
  if (!formatMatches(profile, format)) {
    throw new VgcError(
      'WRONG_FORMAT',
      `Replay format "${format ?? 'unknown'}" does not match ${profile.name}`,
      {acceptedFormats: profile.acceptedFormats},
    );
  }

  return parseReplay(document);
}

export {loadReplay} from './input.js';
export {normalizeEvents, parseReplay} from './parser.js';
export type {ReplayInput} from './input.js';
