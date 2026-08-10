import { z } from 'zod';

import { collapseWhitespace } from '@utils/text/stringUtils';

import { SkillNameSchema } from './skillName';

const ACTIVE_SKILL_DESCRIPTION_MAX_LENGTH = 180;
const ACTIVE_SKILL_DESCRIPTION_FALLBACK = 'Details available on activation.';
export const ACTIVE_SKILLS_SNAPSHOT_MAX_SKILLS = 200;

const ActiveSkillSourceScopeSchema = z.enum([
  'bundled',
  'user',
  'project',
  'interop',
  'custom',
]);

const ANSI_ESCAPE_SEQUENCE =
  // eslint-disable-next-line no-control-regex -- untrusted summaries may contain terminal escapes
  /\u001b\][\s\S]*?(?:\u0007|\u001b\\|\u009c)|[\u001b\u009b][[\]()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]/g;
const ORDINARY_URL_VALUE = /\b(?!file:)[a-z][a-z0-9+.-]*:\/\/[^\s<>{}]+/gi;
const FILESYSTEM_SHAPED_VALUE =
  /(?:^|[^A-Za-z0-9_./\\-])(?:file:\/\/|[A-Za-z]:[\\/]|\\\\|~(?:[A-Za-z0-9._-]+)?[\\/]|\.\.?[\\/]|\/)/i;

function containsFilesystemShapedValue(description: string): boolean {
  const withoutOrdinaryUrls = description.replaceAll(ORDINARY_URL_VALUE, '');
  return FILESYSTEM_SHAPED_VALUE.test(withoutOrdinaryUrls);
}

/** Normalize untrusted frontmatter before it crosses the persistence boundary. */
function sanitizeActiveSkillDescription(description: string): string {
  const withoutAnsi = description.replaceAll(ANSI_ESCAPE_SEQUENCE, '');
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

/** Canonical payload used by the live event and its persisted transcript row. */
export const ActiveSkillsSnapshotSchema = z.strictObject({
  skills: z
    .array(ActiveSkillSummarySchema)
    .max(ACTIVE_SKILLS_SNAPSHOT_MAX_SKILLS),
});

export type ActiveSkillsSnapshot = z.infer<typeof ActiveSkillsSnapshotSchema>;
