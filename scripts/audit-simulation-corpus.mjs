import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdir, readFile, readdir, stat, writeFile} from 'node:fs/promises';
import {basename, extname, resolve} from 'node:path';
import {createInterface} from 'node:readline';

import {
  auditReplayRecords,
  buildReplayExamples,
  evaluateActionPrior,
  splitReplayGroupsByTime,
  trainContextualActionPrior,
} from '../dist/simulation/learning.js';

const arguments_ = process.argv.slice(2);
const value = name => {
  const index = arguments_.indexOf(name);
  return index >= 0 ? arguments_[index + 1] : undefined;
};
const input = resolve(value('--input') ?? 'examples/public-replays');
const output = resolve(value('--output') ?? 'examples/reports/simulation-corpus-audit.json');
const maxRecords = Number(value('--max-records') ?? 10_000);
const maxBytes = Number(value('--max-bytes') ?? 64 * 1024 * 1024);
const hfMetadata = arguments_.includes('--hf-metadata');
const dataset = value('--dataset') ?? 'HolidayOugi/pokemon-showdown-replays';
const revision = value('--revision');

if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
  throw new Error('max-records and max-bytes must be positive integers');
}

let bytesRead = 0;
const records = [];

function normalize(row, source) {
  if (!row || typeof row !== 'object' || typeof row.log !== 'string') return undefined;
  const upload = typeof row.uploadtime === 'number'
    ? new Date(row.uploadtime * 1000).toISOString()
    : typeof row.uploadTime === 'string' ? row.uploadTime : undefined;
  return {
    id: String(row.id ?? `${source.provider}-${records.length + 1}`),
    ...(typeof row.formatid === 'string' ? {formatId: row.formatid} : {}),
    ...(typeof row.formatId === 'string' ? {formatId: row.formatId} : {}),
    ...(typeof row.format === 'string' ? {format: row.format} : {}),
    ...(upload ? {uploadTime: upload} : {}),
    ...(Number.isFinite(row.rating) ? {rating: Number(row.rating)} : {}),
    log: row.log,
    source,
  };
}

async function addJson(path) {
  const info = await stat(path);
  if (bytesRead + info.size > maxBytes) throw new Error(`Byte limit exceeded before ${path}`);
  bytesRead += info.size;
  const raw = await readFile(path, 'utf8');
  const parsed = JSON.parse(raw);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const version = createHash('sha256').update(raw).digest('hex');
  for (const row of rows) {
    const normalized = normalize(row, {provider: 'local-file', sourceVersion: version, url: path});
    if (normalized) records.push(normalized);
    if (records.length >= maxRecords) return;
  }
}

async function addJsonl(path) {
  const stream = createReadStream(path, {encoding: 'utf8'});
  const lines = createInterface({input: stream, crlfDelay: Infinity});
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    bytesRead += Buffer.byteLength(line) + 1;
    if (bytesRead > maxBytes) {
      stream.destroy();
      throw new Error(`Byte limit exceeded at ${path}:${lineNumber}`);
    }
    if (!line.trim()) continue;
    const normalized = normalize(JSON.parse(line), {provider: 'local-jsonl', sourceVersion: `line-source:${basename(path)}`, url: path});
    if (normalized) records.push(normalized);
    if (records.length >= maxRecords) break;
  }
}

async function loadInput() {
  const info = await stat(input);
  const paths = info.isDirectory()
    ? (await readdir(input)).filter(name => name.endsWith('.json') && name !== 'validation.json').sort().map(name => resolve(input, name))
    : [input];
  for (const path of paths) {
    if (records.length >= maxRecords) break;
    if (extname(path).toLowerCase() === '.jsonl') await addJsonl(path);
    else await addJson(path);
  }
}

