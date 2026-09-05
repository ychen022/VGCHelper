import {readFileSync, statSync} from 'node:fs';
import {extname, resolve} from 'node:path';

import type {ReplayDocument, ReplayMetadata} from '../domain/contracts.js';
import {VgcError} from '../errors.js';
import {sha256} from '../util/hash.js';

const MAX_REPLAY_BYTES = 10 * 1024 * 1024;

export interface ReplayInput {
  content?: string;
  path?: string;
}

interface ReplayJson {
  id?: unknown;
  format?: unknown;
  formatid?: unknown;
  players?: unknown;
  uploadtime?: unknown;
  log?: unknown;
}

function readInput(input: ReplayInput): {raw: string; extension?: string} {
  if (Boolean(input.content) === Boolean(input.path)) {
    throw new VgcError(
      'INVALID_REPLAY',
      'Provide exactly one of replay content or replay path',
    );
  }

  if (input.path) {
    const path = resolve(input.path);
    let size: number;
    try {
      size = statSync(path).size;
    } catch (error) {
      throw new VgcError(
        'INVALID_REPLAY',
        `Cannot read replay file ${path}`,
        undefined,
        {cause: error},
      );
    }
    if (size > MAX_REPLAY_BYTES) {
      throw new VgcError(
        'INVALID_REPLAY',
        `Replay file exceeds the ${MAX_REPLAY_BYTES / 1024 / 1024} MB limit`,
        {size},
      );
    }
    return {raw: readFileSync(path, 'utf8'), extension: extname(path)};
  }

  const raw = input.content ?? '';
  if (Buffer.byteLength(raw) > MAX_REPLAY_BYTES) {
    throw new VgcError(
      'INVALID_REPLAY',
      `Replay content exceeds the ${MAX_REPLAY_BYTES / 1024 / 1024} MB limit`,
    );
  }
  return {raw};
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function parseUploadTime(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return new Date(value * 1000).toISOString();
}

function metadataFromJson(value: ReplayJson): ReplayMetadata {
  return {
    ...(text(value.id) ? {id: text(value.id)!} : {}),
    ...(text(value.format) ? {format: text(value.format)!} : {}),
    ...(text(value.formatid) ? {formatId: text(value.formatid)!} : {}),
    players: Array.isArray(value.players)
      ? value.players.filter((player): player is string => typeof player === 'string')
      : [],
    ...(parseUploadTime(value.uploadtime)
      ? {uploadedAt: parseUploadTime(value.uploadtime)!}
      : {}),
  };
}

function mergeLogMetadata(log: string, metadata: ReplayMetadata): ReplayMetadata {
  const players = [...metadata.players];
  let format = metadata.format;
  let winner = metadata.winner;
  let gameType = metadata.gameType;

  for (const line of log.split(/\r?\n/)) {
    const parts = line.split('|');
    const command = parts[1];
    if (command === 'player' && (parts[2] === 'p1' || parts[2] === 'p2')) {
      const player = parts[3];
      if (player && !players.includes(player)) players.push(player);
    } else if (command === 'tier' && parts[2]) {
      format = parts[2];
    } else if (command === 'gametype' && parts[2]) {
      gameType = parts[2];
    } else if (command === 'win' && parts[2]) {
      winner = parts[2];
    } else if (command === 'tie') {
      winner = 'Tie';
    }

  }

  return {
    ...metadata,
    players,
    ...(format ? {format} : {}),
    ...(winner ? {winner} : {}),
    ...(gameType ? {gameType} : {}),
  };
}

function formatKey(value?: string): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function extractHtml(raw: string): {log: string; metadata: ReplayMetadata} {
  const scripts = [...raw.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  const scriptContent = (type: string, className: RegExp) => scripts.find((match) => {
    const attributes = match[1] ?? '';
    return /\btype\s*=\s*["']([^"']+)["']/i.exec(attributes)?.[1]?.toLowerCase() === type &&
      className.test(/\bclass\s*=\s*["']([^"']+)["']/i.exec(attributes)?.[1] ?? '');
  })?.[2];
  const logMatch = [undefined, scriptContent('text/plain', /(?:^|\s)(?:battle-log-data|log)(?:\s|$)/)];
  if (!logMatch?.[1]) {
    throw new VgcError(
      'INVALID_REPLAY',
      'HTML file does not contain a Pokemon Showdown replay log',
    );
  }

  const dataMatch = [undefined, scriptContent('application/json', /(?:^|\s)data(?:\s|$)/)];
  let metadata: ReplayMetadata = {players: []};
  if (dataMatch?.[1]) {
    try {
      metadata = metadataFromJson(JSON.parse(dataMatch[1]) as ReplayJson);
    } catch (error) {
      throw new VgcError(
        'INVALID_REPLAY',
        'Replay HTML contains invalid metadata JSON',
        undefined,
        {cause: error},
      );
    }
  }

  return {
    log: logMatch[1].trim().replaceAll('\\/', '/'),
    metadata,
  };
}

export function loadReplay(input: ReplayInput): ReplayDocument {
  const {raw, extension} = readInput(input);
  if (!raw.trim()) {
    throw new VgcError('INVALID_REPLAY', 'Replay input cannot be empty');
  }

  const trimmed = raw.trim();
  let sourceType: ReplayDocument['sourceType'];
  let log: string;
  let metadata: ReplayMetadata = {players: []};

  if (trimmed.startsWith('{')) {
    let json: ReplayJson;
    try {
      json = JSON.parse(trimmed) as ReplayJson;
    } catch (error) {
      throw new VgcError(
        'INVALID_REPLAY',
        'Replay JSON is malformed',
        undefined,
        {cause: error},
      );
    }
    if (typeof json.log !== 'string' || !json.log.trim()) {
      throw new VgcError(
        'INVALID_REPLAY',
        'Replay JSON does not contain a non-empty log field',
      );
    }
    sourceType = 'json';
    log = json.log.trim();
    metadata = metadataFromJson(json);
  } else if (
    trimmed.startsWith('<') ||
    extension?.toLowerCase() === '.html'
  ) {
    const extracted = extractHtml(raw);
    sourceType = 'html';
    log = extracted.log;
    metadata = extracted.metadata;
  } else {
    sourceType = extension?.toLowerCase() === '.log' ? 'log' : 'raw';
    log = trimmed;
  }

  if (!log.split(/\r?\n/).some((line) => line.startsWith('|'))) {
    throw new VgcError(
      'INVALID_REPLAY',
      'Input does not contain Pokemon Showdown protocol messages',
    );
  }

  const declaredFormat = metadata.format;
  const declaredFormatId = metadata.formatId;
  metadata = mergeLogMetadata(log, metadata);
  const protocolFormat = metadata.format;
  for (const declared of [declaredFormat, declaredFormatId]) {
    if (
      declared &&
      protocolFormat &&
      formatKey(declared) !== formatKey(protocolFormat)
    ) {
      throw new VgcError(
        'INVALID_REPLAY',
        'Replay metadata conflicts with the protocol tier',
        {declared, protocolFormat},
      );
    }
  }

  return {
    sourceType,
    raw,
    log,
    metadata,
    contentHash: sha256(log),
  };
}
