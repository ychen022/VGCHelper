import {existsSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

function findRoot(start: string): string | undefined {
  let current = resolve(start);

  while (true) {
    if (
      existsSync(join(current, 'package.json')) &&
      existsSync(join(current, 'config', 'active-regulation.json'))
    ) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function projectRoot(): string {
  const configured = process.env['VGC_HELPER_ROOT'];
  const candidates = [
    configured,
    process.cwd(),
    dirname(fileURLToPath(import.meta.url)),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    const root = findRoot(candidate);
    if (root) return root;
  }

  throw new Error('Could not find VGCHelper project root');
}

export function dataDirectory(): string {
  return resolve(
    process.env['VGC_HELPER_DATA_DIR'] ?? join(projectRoot(), '.vgc-helper'),
  );
}