async function fetchDatasetMetadata() {
  if (!hfMetadata) return {queried: false};
  const url = `https://huggingface.co/api/datasets/${dataset}${revision ? `/revision/${revision}` : ''}`;
  const response = await fetch(url, {headers: {'user-agent': 'vgc-helper-bounded-audit/1'}});
  if (!response.ok) throw new Error(`Hugging Face metadata request failed: ${response.status}`);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > 2_000_000) throw new Error('Hugging Face metadata response exceeds 2 MB');
  const body = await response.text();
  if (Buffer.byteLength(body) > 2_000_000) throw new Error('Hugging Face metadata response exceeds 2 MB');
  const metadata = JSON.parse(body);
  const allSiblings = Array.isArray(metadata.siblings) ? metadata.siblings : [];
  const relevantSiblings = allSiblings.filter(item => /\[Gen 9\] CHAMPIONS VGC 2026/i.test(item.rfilename ?? ''));
  let sizeApi = {queried: false};
  try {
    const sizeUrl = `https://datasets-server.huggingface.co/size?dataset=${encodeURIComponent(dataset)}`;
    const sizeResponse = await fetch(sizeUrl, {headers: {'user-agent': 'vgc-helper-bounded-audit/1'}});
    if (sizeResponse.ok) {
      const sizeBody = await sizeResponse.text();
      if (Buffer.byteLength(sizeBody) <= 2_000_000) {
        const size = JSON.parse(sizeBody);
        sizeApi = {
          queried: true,
          datasetRows: size.size?.dataset?.num_rows ?? null,
          datasetBytes: size.size?.dataset?.num_bytes_original_files ?? null,
          configs: Array.isArray(size.size?.configs)
            ? size.size.configs.filter(config => /CHAMPIONS VGC 2026/i.test(config.config ?? ''))
            : [],
        };
      }
    }
  } catch (error) {
    sizeApi = {queried: false, error: error instanceof Error ? error.message : String(error)};
  }
  return {
    queried: true,
    dataset,
    requestedRevision: revision ?? null,
    resolvedRevision: metadata.sha ?? null,
    lastModified: metadata.lastModified ?? null,
    downloads: metadata.downloads ?? null,
    tags: Array.isArray(metadata.tags) ? metadata.tags : [],
    repositoryFileCount: allSiblings.length,
    relevantShards: relevantSiblings.map(item => ({name: item.rfilename, size: item.size ?? null})),
    sizeApi,
    reuseTerms: {
      license: metadata.cardData?.license ?? null,
      status: metadata.cardData?.license ? 'declared' : 'not_declared_in_metadata',
      artifactDistributionApproved: false,
    },
    limitation: 'Repository metadata does not verify the number of explicit Champions VGC 2026 Regulation M-B rows.',
  };
}

await loadInput();
const audit = auditReplayRecords(records);
const accepted = records.filter(record => audit.acceptedIds.includes(record.id));
const split = splitReplayGroupsByTime(accepted);
const train = split.train.flatMap(buildReplayExamples);
const validation = split.validation.flatMap(buildReplayExamples);
const test = split.test.flatMap(buildReplayExamples);
const corpusHash = audit.sourceVersions.length
  ? createHash('sha256').update(audit.sourceVersions.join(',')).digest('hex')
  : createHash('sha256').update('unversioned').digest('hex');
const artifact = trainContextualActionPrior(train, {
  sourceVersion: corpusHash,
  sourceHash: corpusHash,
  heldout: validation,
  minimumTrainingExamples: 500,
});
const report = {
  audit,
  boundedRead: {input, bytesRead, maxBytes, recordsRead: records.length, maxRecords},
  split: {trainGames: split.train.length, validationGames: split.validation.length, testGames: split.test.length},
  policy: {
    artifact,
    finalTestMetrics: evaluateActionPrior(test, artifact),
    limitation: artifact.adopted
      ? 'Adoption gate passed for this audited sample.'
      : 'Artifact is retained for audit only; the simulator should use its tactical fallback.',
  },
  huggingFace: await fetchDatasetMetadata(),
  limitations: [
    'Public logs reveal executed events, not submitted commands; censored rows are excluded from training.',
    'Redirected and ambiguous moves are audited but excluded from training.',
    'Unused preview members do not establish bring-four labels.',
    'No private set fields or later replay reveals are included in action features.',
  ],
};
await mkdir(resolve(output, '..'), {recursive: true});
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({output, accepted: audit.records.accepted, labels: audit.labels, adopted: artifact.adopted}));
