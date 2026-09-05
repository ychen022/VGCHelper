import {VgcError, errorMessage} from '../../errors.js';

export function normalizeIdentifier(value: string): string {
  return value.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export async function fetchText(
  fetcher: typeof globalThis.fetch,
  url: string,
  provider: string,
): Promise<string> {
  let response: Response;
  try {
    response = await fetcher(url, {
      headers: {accept: 'application/json, text/csv, text/plain, text/html'},
    });
  } catch (error) {
    throw new VgcError(
      'SOURCE_UNAVAILABLE',
      `${provider} request failed: ${errorMessage(error)}`,
      {url},
      {cause: error},
    );
  }
  if (!response.ok) {
    throw new VgcError(
      'SOURCE_UNAVAILABLE',
      `${provider} returned HTTP ${response.status}`,
      {url, status: response.status},
    );
  }
  try {
    return await response.text();
  } catch (error) {
    throw new VgcError(
      'SOURCE_UNAVAILABLE',
      `Unable to read ${provider} response`,
      {url},
      {cause: error},
    );
  }
}

export async function mapBounded<T, R>(
  values: readonly T[],
  concurrency: number,
  throttleMs: number,
  operation: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new VgcError('INVALID_INPUT', 'Concurrency must be a positive integer');
  }
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from(
    {length: Math.min(concurrency, values.length)},
    async () => {
      while (cursor < values.length) {
        const index = cursor++;
        const value = values[index];
        if (value === undefined) continue;
        if (throttleMs > 0 && index >= concurrency) {
          await new Promise<void>((resolve) => setTimeout(resolve, throttleMs));
        }
        results[index] = await operation(value, index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}
