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
