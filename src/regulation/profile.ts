import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {z} from 'zod';

import {VgcError} from '../errors.js';
import {projectRoot} from '../util/fs.js';

const profileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  game: z.literal('champions'),
  generation: z.literal(0),
  level: z.number().int().positive(),
  gameType: z.literal('Doubles'),
  teamSize: z.number().int().positive(),
  battleTeamSize: z.number().int().positive(),
  acceptedFormats: z.array(z.string().min(1)).min(1),
  sources: z.object({
    championsBattleData: z.object({
      baseUrl: z.url(),
      format: z.literal('Doubles'),
      season: z.string().min(1),
      days: z.number().int().min(1).max(31),
      binding: z.object({
        regulationId: z.string().min(1),
        season: z.string().min(1),
        validFrom: z.string().min(1),
        validTo: z.string().min(1),
      }).optional(),
    }),
    vgcPastes: z.object({
      spreadsheetId: z.string().min(1),
      gid: z.string().min(1),
    }),
    holidayOugi: z.object({
      dataset: z.string().min(1),
      files: z.array(z.string().min(1)),
    }),
  }),
  evaluation: z.object({
    maxMetaTeams: z.number().int().positive().max(50),
    maxReturnedFindings: z.number().int().positive().max(50),
  }),
});

export type RegulationProfile = z.infer<typeof profileSchema>;

const activeSchema = z.object({profileId: z.string().min(1)});

export function loadRegulationProfile(profileId?: string): RegulationProfile {
  const root = projectRoot();
  let selected = profileId;

  if (!selected) {
    const activePath = join(root, 'config', 'active-regulation.json');
    try {
      selected = activeSchema.parse(
        JSON.parse(readFileSync(activePath, 'utf8')),
      ).profileId;
    } catch (error) {
      throw new VgcError(
        'CONFIGURATION_ERROR',
        `Unable to load active regulation from ${activePath}`,
        undefined,
        {cause: error},
      );
    }
  }

  const profilePath = join(
    root,
    'config',
    'regulations',
    `${selected}.json`,
  );

  try {
    return profileSchema.parse(JSON.parse(readFileSync(profilePath, 'utf8')));
  } catch (error) {
    throw new VgcError(
      'CONFIGURATION_ERROR',
      `Unable to load regulation profile ${selected}`,
      {profilePath},
      {cause: error},
    );
  }
}

export function normalizeFormat(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function formatMatches(profile: RegulationProfile, value?: string): boolean {
  if (!value) return false;
  const normalized = normalizeFormat(value);
  return profile.acceptedFormats.some(
    (format) => normalizeFormat(format) === normalized,
  );
}
