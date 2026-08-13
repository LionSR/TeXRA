import { z } from 'zod';

import { redactSecrets } from '@logger/redaction';
import { collapseWhitespace } from '@utils/text/stringUtils';

import { SkillNameSchema } from './skillName';

const ACTIVE_SKILL_DESCRIPTION_MAX_LENGTH = 180;
const ACTIVE_SKILL_DESCRIPTION_FALLBACK = 'Details available on activation.';
export const ACTIVE_SKILLS_SNAPSHOT_MAX_SKILLS = 200;

/** Canonical skill-source scope vocabulary, shared with the skills loader
 *  (`src/skills/loadSkills.ts`) so the loader and the persisted snapshot wire
 *  contract can't drift — a scope added here is representable everywhere. */
const ActiveSkillSourceScopeSchema = z.enum([
  'bundled',
  'user',
  'project',
  'interop',
  'custom',
]);

export type ActiveSkillSourceScope = z.infer<
  typeof ActiveSkillSourceScopeSchema
>;

const ANSI_ESCAPE_SEQUENCE =
  // eslint-disable-next-line no-control-regex -- untrusted summaries may contain terminal escapes
  /\u001b\][\s\S]*?(?:\u0007|\u001b\\|\u009c)|[\u001b\u009b][[\]()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]/g;
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
 * Owns secret redaction, path/ANSI sanitization, and length truncation in one
 * place so transcript recorders parse raw skills without a parallel scrub.
 */
function sanitizeActiveSkillDescription(description: string): string {
  // Redact before path/ANSI scrub and truncation so long secret tokens are
  // replaced, not sliced mid-token into a still-sensitive prefix.
  const redacted = redactSecrets(description);
  const withoutAnsi = redacted.replaceAll(ANSI_ESCAPE_SEQUENCE, '');
  // eslint-disable-next-line no-control-regex -- persisted UI text excludes C0/C1 controls
  const withoutControls = withoutAnsi.replaceAll(/[\x00-\x1f\x7f-\x9f]/g, ' ');
  const normalized = collapseWhitespace(withoutControls).trim();
  const safeDescription =
    normalized && !containsFilesystemShapedValue(normalized)
      ? normalized
      : ACTIVE_SKILL_DESCRIPTION_FALLBACK;
  return safeDescription.slice(0, ACTIVE_SKILL_DESCRIPTION_MAX_LENGTH);
}

export const ActiveSkillSummarySchema = z.strictObject({
  name: SkillNameSchema,
  description: z
    .string()
    .transform(sanitizeActiveSkillDescription)
    .pipe(z.string().min(1).max(ACTIVE_SKILL_DESCRIPTION_MAX_LENGTH)),
  source: ActiveSkillSourceScopeSchema,
});

export type ActiveSkillSummary = z.infer<typeof ActiveSkillSummarySchema>;

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
