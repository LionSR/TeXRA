import stripAnsi from 'strip-ansi';
import { z } from 'zod';

import {
  collapseWhitespace,
  stripControlCharacters,
} from '@utils/text/stringUtils';

import { QualifiedSkillNameSchema } from './skillName';

const ACTIVE_SKILL_DESCRIPTION_MAX_LENGTH = 180;
const ACTIVE_SKILL_DESCRIPTION_FALLBACK = 'Details available on activation.';
export const ACTIVE_SKILLS_SNAPSHOT_MAX_SKILLS = 200;

/** Canonical skill-source scope vocabulary, shared with the skills loader
 *  (`src/skills/loadSkills.ts`) so the loader and the persisted snapshot wire
 *  contract can't drift — a scope added here is representable everywhere. */
export const ActiveSkillSourceScopeSchema = z.enum([
  'bundled',
  'user',
  'project',
  'interop',
  'custom',
]);

export type ActiveSkillSourceScope = z.infer<
  typeof ActiveSkillSourceScopeSchema
>;

const ORDINARY_URL_VALUE = /\b(?!file:)[a-z][a-z0-9+.-]*:\/\/[^\s<>{}]+/gi;
const ORDINARY_SLASH_PROSE = /\binput\/output\b/gi;

function containsFilesystemShapedValue(description: string): boolean {
  if (description.includes('\\')) return true;

  const pathCandidates = description
    .replaceAll(ORDINARY_URL_VALUE, '')
    .replaceAll(ORDINARY_SLASH_PROSE, '');
  return pathCandidates.includes('/');
}

/**
 * Normalize untrusted frontmatter before it crosses the persistence boundary.
 * Owns path/ANSI sanitization and length truncation in one place so
 * transcript recorders parse raw skills without a parallel scrub.
 */
function sanitizeActiveSkillDescription(description: string): string {
  const normalized = collapseWhitespace(
    stripControlCharacters(stripAnsi(description), ' '),
  );
  const safeDescription =
    normalized && !containsFilesystemShapedValue(normalized)
      ? normalized
      : ACTIVE_SKILL_DESCRIPTION_FALLBACK;
  return safeDescription.slice(0, ACTIVE_SKILL_DESCRIPTION_MAX_LENGTH);
}

export const ActiveSkillSummarySchema = z.strictObject({
  name: QualifiedSkillNameSchema,
  description: z
    .string()
    .transform(sanitizeActiveSkillDescription)
    .pipe(z.string().min(1).max(ACTIVE_SKILL_DESCRIPTION_MAX_LENGTH)),
  source: ActiveSkillSourceScopeSchema,
});

/** Accepted runtime metadata before the transcript boundary sanitizes it. */
export type RawAcceptedSkill = Readonly<
  z.input<typeof ActiveSkillSummarySchema>
>;

/** Canonical payload persisted in the transcript and projected by hosts. */
export const ActiveSkillsSnapshotSchema = z.strictObject({
  skills: z
    .array(ActiveSkillSummarySchema)
    .max(ACTIVE_SKILLS_SNAPSHOT_MAX_SKILLS),
});
