import { z } from 'zod';

import { collapseWhitespace } from '@utils/text/stringUtils';

const SKILL_NAME_MAX_LENGTH = 64;

/** Canonical grammar for discovered and persisted skill names. */
export const SkillNameSchema = z
  .string()
  .transform((name) => collapseWhitespace(name))
  .refine((name) => name.length > 0, 'Skill name is required')
  .refine(
    (name) => name.length <= SKILL_NAME_MAX_LENGTH,
    `Skill name must be at most ${SKILL_NAME_MAX_LENGTH} characters`,
  )
  .refine(
    (name) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name),
    'Skill name must contain only lowercase letters, digits, and hyphens',
  )
  .refine(
    (name) => !name.includes('--'),
    'Skill name must not contain repeated hyphens',
  );

/**
 * A skill's name as the catalog, the switches and the transcript carry it:
 * a bare name, or `<plugin>:<name>` for a skill or command an installed
 * plugin contributes. A skill's own frontmatter takes the bare grammar only,
 * so no skill names itself into a plugin's namespace.
 */
export const QualifiedSkillNameSchema = z.string().refine((name) => {
  const parts = name.split(':');
  return (
    parts.length <= 2 &&
    parts.every((part) => SkillNameSchema.safeParse(part).data === part)
  );
}, 'Skill name must be a skill name, or <plugin>:<skill name>');
