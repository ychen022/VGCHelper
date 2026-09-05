import {createHash, randomUUID} from 'node:crypto';

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}
